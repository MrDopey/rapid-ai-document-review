import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  CreateDocumentResponse,
  ExportThreadSessionResponse,
  GetConversationResponse,
  ListConversationsResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, waitFor } from './test-app.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { PiService } from '../../src/pi/pi-service.js';

/**
 * 011-linear-thread-mode: User Stories 1-3 (root-thread creation, highlight-to-branch, done/reopen).
 * Same black-box harness as branch-continuity.test.ts (`createTestApp`: in-memory SQLite,
 * `RADR_BE_PI_FAKE_SESSIONS=1`).
 */

interface Ctx {
  app: FastifyInstance;
  storage: StorageAdapter;
  piService: PiService;
  documentId?: string;
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

async function createThreadDoc(ctx: Ctx, content: string): Promise<CreateDocumentResponse> {
  const res = await call(ctx.app, 'POST', '/api/documents', { content, documentType: 'thread' });
  expect(res.status).toBe(201);
  const parsed = CreateDocumentResponse.parse(res.json);
  ctx.documentId = parsed.document.id;
  return parsed;
}

async function createCanvasDoc(ctx: Ctx, content: string): Promise<CreateDocumentResponse> {
  const res = await call(ctx.app, 'POST', '/api/documents', { content });
  expect(res.status).toBe(201);
  return CreateDocumentResponse.parse(res.json);
}

async function sendOnThread(ctx: Ctx, threadId: string, message: string): Promise<void> {
  const res = await call(
    ctx.app,
    'POST',
    `/api/documents/${ctx.documentId}/threads/${threadId}/send`,
    { message },
  );
  expect(res.status).toBe(202);
  await waitFor(() => ctx.storage.getConversation(threadId)?.status === 'idle');
}

async function getThreadMessages(ctx: Ctx, threadId: string): Promise<GetConversationResponse> {
  const res = await call(
    ctx.app,
    'GET',
    `/api/documents/${ctx.documentId}/threads/${threadId}/messages`,
  );
  expect(res.status).toBe(200);
  return GetConversationResponse.parse(res.json);
}

async function listThreads(ctx: Ctx): Promise<ListConversationsResponse> {
  const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/threads`);
  expect(res.status).toBe(200);
  return ListConversationsResponse.parse(res.json);
}

describe('User Story 1: a threaded-conversation document gets exactly one auto-created root thread', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it('creates a documentType: thread document with exactly one thread-root conversation', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nSome content.');

    expect(created.document.documentType).toBe('thread');
    expect(created.mainConversation.kind).toBe('thread-root');

    const rootId = created.mainConversation.id;
    const row = ctx.storage.getConversation(rootId);
    expect(row?.kind).toBe('thread-root');
    expect(row?.parentId).toBeNull();
    expect(row?.piLeafEntryId).toBeNull();
    expect(row?.doneAt).toBeNull();
    expect(row?.seedExcerptText).toBeNull();

    const allConversations = ctx.storage.listAllConversations(ctx.documentId!);
    expect(allConversations.filter((c) => c.kind === 'thread-root')).toHaveLength(1);

    const threads = await listThreads(ctx);
    expect(threads.conversations).toHaveLength(1);
    expect(threads.conversations[0]?.id).toBe(rootId);
  });

  it('sending a message on the root thread appends normally', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nSome content.');
    const rootId = created.mainConversation.id;

    await sendOnThread(ctx, rootId, 'Hello, root thread.');

    const detail = await getThreadMessages(ctx, rootId);
    expect(detail.messages.length).toBe(2);
    expect(detail.messages[0]?.role).toBe('user');
    expect(detail.messages[0]?.text).toBe('Hello, root thread.');
    expect(detail.messages[1]?.role).toBe('assistant');
  });
});

describe('User Story 1: a document type is fixed at creation and its two conversation surfaces never mix', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it('refuses POST .../conversations (canvas branch route) against a documentType: thread document', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const res = await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/conversations`, {
      parentConversationId: created.mainConversation.id,
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('DOCUMENT_WRONG_TYPE');
  });

  it('refuses POST .../threads/:id/send against a documentType: canvas document', async () => {
    const created = await createCanvasDoc(ctx, '# Canvas doc\n\nContent.');
    const res = await call(
      ctx.app,
      'POST',
      `/api/documents/${created.document.id}/threads/${created.mainConversation.id}/send`,
      { message: 'hi' },
    );
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('DOCUMENT_WRONG_TYPE');
  });
});

