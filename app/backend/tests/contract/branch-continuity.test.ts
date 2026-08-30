import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CreateDocumentResponse, GetConversationResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, sleep, waitFor } from './test-app.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';

/**
 * Spec: specs/005-canvas-conversation-threads — NEW desired behavior for branch creation, not yet
 * implemented. Confirmed via reading conversation-service.ts's `branch()` (and its doc comment)
 * plus http.test.ts's own `branchAndSettle` helper/comment: today, every branch —
 * `selection`-anchored *and* the message-context "Branch this conversation" button alike — fires a
 * fire-and-forget seed message on its own brand-new session the instant it's created
 * (`buildBranchSeedMessage` when a `selection` was given, else a generic
 * `"This conversation was branched from \"<parent>\"."` line), recorded synchronously via
 * `ConversationService.send`'s `publishUserMessage` before any `await` is ever reached. There is
 * also no field anywhere in the domain model naming which specific parent message a branch forked
 * from — only `seedSelection` (a *document* character-range anchor) exists, and it's `null` for a
 * message-context branch entirely.
 *
 * This suite encodes three NEW requirements instead:
 *   1. A branch gains `forkedFromMessageId` — populated with the id of the parent's last message
 *      at the point of branching when the branch was created *from within a conversation* (no
 *      `selection` in the request), and `null` when created from a document selection (no message
 *      context).
 *   2. Branch creation never auto-sends any seed message — the new conversation starts as a truly
 *      empty placeholder (zero messages), for either creation path.
 *
 * Same black-box harness as http.test.ts (`createTestApp`: in-memory SQLite,
 * `RADR_BE_PI_FAKE_SESSIONS=1` so any agent turn that *did* fire would run deterministically rather
 * than requiring a live model).
 */

interface Ctx {
  app: FastifyInstance;
  storage: StorageAdapter;
}

/**
 * `ConversationDto` (contracts/http.ts) doesn't carry `forkedFromMessageId` yet — this local type
 * documents the shape these tests expect once a separate implementation pass adds it. Responses
 * are read as raw JSON (never round-tripped through `ConversationDto.parse`, which would silently
 * strip an as-yet-undeclared field) so the field's actual presence/absence is what these
 * assertions see.
 */
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

async function createDoc(app: FastifyInstance, storage: StorageAdapter, content: string): Promise<CreateDocumentResponse> {
  const res = await call(app, 'POST', '/api/document', { content });
  expect(res.status).toBe(201);
  const parsed = CreateDocumentResponse.parse(res.json);
  await waitFor(() => storage.getConversation(parsed.mainConversation.id)?.status === 'idle');
  return parsed;
}

/** Sends a real user message into `conversationId` and waits for the (fake) agent's reply to
 *  settle, so "the last message shown at the point of branching" is unambiguous — a message this
 *  test itself sent, not merely Main's own creation-time document-seed message. */
async function sendAndSettle(app: FastifyInstance, storage: StorageAdapter, conversationId: string, message: string): Promise<void> {
  const res = await call(app, 'POST', `/api/conversations/${conversationId}/send`, { message });
  expect(res.status).toBe(202);
  await waitFor(() => storage.getConversation(conversationId)?.status === 'idle');
}

async function getDetail(app: FastifyInstance, conversationId: string): Promise<GetConversationResponse> {
  const res = await call(app, 'GET', `/api/conversations/${conversationId}`);
  expect(res.status).toBe(200);
  return GetConversationResponse.parse(res.json);
}

describe('Branch creation: message-level fork anchor + no auto-sent seed message (canvas-conversation-threads, NEW behavior)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it("a branch created from within a conversation (no `selection`) records forkedFromMessageId as the id of the parent's last message at the point of branching", async () => {
    const created = await createDoc(ctx.app, ctx.storage, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    await sendAndSettle(ctx.app, ctx.storage, mainId, 'What do you make of this document?');
    const mainDetailBeforeBranch = await getDetail(ctx.app, mainId);
    const lastParentMessageId = mainDetailBeforeBranch.messages.at(-1)?.id;
    expect(lastParentMessageId).toBeTruthy();

    const branchRes = await call(ctx.app, 'POST', '/api/conversations', { parentConversationId: mainId });
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;

    expect(branchDto.forkedFromMessageId).toBe(lastParentMessageId);
  });

  it('a branch created from a document selection (no message context) records forkedFromMessageId as null, even though the parent has real message history', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx.app, ctx.storage, content);
    const mainId = created.mainConversation.id;

    // The parent has genuine history — proves a naive "always use the parent's last message"
    // implementation would wrongly populate this field here too.
    await sendAndSettle(ctx.app, ctx.storage, mainId, 'Some unrelated question first.');

    const from = created.content.indexOf('Highlight this passage');
    expect(from).toBeGreaterThanOrEqual(0);
    const branchRes = await call(ctx.app, 'POST', '/api/conversations', {
      parentConversationId: mainId,
      selection: { from, to: from + 'Highlight this passage'.length },
    });
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;

    expect(branchDto.forkedFromMessageId).toBeNull();
  });

  it('a branch created from within a conversation starts as a truly empty placeholder — zero messages, no auto-sent seed comment', async () => {
    const created = await createDoc(ctx.app, ctx.storage, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    const branchRes = await call(ctx.app, 'POST', '/api/conversations', { parentConversationId: mainId });
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    // No wait/poll here on purpose: the requirement is that nothing is ever queued to send a seed
    // message in the first place, so the branch's own message list must already be empty the
    // instant it exists. Today's `branch()` fails this immediately (not via a timeout) because its
    // seed message is recorded synchronously, before `branch()` even returns (see the suite's doc
    // comment above).
    const detail = await getDetail(ctx.app, branchId);
    expect(detail.messages).toEqual([]);
  });

  it('a branch created from a document selection also starts as a truly empty placeholder — zero messages, no auto-sent seed comment', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx.app, ctx.storage, content);
    const mainId = created.mainConversation.id;

    const from = created.content.indexOf('Highlight this passage');
    const branchRes = await call(ctx.app, 'POST', '/api/conversations', {
      parentConversationId: mainId,
      selection: { from, to: from + 'Highlight this passage'.length },
    });
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;

    const detail = await getDetail(ctx.app, branchId);
    expect(detail.messages).toEqual([]);
  });

  it('never starts an agent turn for a freshly-created branch, even after a short settle window', async () => {
    const created = await createDoc(ctx.app, ctx.storage, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;

    const branchRes = await call(ctx.app, 'POST', '/api/conversations', { parentConversationId: mainId });
    const branchId = (branchRes.json as { id: string }).id;

    // Generous settle window for a fire-and-forget seed turn, if one were (wrongly) still fired —
    // mirrors http.test.ts's own `branchAndSettle` wait, just asserting the opposite outcome.
    await sleep(200);

    expect(ctx.storage.getConversation(branchId)?.status).toBe('idle');
    const detail = await getDetail(ctx.app, branchId);
    expect(detail.messages).toEqual([]);
  });
});

