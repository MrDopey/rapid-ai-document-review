import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentResponse,
  GetConversationResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, sleep, waitFor } from './test-app.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { PiService } from '../../src/pi/pi-service.js';
import type { FakeAgentSession } from '../../src/pi/fake-agent-session.js';

/**
 * Spec: specs/005-canvas-conversation-threads, branch seed-message rework. Three branch-creation
 * paths, each with its own seed-message/continuity shape (`ConversationService.branch`,
 * seed-excerpt.ts):
 *
 *  - "Branch (New)" (`selection` given, `includeSeedMessage` omitted/false): auto-sends a seed
 *    message with BOTH the full document (`<document-revision-N>`) and the highlighted selection
 *    (`<highlighted-selection>`) — `buildBranchSeedMessage`. `forkedFromMessageId` stays `null`:
 *    not a fork, no continuity snippet.
 *  - "Branch (Main)" (`selection` given, `includeSeedMessage: true`): auto-sends a seed message
 *    with ONLY the highlighted selection, no document — `buildSelectionOnlySeedMessage`.
 *    `forkedFromMessageId` is populated with the parent's last message id: continuity snippet
 *    renders, so the document doesn't need to be resent.
 *  - Sidebar "Branch this conversation" (no `selection`): no seed message at all.
 *    `forkedFromMessageId` is populated (same as Branch (Main)): continuity snippet renders.
 *
 * Every seed message is delivered fire-and-forget through the ordinary `send()` path, marked
 * `isSeed: true`. That flag does double duty:
 *  - `discardIfEmpty`'s "empty" check ignores it, so an auto-injected seed must never by itself
 *    prevent an otherwise-untouched branch from being discarded — only a message the *user*
 *    actually sends keeps the branch alive.
 *  - `send()` itself skips triggering any agent turn for it (branches are transient/inert until
 *    the user sends their own first message): the seed is stored as context only, so a freshly
 *    created branch never fires a request on its own and its status never leaves `idle`.
 *
 * Same black-box harness as http.test.ts (`createTestApp`: in-memory SQLite,
 * `RADR_BE_PI_FAKE_SESSIONS=1` for the non-seed sends this file does make, via `sendAndSettle`).
 */

interface Ctx {
  app: FastifyInstance;
  storage: StorageAdapter;
  piService: PiService;
  documentId?: string;
}

/** `ConversationDto` carries `forkedFromMessageId`; this local type just narrows the raw JSON
 *  response for direct assertions without round-tripping every field through `ConversationDto.parse`. */
interface ConversationDtoWithFork {
  id: string;
  parentId: string | null;
  branchDepth: number;
  forkedFromMessageId?: string | null;
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method, url, payload: payload as never });
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json };
}

async function createDoc(ctx: Ctx, content: string): Promise<CreateDocumentResponse> {
  const res = await call(ctx.app, 'POST', '/api/documents', { content });
  expect(res.status).toBe(201);
  const parsed = CreateDocumentResponse.parse(res.json);
  ctx.documentId = parsed.document.id;
  await waitFor(() => ctx.storage.getConversation(parsed.mainConversation.id)?.status === 'idle');
  return parsed;
}

/** Sends a real user message into `conversationId` and waits for the (fake) agent's reply to
 *  settle, so "the last message shown at the point of branching" is unambiguous — a message this
 *  test itself sent, not merely Main's own creation-time document-seed message. */
async function sendAndSettle(ctx: Ctx, conversationId: string, message: string): Promise<void> {
  const res = await call(
    ctx.app,
    'POST',
    `/api/documents/${ctx.documentId}/conversations/${conversationId}/send`,
    { message },
  );
  expect(res.status).toBe(202);
  await waitFor(() => ctx.storage.getConversation(conversationId)?.status === 'idle');
}

async function getDetail(ctx: Ctx, conversationId: string): Promise<GetConversationResponse> {
  const res = await call(
    ctx.app,
    'GET',
    `/api/documents/${ctx.documentId}/conversations/${conversationId}`,
  );
  expect(res.status).toBe(200);
  return GetConversationResponse.parse(res.json);
}