describe('User Story 2: highlight-to-branch is a genuine same-session Pi branch', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  it("branches from an earlier message, sharing the parent's session file and seeding the excerpt", async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;

    await sendOnThread(ctx, rootId, 'First message from the reviewer.');
    await sendOnThread(ctx, rootId, 'Second message, the one we will branch from.');
    await sendOnThread(ctx, rootId, 'Third message, the current tip.');

    const beforeBranch = await getThreadMessages(ctx, rootId);
    // u1, a1, u2, a2, u3, a3
    expect(beforeBranch.messages.length).toBe(6);
    const anchor = beforeBranch.messages[2]!;
    expect(anchor.role).toBe('user');
    expect(anchor.text).toBe('Second message, the one we will branch from.');
    const tip = beforeBranch.messages.at(-1)!;

    const highlightedText = 'the one we will branch from';
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText },
    );
    expect(branchRes.status).toBe(201);
    const branchDto = branchRes.json as {
      id: string;
      kind: string;
      parentId: string | null;
      forkedFromMessageId: string | null;
      seedExcerptText: string | null;
    };
    expect(branchDto.kind).toBe('thread-branch');
    expect(branchDto.parentId).toBe(rootId);
    expect(branchDto.forkedFromMessageId).toBe(anchor.id);
    expect(branchDto.seedExcerptText).toBe(highlightedText);

    const rootRow = ctx.storage.getConversation(rootId)!;
    const branchRow = ctx.storage.getConversation(branchDto.id)!;
    expect(branchRow.piSessionPath).toBe(rootRow.piSessionPath);
    expect(branchRow.piLeafEntryId).toBeTruthy();
    expect(branchRow.piLeafEntryId).not.toBe(rootRow.piLeafEntryId);

    // The seed lands as the branch's own first message (fire-and-forget from branchFromHighlight).
    await waitFor(async () => (await getThreadMessages(ctx, branchDto.id)).messages.length >= 1);
    const branchDetail = await getThreadMessages(ctx, branchDto.id);
    expect(branchDetail.messages[0]?.role).toBe('user');
    expect(branchDetail.messages[0]?.text).toContain('<branch-seed-excerpt>');
    expect(branchDetail.messages[0]?.text).toContain(highlightedText);

    // Genuine shared-session branch (research.md R1): both threads' leaf entries live in the SAME
    // on-disk Pi session tree, not two independent single-root trees.
    const sm = SessionManager.open(rootRow.piSessionPath);
    const entryIds = new Set(sm.getEntries().map((e) => e.id));
    expect(entryIds.has(rootRow.piLeafEntryId!)).toBe(true);
    expect(entryIds.has(branchRow.piLeafEntryId!)).toBe(true);

    // Highlighting the tip is refused (FR-007) — checked before root sends anything further, while
    // `tip` (messages[5], "Third message, the current tip.") is still genuinely the current tip.
    const tipBranchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: tip.id, highlightedText: tip.text.slice(0, 3) },
    );
    expect(tipBranchRes.status).toBe(409);
    expect((tipBranchRes.json as { error: { code: string } }).error.code).toBe('ANCHOR_IS_TIP');

    // A highlight that isn't actually in the anchor message is refused (FR-005a validation).
    const invalidRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: 'text that was never said' },
    );
    expect(invalidRes.status).toBe(400);
    expect((invalidRes.json as { error: { code: string } }).error.code).toBe('INVALID_HIGHLIGHT');

    // Sending in the root afterward and in the branch are independent (different leaves).
    await sendOnThread(ctx, rootId, 'Root continues independently.');
    const branchDetailAfter = await getThreadMessages(ctx, branchDto.id);
    expect(branchDetailAfter.messages.some((m) => m.text === 'Root continues independently.')).toBe(
      false,
    );
  });

  it('two branches from the same message render as siblings, each with its own seed excerpt', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;
    await sendOnThread(ctx, rootId, 'A message with two branchable phrases: alpha and beta.');
    const detail = await getThreadMessages(ctx, rootId);
    const anchor = detail.messages[0]!;

    const branchA = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: 'alpha' },
    );
    const branchB = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: 'beta' },
    );
    expect(branchA.status).toBe(201);
    expect(branchB.status).toBe(201);
    const a = branchA.json as { id: string; forkedFromMessageId: string; seedExcerptText: string };
    const b = branchB.json as { id: string; forkedFromMessageId: string; seedExcerptText: string };
    expect(a.forkedFromMessageId).toBe(anchor.id);
    expect(b.forkedFromMessageId).toBe(anchor.id);
    expect(a.seedExcerptText).toBe('alpha');
    expect(b.seedExcerptText).toBe('beta');

    const threads = await listThreads(ctx);
    expect(threads.conversations.map((c) => c.id)).toEqual(
      expect.arrayContaining([rootId, a.id, b.id]),
    );
  });
});