/**
 * `includeSeedMessage` (005-canvas-conversation-threads): originally opted a selection-anchored
 * branch back into the pre-canvas behavior of delivering `buildBranchSeedMessage`'s excerpt as the
 * branch's first message. User-confirmed decision superseded that: the flag no longer resends
 * anything as a chat message — instead it populates `forkedFromMessageId` with the parent's last
 * message id, same as the message-context "Branch this conversation" path always does, so the
 * branch's continuity-snippet UI (`ConversationThreadBox.vue`'s `continuityMessages`) renders the
 * parent's last exchange. `includeSeedMessage: false`/omitted on a selection-anchored branch keeps
 * `forkedFromMessageId` null — the clean/empty placeholder fork with no continuity ("Branch
 * (New)"). Every branch, regardless of this flag, still never auto-sends a seed message (the
 * suite above covers that generally).
 */
describe('Branch creation: includeSeedMessage now opts a selection-anchored branch into continuity, not a seed message', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it("includeSeedMessage: true on a selection-anchored branch populates forkedFromMessageId with the parent's last message id, and sends no seed message", async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx.app, ctx.storage, content);
    const mainId = created.mainConversation.id;

    await sendAndSettle(ctx.app, ctx.storage, mainId, 'Some context-setting question first.');
    const mainDetailBeforeBranch = await getDetail(ctx.app, mainId);
    const lastParentMessageId = mainDetailBeforeBranch.messages.at(-1)?.id;
    expect(lastParentMessageId).toBeTruthy();

    const from = created.content.indexOf('Highlight this passage');
    const branchRes = await call(ctx.app, 'POST', '/api/conversations', {
      parentConversationId: mainId,
      selection: { from, to: from + 'Highlight this passage'.length },
      includeSeedMessage: true,
    });
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;
    expect(branchDto.forkedFromMessageId).toBe(lastParentMessageId);

    // No seed message: `publishUserMessage` would have run synchronously before any `await` (as it
    // did pre-decision), so the absence is already observable without a wait/poll.
    const detail = await getDetail(ctx.app, branchDto.id);
    expect(detail.messages).toEqual([]);
  });

  it('includeSeedMessage: false on a selection-anchored branch keeps forkedFromMessageId null and starts as a truly empty placeholder (explicit false, not just omitted)', async () => {
    const content = '# Doc\n\nHighlight this passage please, it matters.';
    const created = await createDoc(ctx.app, ctx.storage, content);
    const mainId = created.mainConversation.id;

    const from = created.content.indexOf('Highlight this passage');
    const branchRes = await call(ctx.app, 'POST', '/api/conversations', {
      parentConversationId: mainId,
      selection: { from, to: from + 'Highlight this passage'.length },
      includeSeedMessage: false,
    });
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;
    expect(branchDto.forkedFromMessageId).toBeNull();

    const detail = await getDetail(ctx.app, branchDto.id);
    expect(detail.messages).toEqual([]);
  });

  it('includeSeedMessage: true without a selection (message-context branch) changes nothing — forkedFromMessageId is already populated on that path regardless of the flag', async () => {
    const created = await createDoc(ctx.app, ctx.storage, '# Doc\n\nSome content to review.');
    const mainId = created.mainConversation.id;
    const mainDetailBeforeBranch = await getDetail(ctx.app, mainId);
    const lastParentMessageId = mainDetailBeforeBranch.messages.at(-1)?.id;
    expect(lastParentMessageId).toBeTruthy();

    const branchRes = await call(ctx.app, 'POST', '/api/conversations', {
      parentConversationId: mainId,
      includeSeedMessage: true,
    });
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as ConversationDtoWithFork;
    expect(branchDto.forkedFromMessageId).toBe(lastParentMessageId);

    await sleep(200);
    const detail = await getDetail(ctx.app, branchDto.id);
    expect(detail.messages).toEqual([]);
  });
});