/** A seed message never triggers an agent turn (see the file-level doc comment above), so a
 *  freshly created branch's status is already `idle` by the time `branch()`'s HTTP response
 *  returns — this is a no-op settle wait, kept only so call sites read the same as
 *  http.test.ts's `branchAndSettle` and stay correct if that ever changes. */
async function waitForBranchSettle(storage: StorageAdapter, conversationId: string): Promise<void> {
  await waitFor(() => storage.getConversation(conversationId)?.status === 'idle');
}

describe('Branch creation: message-level fork anchor (forkedFromMessageId)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it("sidebar branch (no `selection`) records forkedFromMessageId as the id of the parent's last message, and sends no seed message", async () => {
    const created = await createDoc(ctx, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    await sendAndSettle(ctx, mainId, 'What do you make of this document?');
    const mainDetailBeforeBranch = await getDetail(ctx, mainId);
    const lastParentMessageId = mainDetailBeforeBranch.messages.at(-1)?.id;
    expect(lastParentMessageId).toBeTruthy();

    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
      },
    );
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;

    expect(branchDto.forkedFromMessageId).toBe(lastParentMessageId);

    // No seed message: nothing was ever queued to send, so this is already true without a wait —
    // generous settle window included anyway to prove no turn was fired at all.
    await sleep(200);
    expect(ctx.storage.getConversation(branchDto.id)?.status).toBe('idle');
    const detail = await getDetail(ctx, branchDto.id);
    expect(detail.messages).toEqual([]);
  });

  it('"Branch (New)" (selection, no includeSeedMessage) records forkedFromMessageId as null, even though the parent has real message history', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    // The parent has genuine history — proves a naive "always use the parent's last message"
    // implementation would wrongly populate this field here too.
    await sendAndSettle(ctx, mainId, 'Some unrelated question first.');

    const from = created.content.indexOf('Highlight this passage');
    expect(from).toBeGreaterThanOrEqual(0);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + 'Highlight this passage'.length },
      },
    );
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;

    expect(branchDto.forkedFromMessageId).toBeNull();
  });

  it('"Branch (Main)" (selection + includeSeedMessage: true) records forkedFromMessageId as the parent\'s last message id', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    await sendAndSettle(ctx, mainId, 'Some context-setting question first.');
    const mainDetailBeforeBranch = await getDetail(ctx, mainId);
    const lastParentMessageId = mainDetailBeforeBranch.messages.at(-1)?.id;
    expect(lastParentMessageId).toBeTruthy();

    const from = created.content.indexOf('Highlight this passage');
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + 'Highlight this passage'.length },
        includeSeedMessage: true,
      },
    );
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;

    expect(branchDto.forkedFromMessageId).toBe(lastParentMessageId);
  });
});

describe('Branch creation: seed message content per path', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it('"Branch (New)" seeds the branch with BOTH the full document and the highlighted selection, XML-wrapped', async () => {
    const content =
      '# Doc\n\nHighlight this passage please, it matters.\n\nSome trailing content, unrelated.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
      },
    );
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    await waitForBranchSettle(ctx.storage, branchId);
    const detail = await getDetail(ctx, branchId);

    // First message is the auto-seed, sent as if from the user.
    const seed = detail.messages[0];
    expect(seed?.role).toBe('user');
    expect(seed?.text).toContain('<document-revision-1>');
    expect(seed?.text).toContain(content);
    expect(seed?.text).toContain('</document-revision-1>');
    expect(seed?.text).toContain('<highlighted-selection>');
    expect(seed?.text).toContain(selectionText);
    expect(seed?.text).toContain('</highlighted-selection>');

    // The seed message never triggers an agent turn (bug fix: branches are transient/inert until
    // the user sends their own first message), so this is exactly the one auto-seed message —
    // not something the *user* sent (covered by the discard-rule suite below).
    expect(detail.messages.length).toBe(1);
  });

  it('"Branch (Main)" seeds the branch with ONLY the highlighted selection — no full document', async () => {
    const content =
      '# Doc\n\nHighlight this passage please, it matters.\n\nSome trailing content, unrelated.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    await sendAndSettle(ctx, mainId, 'Some context-setting question first.');

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
        includeSeedMessage: true,
      },
    );
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    await waitForBranchSettle(ctx.storage, branchId);
    const detail = await getDetail(ctx, branchId);

    const seed = detail.messages[0];
    expect(seed?.role).toBe('user');
    expect(seed?.text).toContain('<highlighted-selection>');
    expect(seed?.text).toContain(selectionText);
    expect(seed?.text).toContain('</highlighted-selection>');
    // No full-document tag or raw document content this time — the continuity snippet already
    // supplies prior context.
    expect(seed?.text).not.toContain('<document-revision-');
    expect(seed?.text).not.toContain('Some trailing content, unrelated.');
  });

  it('sidebar branch (no selection) never sends a seed message, even after a settle window', async () => {
    const created = await createDoc(ctx, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
      },
    );
    const branchId = (branchRes.json as { id: string }).id;

    await sleep(200);

    expect(ctx.storage.getConversation(branchId)?.status).toBe('idle');
    const detail = await getDetail(ctx, branchId);
    expect(detail.messages).toEqual([]);
  });
});