describe('User Story 3: marking a thread done declutters without deleting', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  async function branchFrom(ctx: Ctx, threadId: string, message: string): Promise<string> {
    await sendOnThread(ctx, threadId, message);
    const detail = await getThreadMessages(ctx, threadId);
    const anchor = detail.messages[0]!;
    const res = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${threadId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: message.slice(0, 5) },
    );
    expect(res.status).toBe(201);
    return (res.json as { id: string }).id;
  }

  it('marks a thread done, then reopens it — reversible and non-destructive', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;
    const branchId = await branchFrom(ctx, rootId, 'Branch me please for this scenario.');

    const doneRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${branchId}/done`,
      {},
    );
    expect(doneRes.status).toBe(200);
    expect((doneRes.json as { doneAt: string }).doneAt).toBeTruthy();
    expect(ctx.storage.getConversation(branchId)?.doneAt).toBeTruthy();

    // Non-destructive: still fully present with its history intact.
    const threadsAfterDone = await listThreads(ctx);
    const doneEntry = threadsAfterDone.conversations.find((c) => c.id === branchId);
    expect(doneEntry?.doneAt).toBeTruthy();
    const detail = await getThreadMessages(ctx, branchId);
    expect(detail.messages.length).toBeGreaterThan(0);

    const reopenRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${branchId}/reopen`,
      {},
    );
    expect(reopenRes.status).toBe(200);
    expect((reopenRes.json as { doneAt: null }).doneAt).toBeNull();
    expect(ctx.storage.getConversation(branchId)?.doneAt).toBeNull();
  });

  it('refuses to mark a thread done while it has an unresolved staged edit, and still allows branching from a done thread', async () => {
    const created = await createThreadDoc(ctx, '# Doc\n\nOriginal sentence to edit.');
    const rootId = created.mainConversation.id;

    // `propose_document_edit` is unavailable in a Thread (011-linear-thread-mode: a Thread has no
    // document-offset context to edit — see `PiService.buildTools`), so a pending staged edit can
    // no longer be produced via the live tool the way canvas-mode tests do. `markDone`'s guard
    // (`getPendingStagedEditIds`, shared with `ConversationService.close()`) is otherwise identical
    // regardless of how a staged edit came to exist, so this synthesizes one directly through
    // storage to exercise that shared guard.
    ctx.storage.createStagedEdit({
      id: 'staged-thread-test',
      documentId: ctx.documentId!,
      conversationId: rootId,
      piToolCallId: 'tool-call-thread-test',
      sourceRevision: created.document.currentRevision,
      summary: 'Tweak the sentence',
      operations: [{ old_string: 'Original sentence to edit.', new_string: 'Edited sentence.' }],
      status: 'pending',
      autoApplied: false,
      appliedRevision: null,
      supersedesId: null,
      conflictDetail: null,
      replacementAttempt: 0,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    const blockedRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/done`,
      {},
    );
    expect(blockedRes.status).toBe(409);
    expect((blockedRes.json as { error: { code: string } }).error.code).toBe(
      'PENDING_EDITS_BLOCK_DONE',
    );

    // Branching from a done thread still succeeds (Edge Cases) — done here without a pending edit,
    // to isolate "done thread" from "thread with a pending edit" as two independent conditions.
    const otherRoot = await createThreadDoc(ctx, '# Other\n\nBranch me while done.');
    const otherRootId = otherRoot.mainConversation.id;
    await sendOnThread(ctx, otherRootId, 'Branch me while done.');
    await call(
      ctx.app,
      'POST',
      `/api/documents/${otherRoot.document.id}/threads/${otherRootId}/done`,
      {},
    );
    const otherCtx: Ctx = { ...ctx, documentId: otherRoot.document.id };
    const detail = await getThreadMessages(otherCtx, otherRootId);
    const anchor = detail.messages[0]!;
    const branchWhileDoneRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${otherRoot.document.id}/threads/${otherRootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: 'Branch' },
    );
    expect(branchWhileDoneRes.status).toBe(201);
  });

  it('marking a root thread done leaves its still-active branches visible', async () => {
    const created = await createThreadDoc(ctx, '# Doc\n\nContent for branching.');
    const rootId = created.mainConversation.id;
    const branchId = await branchFrom(ctx, rootId, 'Content for branching purposes here.');

    const doneRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/done`,
      {},
    );
    expect(doneRes.status).toBe(200);

    const threads = await listThreads(ctx);
    const rootEntry = threads.conversations.find((c) => c.id === rootId);
    const branchEntry = threads.conversations.find((c) => c.id === branchId);
    expect(rootEntry?.doneAt).toBeTruthy();
    expect(branchEntry?.doneAt).toBeNull();
  });
});