/** Polls until `PiService`'s cached (fake) session for `conversationId` exists AND has recorded at
 *  least one seeded entry — the seed is delivered by `ConversationService.send()`'s `isSeed`
 *  branch awaiting `piService.seedSession(...)`, but the caller (`sendBranchSeedMessage`/
 *  `seedMain`) is itself fire-and-forget, so the HTTP response that triggered it can return before
 *  that completes. */
async function waitForSeededSession(
  piService: PiService,
  conversationId: string,
): Promise<FakeAgentSession> {
  await waitFor(
    () => {
      const session = piService.getSessionForTesting(conversationId) as
        FakeAgentSession | undefined;
      return (session?.getSeededHistory().length ?? 0) > 0;
    },
    { message: `expected a seeded Pi session for conversation ${conversationId}` },
  );
  return piService.getSessionForTesting(conversationId) as FakeAgentSession;
}

describe("Branch creation: the seed message reaches the underlying Pi session's own context, not just the app event log", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it('"Branch (New)" eagerly creates the branch\'s Pi session and seeds it with the full document + selection, without starting a turn', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
      },
    );
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    const session = await waitForSeededSession(ctx.piService, branchId);
    const seeded = session.getSeededHistory();

    // Reached the session's own context — the actual gap this test guards against: previously
    // the seed only ever landed in the app's own event log, never in the Pi session at all. The
    // seed's exact content shape (document-revision/highlighted-selection tags) is already
    // asserted at the HTTP/app-event-log level by "seed message content per path" above, so this
    // only re-checks what that level cannot see: that the session itself has exactly one seeded
    // entry, and that seeding never triggers a turn.
    expect(seeded).toHaveLength(1);
    expect(session.isStreaming).toBe(false);
  });

  it('"Branch (Main)" (selection only, includeSeedMessage: true) also seeds the underlying Pi session, without starting a turn', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    await sendAndSettle(ctx, mainId, 'Some context-setting question first.');

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
        includeSeedMessage: true,
      },
    );
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    const session = await waitForSeededSession(ctx.piService, branchId);
    const seeded = session.getSeededHistory();

    // Same rationale as the previous test: content shape is already covered above; this only
    // adds the session-level facts that block can't see.
    expect(seeded).toHaveLength(1);
    expect(session.isStreaming).toBe(false);
  });

  it('a sidebar branch (no selection, no seed message) never creates a Pi session at all until the user sends a real message', async () => {
    const created = await createDoc(ctx, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
      },
    );
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    // Generous settle window: nothing was ever queued to seed a session for, so this should stay
    // true well before any timeout would matter.
    await sleep(200);
    expect(ctx.piService.getSessionForTesting(branchId)).toBeUndefined();
  });

  it("the branch's own real turn still works normally once the user replies after the seed", async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
      },
    );
    const branchId = (branchRes.json as { id: string }).id;

    await waitForSeededSession(ctx.piService, branchId);

    await sendAndSettle(ctx, branchId, 'Please tighten this passage up.');

    const detail = await getDetail(ctx, branchId);
    // seed (user, isSeed) + the user's real message + the assistant's reply.
    expect(detail.messages.length).toBe(3);
    expect(detail.messages[1]?.role).toBe('user');
    expect(detail.messages[2]?.role).toBe('assistant');
  });
});