describe('User Story 4: a genuine Pi-native session export renders in the browser', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  async function exportThread(threadId: string): Promise<{ status: number; json: unknown }> {
    return call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/threads/${threadId}/export`);
  }

  it('exports a thread with message history as genuine Pi session JSONL matching its actual messages', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;
    await sendOnThread(ctx, rootId, 'First exported message.');
    await sendOnThread(ctx, rootId, 'Second exported message.');

    const liveDetail = await getThreadMessages(ctx, rootId);

    const res = await exportThread(rootId);
    expect(res.status).toBe(200);
    const parsed = ExportThreadSessionResponse.parse(res.json);
    expect(parsed.threadId).toBe(rootId);
    expect(parsed.exportedAt).toBeTruthy();

    // `jsonl` is Pi's own genuine session export (research.md R9): a header line followed by
    // message entries, each a real, parseable Pi session-manager entry — not a fabricated
    // approximation of one.
    const lines = parsed.jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines[0]?.type).toBe('session');
    expect(lines.some((l) => l.type === 'message')).toBe(true);

    // The friendly parse matches the thread's actual message history at export time (SC-005).
    expect(parsed.messages.map((m) => m.text)).toEqual(liveDetail.messages.map((m) => m.text));
    expect(parsed.messages.map((m) => m.role)).toEqual(liveDetail.messages.map((m) => m.role));
  });

  it('refuses to export a thread with no message history yet', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;

    const res = await exportThread(rootId);
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('EMPTY_THREAD_EXPORT');
  });

  it('does not corrupt the shared per-document session bookkeeping for later sends/branches', async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;
    await sendOnThread(ctx, rootId, 'Message before export.');

    // `PiService.exportThreadSession` must open its own throwaway `SessionManager`, never the
    // cached, shared one (research.md R9's gotcha) — exporting twice in a row here, before
    // proving a subsequent send still works, is a stronger check that no shared state was mutated.
    expect((await exportThread(rootId)).status).toBe(200);
    expect((await exportThread(rootId)).status).toBe(200);

    await sendOnThread(ctx, rootId, 'Message after export.');
    const detail = await getThreadMessages(ctx, rootId);
    expect(detail.messages.some((m) => m.text === 'Message after export.')).toBe(true);

    const anchor = detail.messages[0]!;
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: 'Message before' },
    );
    expect(branchRes.status).toBe(201);
  });
});

describe('User Story 4/FR-013b: a genuine whole-document Pi-native session export renders in the browser', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  async function exportDocument(): Promise<{
    status: number;
    body: string;
    contentType: string | undefined;
  }> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/documents/${ctx.documentId}/threads/export`,
    });
    return {
      status: res.statusCode,
      body: res.body,
      contentType: res.headers['content-type'] as string | undefined,
    };
  }

  it("exports the whole document tree as HTML containing every thread's content", async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;
    await sendOnThread(ctx, rootId, 'Root message unique text.');

    const detail = await getThreadMessages(ctx, rootId);
    const anchor = detail.messages[0]!;
    const branchRes = await call(
      ctx.app,
      'POST',
      `/api/documents/${ctx.documentId}/threads/${rootId}/branch`,
      { anchorMessageId: anchor.id, highlightedText: 'Root message unique text.' },
    );
    expect(branchRes.status).toBe(201);
    const branchId = (branchRes.json as { id: string }).id;
    await sendOnThread(ctx, branchId, 'Branch message unique text.');

    const res = await exportDocument();
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('Root message unique text.');
    expect(res.body).toContain('Branch message unique text.');
  });

  it('refuses to export a document with no message history in any thread', async () => {
    await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const res = await exportDocument();
    expect(res.status).toBe(409);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe(
      'EMPTY_DOCUMENT_EXPORT',
    );
  });

  it("does not corrupt any thread's ability to keep sending messages afterward", async () => {
    const created = await createThreadDoc(ctx, '# Thread doc\n\nContent.');
    const rootId = created.mainConversation.id;
    await sendOnThread(ctx, rootId, 'Message before whole-document export.');

    expect((await exportDocument()).status).toBe(200);
    expect((await exportDocument()).status).toBe(200);

    await sendOnThread(ctx, rootId, 'Message after whole-document export.');
    const detail = await getThreadMessages(ctx, rootId);
    expect(detail.messages.some((m) => m.text === 'Message after whole-document export.')).toBe(
      true,
    );
  });
});