describe("Document creation: Main's own creation-time seed message never triggers a turn", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it('creating a document seeds the Pi session with the document content, without starting a turn', async () => {
    const content = '# Doc\n\nSome content to review.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const session = await waitForSeededSession(ctx.piService, mainId);
    const seeded = session.getSeededHistory();

    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toContain('<document-revision-1>');
    expect(seeded[0]).toContain(content);

    // No turn was ever triggered by it: the fake session never entered a streaming turn, and Main
    // stays idle with no assistant reply, rather than a live agent call firing on every "+ New
    // document".
    expect(session.isStreaming).toBe(false);
    expect(ctx.storage.getConversation(mainId)?.status).toBe('idle');
    const detail = await getDetail(ctx, mainId);
    expect(detail.messages.length).toBe(1);
    expect(detail.messages[0]?.role).toBe('user');
  });
});

describe('Empty-branch auto-discard: an auto-sent seed message does not count as user activity', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it('a "Branch (New)" branch with only its auto-seed message still discards as empty', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
      },
    );
    const branchId = (branchRes.json as { id: string }).id;
    await waitForBranchSettle(ctx.storage, branchId);

    // Sanity: the seed message really is present (stored, even though it never triggered an
    // agent turn) — proving the discard below is exercising the *new* "no user message" rule,
    // not the old "zero messages" one.
    const detail = await getDetail(ctx, branchId);
    expect(detail.messages.length).toBe(1);

    const discardRes = await call(
      ctx.app,
      'DELETE',
      `/api/documents/${ctx.documentId}/conversations/${branchId}`,
    );
    expect(discardRes.status).toBe(200);
    expect(ctx.storage.getConversation(branchId)).toBeNull();
  });

  it('a "Branch (Main)" branch with only its auto-seed message still discards as empty', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
        includeSeedMessage: true,
      },
    );
    const branchId = (branchRes.json as { id: string }).id;
    await waitForBranchSettle(ctx.storage, branchId);

    const discardRes = await call(
      ctx.app,
      'DELETE',
      `/api/documents/${ctx.documentId}/conversations/${branchId}`,
    );
    expect(discardRes.status).toBe(200);
    expect(ctx.storage.getConversation(branchId)).toBeNull();
  });

  it('a "Branch (New)" branch survives discard once the user sends their own message after the seed', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx, content);
    const mainId = created.mainConversation.id;

    const selectionText = 'Highlight this passage please, it matters.';
    const from = created.content.indexOf(selectionText);
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
        selection: { from, to: from + selectionText.length },
      },
    );
    const branchId = (branchRes.json as { id: string }).id;
    await waitForBranchSettle(ctx.storage, branchId);

    await sendAndSettle(ctx, branchId, 'Please tighten this passage up.');

    const discardRes = await call(
      ctx.app,
      'DELETE',
      `/api/documents/${ctx.documentId}/conversations/${branchId}`,
    );
    expect(discardRes.status).toBe(409);
    expect(ctx.storage.getConversation(branchId)).not.toBeNull();
  });

  it('a sidebar branch (no seed at all) still discards as empty with zero messages', async () => {
    const created = await createDoc(ctx, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/conversations`,
      {
        parentConversationId: mainId,
      },
    );
    const branchId = (branchRes.json as { id: string }).id;

    const discardRes = await call(
      ctx.app,
      'DELETE',
      `/api/documents/${ctx.documentId}/conversations/${branchId}`,
    );
    expect(discardRes.status).toBe(200);
    expect(ctx.storage.getConversation(branchId)).toBeNull();
  });
});
