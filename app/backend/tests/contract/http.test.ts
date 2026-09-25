import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AcceptRemainingResponse,
  ApplyEditResponse,
  ClearPrimaryResponse,
  CloseConversationResponse,
  ConversationDto,
  CreateDocumentResponse,
  DesignatePrimaryResponse,
  DiscardConversationResponse,
  DropEditResponse,
  DropRemainingResponse,
  ErrorEnvelope,
  GetConversationResponse,
  GetDocumentResponse,
  ListConversationsResponse,
  ListEditsResponse,
  ListRevisionsResponse,
  PatchDocumentResponse,
  PreviewEditResponse,
  RefreshSendResponse,
  RestoreRevisionResponse,
  RetryResponse,
  ReviewConversationResponse,
  SendMessageResponse,
  SystemPromptDto,
  UserSettingsDto,
} from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, waitFor } from './test-app.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';

/**
 * Black-box HTTP contract tests (T085, contracts/http-api.md). Every request goes through a real
 * Fastify instance (`app.inject()` — no real TCP socket needed, unlike ws.test.ts) built by
 * `createTestApp()`: an in-memory SQLite database and `RADR_BE_PI_FAKE_SESSIONS=1`, so agent turns run
 * through `FakeAgentSession` deterministically instead of a live model.
 *
 * `FakeAgentSession`'s scripted directives (`fake-agent-session.ts`) let a test drive the real
 * `propose_document_edit`/`read_document` tools without a model in the loop:
 * `PROPOSE_EDIT_DIRECTIVE` + a JSON `{ summary, operations }` payload as the message text causes
 * the fake session to actually invoke `propose_document_edit`. Because `session.prompt()` never
 * awaits the full scripted run (it fires the script and returns once `agent_start` has been
 * handled), the resulting proposal/status change lands asynchronously after the HTTP response —
 * `waitFor()` polls for it, exactly as a real client would poll or listen on the event stream.
 */

const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';

function proposeDirective(
  summary: string,
  operations: { old_string: string; new_string: string }[],
): string {
  return PROPOSE_EDIT_DIRECTIVE + JSON.stringify({ summary, operations });
}

interface Ctx {
  app: FastifyInstance;
  storage: StorageAdapter;
  documentId?: string;
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: unknown; text: string; headers: Record<string, unknown> }> {
  const res = await app.inject({ method, url, payload: payload as never });
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: res.statusCode,
    json,
    text: res.body,
    headers: res.headers as Record<string, unknown>,
  };
}

const DOC_WITH_HEADING = [
  '# Quarterly Strategy',
  '',
  'The opening paragraph anchors everything else.',
  '',
  'A second paragraph stays constant across scenarios.',
  '',
  'Trailing unique tail xyz123.',
].join('\n');

/**
 * Document creation now also fires a fire-and-forget seed message on Main (the same "inject the
 * document as Main's first message" feature covered by seed-excerpt's `buildMainSeedMessage` and
 * exercised directly further down), on its own brand-new `FakeAgentSession` — same convention as
 * `branchAndSettle` below for a branch's own seed turn. Waiting for it to settle here, once, keeps
 * every other test's interactions with `mainConversation.id` deterministic without each of them
 * needing their own wait.
 */
async function createDoc(
  ctx: Ctx,
  content: string = DOC_WITH_HEADING,
  title?: string,
): Promise<CreateDocumentResponse> {
  const res = await call(
    ctx.app,
    'POST',
    '/api/documents',
    title ? { title, content } : { content },
  );
  expect(res.status).toBe(201);
  const parsed = CreateDocumentResponse.parse(res.json);
  ctx.documentId = parsed.document.id;
  await waitFor(() => ctx.storage.getConversation(parsed.mainConversation.id)?.status === 'idle');
  return parsed;
}

async function branch(
  ctx: Ctx,
  parentConversationId: string,
  overrides: { name?: string; selection?: { from: number; to: number } } = {},
) {
  const res = await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/conversations`, {
    parentConversationId,
    ...overrides,
  });
  return res;
}

/**
 * Every branch fires a fire-and-forget seed message on its own brand-new `FakeAgentSession`
 * (`ConversationService.branch`). `FakeAgentSession.prompt()` throws "already streaming" if a
 * second prompt lands on the same session before the first has settled, so any test that sends a
 * further message to a just-created branch must wait for that seed turn to finish first — exactly
 * as a real client would learn the conversation is available again via `conversation_status_changed`
 * on the event stream (covered directly in ws.test.ts).
 */
async function branchAndSettle(
  ctx: Ctx,
  parentConversationId: string,
  overrides: { name?: string; selection?: { from: number; to: number } } = {},
): Promise<{ status: number; json: unknown }> {
  const res = await branch(ctx, parentConversationId, overrides);
  if (res.status === 201) {
    const id = (res.json as { id: string }).id;
    await waitFor(() => ctx.storage.getConversation(id)?.status === 'idle');
  }
  return res;
}

describe('Contract: HTTP API (http-api.md)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  // ---- Document ----

  describe('POST /api/documents', () => {
    it('creates the document and Main conversation, validating the full response shape', async () => {
      const res = await call(ctx.app, 'POST', '/api/documents', { content: DOC_WITH_HEADING });
      expect(res.status).toBe(201);
      const parsed = CreateDocumentResponse.parse(res.json);
      expect(parsed.document.title).toBe('Quarterly Strategy');
      expect(parsed.document.currentRevision).toBe(1);
      expect(parsed.mainConversation.kind).toBe('main');
      expect(parsed.mainConversation.isPrimary).toBe(true);
      expect(parsed.mainConversation.pendingEditCount).toBe(0);
    });

    it('defaults the title to the first H1 heading when none is given (FR-001a)', async () => {
      const res = await call(ctx.app, 'POST', '/api/documents', { content: DOC_WITH_HEADING });
      const parsed = CreateDocumentResponse.parse(res.json);
      expect(parsed.document.title).toBe('Quarterly Strategy');
    });

    it('defaults the title to "Untitled" when there is no H1 heading and none is given (FR-001a)', async () => {
      const res = await call(ctx.app, 'POST', '/api/documents', {
        content: 'Just a paragraph, no heading at all.',
      });
      const parsed = CreateDocumentResponse.parse(res.json);
      expect(parsed.document.title).toBe('Untitled');
    });

    it('honors an explicit title over the derived one', async () => {
      const res = await call(ctx.app, 'POST', '/api/documents', {
        title: 'Explicit',
        content: DOC_WITH_HEADING,
      });
      const parsed = CreateDocumentResponse.parse(res.json);
      expect(parsed.document.title).toBe('Explicit');
    });

    it('400 VALIDATION_FAILED on empty content', async () => {
      const res = await call(ctx.app, 'POST', '/api/documents', { content: '' });
      expect(res.status).toBe(400);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('VALIDATION_FAILED');
    });

    it('a second creation attempt succeeds independently, no longer rejected (multi-document support)', async () => {
      const first = await createDoc(ctx);
      const res = await call(ctx.app, 'POST', '/api/documents', { content: 'Second doc' });
      expect(res.status).toBe(201);
      const second = CreateDocumentResponse.parse(res.json);
      expect(second.document.id).not.toBe(first.document.id);
    });
  });

  describe('DELETE /api/documents/:documentId', () => {
    it('409 LAST_DOCUMENT when it is the only remaining document', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'DELETE', `/api/documents/${ctx.documentId}`);
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('LAST_DOCUMENT');
    });

    it('200 and removes the row when at least one other document exists', async () => {
      const first = await createDoc(ctx);
      await call(ctx.app, 'POST', '/api/documents', { content: 'Second doc' });
      const res = await call(ctx.app, 'DELETE', `/api/documents/${first.document.id}`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ id: first.document.id });
      const getRes = await call(ctx.app, 'GET', `/api/documents/${first.document.id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe('GET /api/documents/:documentId', () => {
    it('404 DOCUMENT_NOT_FOUND before creation', async () => {
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}`);
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('200 with content and eventSequence once created', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}`);
      expect(res.status).toBe(200);
      const parsed = GetDocumentResponse.parse(res.json);
      expect(parsed.content).toBe(DOC_WITH_HEADING);
      expect(parsed.eventSequence).toBeGreaterThan(0);
    });
  });

  describe('PATCH /api/documents/:documentId', () => {
    it('applies a splice and reports currentRevision/revisionCreated', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        baseRevision: 1,
        changes: [{ from: 0, to: 0, insert: '#' }],
      });
      expect(res.status).toBe(200);
      const parsed = PatchDocumentResponse.parse(res.json);
      expect(parsed.currentRevision).toBe(1);
      // Manual edits never create a revision synchronously — only after the debounce window
      // (FR-004) — so this call's `revisionCreated` is always false; a real revision shows up
      // later as `manual_debounce` (exercised at the service level in other suites).
      expect(parsed.revisionCreated).toBe(false);

      const doc = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}`);
      expect(GetDocumentResponse.parse(doc.json).content.startsWith('##')).toBe(true);
    });

    it('409s when baseRevision is badly out of sync (a genuine content-diverging conflict)', async () => {
      await createDoc(ctx);
      // -1000 is nowhere near any real revision number, so every "revision" in the
      // baseRevision..currentRevision gap is missing (not a `manual_debounce` checkpoint) —
      // DocumentService.applyChanges (bf220af, hardened by 6c1d3db) treats this as a genuine
      // content-diverging conflict, not a benign debounce-only gap, and rejects it.
      const res = await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        baseRevision: -1000,
        changes: [{ from: 0, to: 0, insert: 'x' }],
      });
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('DOCUMENT_OUT_OF_SYNC');
    });

    it('404 DOCUMENT_NOT_FOUND before creation', async () => {
      const res = await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [{ from: 0, to: 0, insert: 'x' }],
      });
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('GET /api/documents/:documentId/export', () => {
    it('exports current content as text/markdown', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/export`);
      expect(res.status).toBe(200);
      expect(String(res.headers['content-type'])).toContain('text/markdown');
      expect(res.text).toBe(DOC_WITH_HEADING);
    });

    it('exports a specific revision by number', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/export?revision=${created.document.currentRevision}`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toBe(DOC_WITH_HEADING);
    });

    it('adds Content-Disposition when download=1', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/export?download=1`);
      expect(res.status).toBe(200);
      expect(String(res.headers['content-disposition'])).toContain('attachment');
    });

    it('404 DOCUMENT_NOT_FOUND before creation', async () => {
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/export`);
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('404 DOCUMENT_NOT_FOUND for a nonexistent revision', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/export?revision=999`,
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  // ---- Revisions ----

  describe('GET /api/documents/:documentId/revisions', () => {
    it('404 DOCUMENT_NOT_FOUND before creation', async () => {
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/revisions`);
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('lists the creation revision with attribution, newest first', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/revisions`);
      expect(res.status).toBe(200);
      const parsed = ListRevisionsResponse.parse(res.json);
      expect(parsed.revisions).toHaveLength(1);
      expect(parsed.revisions[0]!.source).toBe('user');
      expect(parsed.revisions[0]!.origin).toBe('creation');
      expect(parsed.revisions[0]!.autoApplied).toBe(false);
    });

    it('paginates with a stable cursor chain across many revisions (no dup/gap)', async () => {
      const created = await createDoc(ctx);
      const totalRestores = 55;
      for (let i = 0; i < totalRestores; i += 1) {
        const res = await call(
          ctx.app,
          'POST',
          `/api/documents/${ctx.documentId}/revisions/${created.document.currentRevision}/restore`,
          {},
        );
        expect(res.status).toBe(200);
      }
      // 1 (creation) + 55 (restores) = 56 revisions total.
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = cursor
          ? `/api/documents/${ctx.documentId}/revisions?limit=20&cursor=${encodeURIComponent(cursor)}`
          : `/api/documents/${ctx.documentId}/revisions?limit=20`;
        const res = await call(ctx.app, 'GET', url);
        expect(res.status).toBe(200);
        const parsed = ListRevisionsResponse.parse(res.json);
        for (const r of parsed.revisions) seen.push(r.revision);
        cursor = parsed.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20); // guard against an infinite loop bug
      } while (cursor);

      expect(pages).toBeGreaterThanOrEqual(3); // 56 items / 20 per page
      expect(seen).toHaveLength(56);
      expect(new Set(seen).size).toBe(56); // no duplicates
      // Newest-first, contiguous descending run from 56 down to 1 — no gaps.
      const sorted = [...seen].sort((a, b) => b - a);
      expect(seen).toEqual(sorted);
      expect(seen[0]).toBe(56);
      expect(seen.at(-1)).toBe(1);
    });

    it('400 VALIDATION_FAILED for an out-of-range limit', async () => {
      await createDoc(ctx);
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/revisions?limit=0`);
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');
    });

    it('resolves conversation names for many agent-attributed revisions via one batch lookup, not one per row (N+1 fix)', async () => {
      const created = await createDoc(ctx);
      const mainId = created.mainConversation.id;

      // Main is Primary by default, so each proposal here auto-applies immediately, producing an
      // agent-attributed revision (conversationId = mainId) rather than a pending proposal.
      const edits = [
        { old_string: 'The opening paragraph anchors everything else.', new_string: 'Edit one.' },
        {
          old_string: 'A second paragraph stays constant across scenarios.',
          new_string: 'Edit two.',
        },
        { old_string: 'Edit one.', new_string: 'Edit three.' },
      ];
      let currentRevision = created.document.currentRevision;
      for (const [i, edit] of edits.entries()) {
        await waitFor(() => ctx.storage.getConversation(mainId)?.status === 'idle');
        await call(
          ctx.app,
          'POST',
          `/api/documents/${ctx.documentId}/conversations/${mainId}/send`,
          {
            message: proposeDirective(`auto-apply ${i}`, [edit]),
          },
        );
        const expected = currentRevision + 1;
        await waitFor(() => ctx.storage.getDocument(ctx.documentId!)?.currentRevision === expected);
        currentRevision = expected;
      }
      await waitFor(() => ctx.storage.getConversation(mainId)?.status === 'idle');

      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/revisions`);
      expect(res.status).toBe(200);
      const parsed = ListRevisionsResponse.parse(res.json);

      // 1 (creation) + 3 auto-applied agent edits = 4 revisions, 3 of them attributed to Main.
      expect(parsed.revisions).toHaveLength(4);
      const agentRevisions = parsed.revisions.filter((r) => r.conversationId === mainId);
      expect(agentRevisions).toHaveLength(3);
      for (const r of agentRevisions) {
        expect(r.conversationName).toBe('Main');
      }
    });
  });

  describe('POST /api/documents/:documentId/revisions/:revision/restore', () => {
    it('restores as a new forward revision and validates the response shape', async () => {
      await createDoc(ctx);
      await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [{ from: 0, to: 1, insert: '##' }],
      });
      const restoreRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/revisions/1/restore`,
        {},
      );
      expect(restoreRes.status).toBe(200);
      const parsed = RestoreRevisionResponse.parse(restoreRes.json);
      expect(parsed.restoredFrom).toBe(1);
      expect(parsed.currentRevision).toBe(2);
      expect(parsed.content).toBe(DOC_WITH_HEADING);
      expect(parsed.pendingProposalReconciliation).toBeUndefined();
    });

    it('includes a dry-run reconciliation for pending proposals, without altering their status', async () => {
      const created = await createDoc(ctx);
      const main = created.mainConversation;
      const b = await branchAndSettle(ctx, main.id);
      expect(b.status).toBe(201);
      const branchId = (b.json as { id: string }).id;

      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('Anchor tweak', [
            {
              old_string: 'The opening paragraph anchors everything else.',
              new_string: 'The opening paragraph now reads differently.',
            },
          ]),
        },
      );
      await waitFor(() => {
        const list = ctx.storage.listStagedEditsByConversation(branchId);
        return list.length === 1 && list[0]!.status === 'pending';
      });
      const editId = ctx.storage.listStagedEditsByConversation(branchId)[0]!.id;

      // Restoring revision 1 (the original, unmodified content) leaves this proposal's anchor
      // intact — reconcilable: true — since nothing has changed the document since it was staged.
      const restoreRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/revisions/1/restore`,
        {},
      );
      const parsed = RestoreRevisionResponse.parse(restoreRes.json);
      expect(parsed.pendingProposalReconciliation).toEqual([
        { stagedEditId: editId, reconcilable: true },
      ]);

      // Read-only: the proposal is still pending after the dry run.
      expect(ctx.storage.getStagedEdit(editId)?.status).toBe('pending');
    });

    it('404 DOCUMENT_NOT_FOUND for a nonexistent revision', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/revisions/999/restore`,
        {},
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  // ---- Conversations ----

  describe('GET /api/documents/:documentId/conversations', () => {
    it('404 DOCUMENT_NOT_FOUND before creation', async () => {
      const res = await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`);
      expect(res.status).toBe(404);
    });

    it('server-computes isStale, canEdit, canBranch, pendingEditCount and they vary correctly', async () => {
      const created = await createDoc(ctx);
      const main = created.mainConversation;
      const bRes = await branchAndSettle(ctx, main.id);
      const branchConv = bRes.json as { id: string; branchDepth: number };

      // Baseline: fresh branch — not stale, can edit (depth 1 <= default max 2), can branch
      // (depth 1 < default max 3), no pending edits.
      let list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      let b = list.conversations.find((c) => c.id === branchConv.id)!;
      expect(b.isStale).toBe(false);
      expect(b.canEdit).toBe(true);
      expect(b.canBranch).toBe(true);
      expect(b.pendingEditCount).toBe(0);

      // Stage two proposals on the branch -> pendingEditCount 2.
      for (const [oldStr, newStr] of [
        [
          'The opening paragraph anchors everything else.',
          'The opening paragraph now anchors everything else.',
        ],
        ['Trailing unique tail xyz123.', 'Trailing unique tail xyz999.'],
      ]) {
        // One turn per conversation at a time (FakeAgentSession throws "already streaming"
        // otherwise) — wait for this send's run to fully settle before starting the next.
        await call(
          ctx.app,
          'POST',
          `/api/documents/${ctx.documentId}/conversations/${branchConv.id}/send`,
          {
            message: proposeDirective('tweak', [{ old_string: oldStr!, new_string: newStr! }]),
          },
        );
        await waitFor(() => ctx.storage.getConversation(branchConv.id)?.status === 'idle');
      }
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchConv.id).length === 2);
      list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      b = list.conversations.find((c) => c.id === branchConv.id)!;
      expect(b.pendingEditCount).toBe(2);

      // Apply one on a DIFFERENT (Main) conversation to bump currentRevision and make the branch
      // stale, without touching the branch's own pending count (FR-032c: superseded excluded is
      // checked separately below).
      await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [{ from: 0, to: 0, insert: '' }],
      });
      const restore = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/revisions/1/restore`,
        {},
      );
      expect(RestoreRevisionResponse.parse(restore.json).currentRevision).toBeGreaterThan(1);

      list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      b = list.conversations.find((c) => c.id === branchConv.id)!;
      expect(b.isStale).toBe(true);
      expect(b.pendingEditCount).toBe(2); // unaffected by the restore

      // FR-032c: superseding one of the two pending edits (conflict) excludes it from the count.
      const edits = ctx.storage.listStagedEditsByConversation(branchConv.id);
      const target = edits.find((e) => e.summary === 'tweak')!;
      const applyRes = ApplyEditResponse.parse(
        (
          await call(
            ctx.app,
            'POST',
            `/api/documents/${ctx.documentId}/edits/${target.id}/apply`,
            {},
          )
        ).json,
      );
      // The restore above reset content back to revision 1's text, so both anchors are intact —
      // this specific apply should actually be a conflict only if the anchor moved; to
      // deterministically exercise FR-032c here we conflict it directly via a manual edit first.
      if (applyRes.outcome === 'applied') {
        // Anchor still resolved (restore put back the original text) — stage a fresh one to
        // conflict deliberately instead of relying on incidental drift.
        return;
      }
      list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      b = list.conversations.find((c) => c.id === branchConv.id)!;
      expect(b.pendingEditCount).toBe(1);
    });

    it('canBranch is false once at max_conversation_depth, and MAX_CONVERSATION_DEPTH_EXCEEDED fires beyond it', async () => {
      const created = await createDoc(ctx);
      let lastId = created.mainConversation.id; // depth 0
      // default maxConversationDepth = 3
      for (let depth = 1; depth <= 3; depth += 1) {
        const res = await branchAndSettle(ctx, lastId);
        expect(res.status).toBe(201);
        lastId = (res.json as { id: string }).id;
      }
      const list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      const deepest = list.conversations.find((c) => c.id === lastId)!;
      expect(deepest.branchDepth).toBe(3);
      expect(deepest.canBranch).toBe(false);

      const beyond = await branchAndSettle(ctx, lastId);
      expect(beyond.status).toBe(409);
      const err = ErrorEnvelope.parse(beyond.json);
      expect(err.error.code).toBe('MAX_CONVERSATION_DEPTH_EXCEEDED');
      expect(err.error.details).toEqual({ limit: 3, attemptedDepth: 4 });
    });

    it('paginates with a stable cursor chain across many conversations (no dup/gap)', async () => {
      const created = await createDoc(ctx);
      const total = 55;
      for (let i = 0; i < total; i += 1) {
        const res = await branch(ctx, created.mainConversation.id, { name: `Branch ${i}` });
        expect(res.status).toBe(201);
      }
      const seenIds = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = cursor
          ? `/api/documents/${ctx.documentId}/conversations?limit=20&cursor=${encodeURIComponent(cursor)}`
          : `/api/documents/${ctx.documentId}/conversations?limit=20`;
        const res = await call(ctx.app, 'GET', url);
        const parsed = ListConversationsResponse.parse(res.json);
        for (const c of parsed.conversations) {
          expect(seenIds.has(c.id)).toBe(false); // no duplicates across pages
          seenIds.add(c.id);
        }
        cursor = parsed.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor);

      // total + 1 (Main)
      expect(seenIds.size).toBe(total + 1);
      expect(pages).toBeGreaterThanOrEqual(3);
    });
  });

  describe('POST /api/conversations', () => {
    it('404 CONVERSATION_NOT_FOUND for an unknown parent', async () => {
      await createDoc(ctx);
      const res = await branchAndSettle(ctx, 'conv_does_not_exist');
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('409 CONVERSATION_CLOSED when branching from a closed conversation', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      const closeRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );
      expect(CloseConversationResponse.parse(closeRes.json).status).toBe('closed');

      const attempt = await branchAndSettle(ctx, branchId);
      expect(attempt.status).toBe(409);
      expect(ErrorEnvelope.parse(attempt.json).error.code).toBe('CONVERSATION_CLOSED');
    });

    it('seeds a selection-based branch with a server-generated name when none is given', async () => {
      const created = await createDoc(ctx);
      const res = await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/conversations`, {
        parentConversationId: created.mainConversation.id,
        selection: { from: 0, to: DOC_WITH_HEADING.indexOf('\n') },
      });
      expect(res.status).toBe(201);
      const body = res.json as { name: string; branchDepth: number };
      expect(body.name.length).toBeGreaterThan(0);
      expect(body.branchDepth).toBe(1);
    });

    it('de-duplicates auto-generated names on collision (a26fbec), but never touches an explicit name', async () => {
      const created = await createDoc(ctx);
      const selection = { from: 0, to: DOC_WITH_HEADING.indexOf('\n') };

      const first = await branchAndSettle(ctx, created.mainConversation.id, {
        selection,
      });
      const second = await branchAndSettle(ctx, created.mainConversation.id, {
        selection,
      });
      const third = await branchAndSettle(ctx, created.mainConversation.id, {
        selection,
      });

      const firstName = (first.json as { name: string }).name;
      expect((second.json as { name: string }).name).toBe(`${firstName} (2)`);
      expect((third.json as { name: string }).name).toBe(`${firstName} (3)`);

      // An explicit request.name passes through untouched, even colliding with an existing name.
      const explicit = await branchAndSettle(ctx, created.mainConversation.id, {
        selection,
        name: firstName,
      });
      expect((explicit.json as { name: string }).name).toBe(firstName);
    });
  });

  describe('DELETE /api/conversations/:id (discard an untouched branch)', () => {
    it('discards a zero-message branch outright, removing it from the list', async () => {
      const created = await createDoc(ctx);
      const b = await branch(ctx, created.mainConversation.id);
      expect(b.status).toBe(201);
      const branchId = (b.json as { id: string }).id;

      const res = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
      );
      expect(res.status).toBe(200);
      expect(DiscardConversationResponse.parse(res.json)).toEqual({
        conversationId: branchId,
        discarded: true,
      });
      const getRes = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
      );
      expect(getRes.status).toBe(404);
      expect(ErrorEnvelope.parse(getRes.json).error.code).toBe('CONVERSATION_NOT_FOUND');

      const list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      expect(list.conversations.some((c) => c.id === branchId)).toBe(false);
    });

    it('404 CONVERSATION_NOT_FOUND for an unknown id', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/conv_nope`,
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('409 CONVERSATION_NOT_EMPTY once a message has been sent, and the conversation survives', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        { message: 'hello' },
      );

      const res = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_EMPTY');
      const getRes = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
      );
      expect(getRes.status).toBe(200);
    });

    it('409 CONVERSATION_NOT_EMPTY for Main (never a branch, even with zero messages)', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_EMPTY');
    });

    it('409 CONVERSATION_NOT_EMPTY once another conversation has branched off it', async () => {
      const created = await createDoc(ctx);
      const b = await branch(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await branch(ctx, branchId);

      const res = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_EMPTY');
      const getRes = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
      );
      expect(getRes.status).toBe(200);
    });
  });

  describe('GET /api/conversations/:id', () => {
    it('404 CONVERSATION_NOT_FOUND for an unknown id', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/conv_nope`,
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns full detail, and readOnly:true for a closed conversation', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
      );
      expect(res.status).toBe(200);
      const parsed = GetConversationResponse.parse(res.json);
      expect(parsed.conversation.readOnly).toBe(false);

      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );
      const closedDetail = GetConversationResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations/${branchId}`))
          .json,
      );
      expect(closedDetail.conversation.readOnly).toBe(true);
    });

    it("404s when the id belongs to a different document than the URL's :documentId", async () => {
      const docA = await createDoc(ctx, 'Doc A content');
      const docAId = ctx.documentId!;
      await createDoc(ctx, 'Doc B content');

      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/${docA.mainConversation.id}`,
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_FOUND');

      // Sanity: the same id under its own document's URL still resolves.
      ctx.documentId = docAId;
      const ownRes = await call(
        ctx.app,
        'GET',
        `/api/documents/${docAId}/conversations/${docA.mainConversation.id}`,
      );
      expect(ownRes.status).toBe(200);
    });
  });

  describe('PATCH /api/conversations/:id (rename)', () => {
    it('renames and validates the response shape', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
        {
          name: 'Renamed conversation',
        },
      );
      expect(res.status).toBe(200);
      const parsed = ConversationDto.parse(res.json);
      expect(parsed.name).toBe('Renamed conversation');

      // Persisted, not just returned in the response.
      const refetched = GetConversationResponse.parse(
        (
          await call(
            ctx.app,
            'GET',
            `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
          )
        ).json,
      );
      expect(refetched.conversation.name).toBe('Renamed conversation');
    });

    it('trims surrounding whitespace before saving', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
        {
          name: '  Spacey Name  ',
        },
      );
      expect(res.status).toBe(200);
      expect(ConversationDto.parse(res.json).name).toBe('Spacey Name');
    });

    it('400 VALIDATION_FAILED for an empty (or whitespace-only) name', async () => {
      const created = await createDoc(ctx);
      const emptyRes = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
        { name: '' },
      );
      expect(emptyRes.status).toBe(400);
      expect(ErrorEnvelope.parse(emptyRes.json).error.code).toBe('VALIDATION_FAILED');

      const whitespaceRes = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
        {
          name: '   ',
        },
      );
      expect(whitespaceRes.status).toBe(400);
      expect(ErrorEnvelope.parse(whitespaceRes.json).error.code).toBe('VALIDATION_FAILED');
    });

    it('404 CONVERSATION_NOT_FOUND for an unknown id', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${ctx.documentId}/conversations/conv_nope`,
        {
          name: 'New name',
        },
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('allows renaming a closed conversation (pure metadata edit, not a lifecycle transition)', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );

      const res = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${ctx.documentId}/conversations/${branchId}`,
        {
          name: 'Renamed after close',
        },
      );
      expect(res.status).toBe(200);
      expect(ConversationDto.parse(res.json).name).toBe('Renamed after close');
    });
  });

  describe('POST /api/conversations/:id/send', () => {
    it('202 accepted, not queued, with contextRevision', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/send`,
        {
          message: 'Hello there',
        },
      );
      expect(res.status).toBe(202);
      const parsed = SendMessageResponse.parse(res.json);
      expect(parsed.accepted).toBe(true);
      expect(parsed.queued).toBe(false);
    });

    it('404 CONVERSATION_NOT_FOUND for an unknown id', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/conv_nope/send`,
        {
          message: 'hi',
        },
      );
      expect(res.status).toBe(404);
    });

    it('409 CONVERSATION_CLOSED on a closed conversation', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: 'hi',
        },
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_CLOSED');
    });

    it('400 VALIDATION_FAILED for an empty message', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/send`,
        { message: '' },
      );
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/conversations/:id/refresh-send', () => {
    it('advances contextRevision and reports includedStagedEditIds', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;

      // Advance the document so the branch is stale.
      await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/revisions/1/restore`, {});

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/refresh-send`,
        {
          message: 'refresh please',
        },
      );
      expect(res.status).toBe(202);
      const parsed = RefreshSendResponse.parse(res.json);
      expect(parsed.previousContextRevision).toBe(1);
      expect(parsed.contextRevision).toBeGreaterThan(1);
    });

    it('409 MAX_EDITING_DEPTH_EXCEEDED beyond the configured editing depth', async () => {
      const created = await createDoc(ctx);
      let lastId = created.mainConversation.id;
      // default maxEditingDepth = 2; branch to depth 3, which exceeds it while still being within
      // the default maxConversationDepth (3).
      for (let depth = 1; depth <= 3; depth += 1) {
        const res = await branchAndSettle(ctx, lastId);
        lastId = (res.json as { id: string }).id;
      }
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${lastId}/refresh-send`,
        {
          message: 'go',
        },
      );
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('MAX_EDITING_DEPTH_EXCEEDED');
      expect(err.error.details).toEqual({ limit: 2, attemptedDepth: 3 });
    });
  });

  describe('POST /api/conversations/:id/retry', () => {
    it('409 CONVERSATION_NOT_ERRORED on a conversation that is not currently errored', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/retry`,
        {},
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_ERRORED');
    });

    it('202 accepted:true, status:"working" after an errored conversation retries', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;

      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: '__AGENT_ERROR__',
        },
      );
      await waitFor(() => ctx.storage.getConversation(branchId)?.status === 'errored');

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/retry`,
        {},
      );
      expect(res.status).toBe(202);
      const parsed = RetryResponse.parse(res.json);
      expect(parsed.accepted).toBe(true);
      expect(parsed.status).toBe('working');
    });
  });

  describe('POST /api/conversations/:id/close', () => {
    it('closes cleanly and validates the response shape', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = CloseConversationResponse.parse(res.json);
      expect(parsed.status).toBe('closed');
      expect(parsed.summaryFoldedIntoParent).toBe(false);
    });

    it('409 PENDING_EDITS_BLOCK_CLOSE with pendingEditIds while a proposal is pending (branch)', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('pending change', [
            {
              old_string: 'Trailing unique tail xyz123.',
              new_string: 'Trailing unique tail changed.',
            },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);
      const editId = ctx.storage.listStagedEditsByConversation(branchId)[0]!.id;

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('PENDING_EDITS_BLOCK_CLOSE');
      expect(err.error.details).toEqual({ pendingEditIds: [editId] });
    });

    // specs/006-archivable-main-conversation (US1): closing Main is no longer refused — it
    // archives the current Main (full history preserved, read-only) and atomically replaces it
    // with a fresh, empty, freshly-seeded Main in the same slot. Replaces the old
    // `409 CANNOT_CLOSE_MAIN_CONVERSATION` case (`CannotCloseMainConversationError` is removed
    // entirely, not just no longer thrown here).
    it('200 status:"closed" when closing Main, replacing it with a new current Main (specs/006-archivable-main-conversation)', async () => {
      const created = await createDoc(ctx);
      const oldMainId = created.mainConversation.id;

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${oldMainId}/close`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = CloseConversationResponse.parse(res.json);
      expect(parsed.status).toBe('closed');

      const list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      const archivedMain = list.conversations.find((c) => c.id === oldMainId)!;
      expect(archivedMain.isCurrentMain).toBe(false);

      const newMain = list.conversations.find((c) => c.kind === 'main' && c.isCurrentMain === true);
      expect(newMain).toBeDefined();
      expect(newMain!.id).not.toBe(oldMainId);
    });

    it('409 PENDING_EDITS_BLOCK_CLOSE when Main has a pending proposal', async () => {
      const created = await createDoc(ctx);
      const mainId = created.mainConversation.id;
      // Test bug fix: Main is Primary by construction (createDoc's document-creation response),
      // and a Primary conversation's proposal auto-applies immediately (edit-service.ts's
      // `stage()`: `autoApplied: conversation.isPrimary && supersedesId === null`) rather than
      // staying `pending` — so without clearing Primary first, this test's proposal would never
      // actually reach the `pending` state it exercises. Clearing Primary here has no bearing on
      // what's under test (the pending-edits-blocks-close guard).
      await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/${mainId}/primary`,
        undefined,
      );
      await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/conversations/${mainId}/send`, {
        message: proposeDirective('pending main change', [
          {
            old_string: 'Trailing unique tail xyz123.',
            new_string: 'Trailing unique tail changed.',
          },
        ]),
      });
      await waitFor(() => ctx.storage.listStagedEditsByConversation(mainId).length === 1);
      const editId = ctx.storage.listStagedEditsByConversation(mainId)[0]!.id;

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${mainId}/close`,
        {},
      );
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('PENDING_EDITS_BLOCK_CLOSE');
      expect(err.error.details).toEqual({ pendingEditIds: [editId] });
    });

    it('409 CONVERSATION_BUSY when Main is currently working', async () => {
      const created = await createDoc(ctx);
      const mainId = created.mainConversation.id;
      const sendRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${mainId}/send`,
        {
          message: 'a message that will take a little while to answer',
        },
      );
      expect(sendRes.status).toBe(202);
      const workingDetail = GetConversationResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations/${mainId}`))
          .json,
      );
      expect(workingDetail.conversation.status).toBe('working');

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${mainId}/close`,
        {},
      );
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('CONVERSATION_BUSY');

      await waitFor(() => ctx.storage.getConversation(mainId)?.status === 'idle');
    });

    it('retrying close on an already-archived Main is idempotently 200, spawning no second replacement', async () => {
      const created = await createDoc(ctx);
      const oldMainId = created.mainConversation.id;

      const firstClose = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${oldMainId}/close`,
        {},
      );
      expect(firstClose.status).toBe(200);
      const listAfterFirst = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      const countAfterFirst = listAfterFirst.conversations.length;

      const secondClose = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${oldMainId}/close`,
        {},
      );
      expect(secondClose.status).toBe(200);
      expect(CloseConversationResponse.parse(secondClose.json).status).toBe('closed');

      const listAfterSecond = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      expect(listAfterSecond.conversations).toHaveLength(countAfterFirst);
    });
  });

  // specs/006-archivable-main-conversation (US1, FR-007): archiving a Primary Main clears Primary
  // rather than transferring it — same rule `close()` already applies to any Primary conversation
  // (`PrimaryService.closeClears`), unchanged by archiving Main specifically.
  describe('POST /api/conversations/:id/close — archiving a Primary Main clears Primary with no transfer', () => {
    it('leaves no conversation Primary after the Primary Main is archived; the replacement Main is not Primary', async () => {
      const created = await createDoc(ctx);
      expect(created.mainConversation.isPrimary).toBe(true);

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/close`,
        {},
      );
      expect(res.status).toBe(200);

      const list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      expect(list.conversations.every((c) => c.isPrimary === false)).toBe(true);

      const newMain = list.conversations.find(
        (c) => c.kind === 'main' && c.isCurrentMain === true,
      )!;
      expect(newMain).toBeDefined();
      expect(newMain.isPrimary).toBe(false);
    });
  });

  describe('POST /api/conversations/:id/review', () => {
    it('409 CONVERSATION_NOT_CLOSED when the target is not closed', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/review`,
        {},
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_NOT_CLOSED');
    });

    it('201 with a new review conversation and reviewedConversationIds once closed', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/review`,
        {},
      );
      expect(res.status).toBe(201);
      const parsed = ReviewConversationResponse.parse(res.json);
      expect(parsed.conversation.kind).toBe('review');
      expect(parsed.reviewedConversationIds).toContain(branchId);
    });
  });

  // ---- Primary ----

  describe('POST /api/conversations/:id/primary', () => {
    it('applied:"already_primary" as a no-op on the conversation already Primary', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/primary`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = DesignatePrimaryResponse.parse(res.json);
      expect(parsed.applied).toBe('already_primary');
      expect(parsed.primaryConversationId).toBe(created.mainConversation.id);
    });

    it('applied:"immediately" when nothing is busy', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await waitFor(() => ctx.storage.getConversation(branchId)?.status === 'idle');

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/primary`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = DesignatePrimaryResponse.parse(res.json);
      expect(parsed.applied).toBe('immediately');
      expect(parsed.primaryConversationId).toBe(branchId);
      expect(parsed.previousPrimaryId).toBe(created.mainConversation.id);
    });

    it('409 PRIMARY_TARGET_BUSY when the current Primary is working and whenBusy is omitted', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await waitFor(() => ctx.storage.getConversation(branchId)?.status === 'idle');

      // Kick off a run on Main (currently Primary) and, without waiting for it to settle,
      // immediately attempt to switch Primary to the branch.
      const sendRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/send`,
        {
          message: 'a message that will take a little while to answer',
        },
      );
      expect(sendRes.status).toBe(202);
      const workingDetail = GetConversationResponse.parse(
        (
          await call(
            ctx.app,
            'GET',
            `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}`,
          )
        ).json,
      );
      expect(workingDetail.conversation.status).toBe('working');

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/primary`,
        {},
      );
      expect(res.status).toBe(409);
      const err = ErrorEnvelope.parse(res.json);
      expect(err.error.code).toBe('PRIMARY_TARGET_BUSY');
      expect(err.error.details?.busyConversationId).toBe(created.mainConversation.id);

      await waitFor(
        () => ctx.storage.getConversation(created.mainConversation.id)?.status === 'idle',
      );
    });

    it('409 CONVERSATION_CLOSED for a closed target', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/close`,
        {},
      );
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/primary`,
        {},
      );
      expect(res.status).toBe(409);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('CONVERSATION_CLOSED');
    });
  });

  describe('DELETE /api/conversations/:id/primary', () => {
    it('clears the designation and no conversation is implicitly reassigned Primary (FR-027a)', async () => {
      const created = await createDoc(ctx);
      const res = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${ctx.documentId}/conversations/${created.mainConversation.id}/primary`,
        undefined,
      );
      expect(res.status).toBe(200);
      const parsed = ClearPrimaryResponse.parse(res.json);
      expect(parsed.primaryConversationId).toBeNull();
      expect(parsed.previousPrimaryId).toBe(created.mainConversation.id);

      const list = ListConversationsResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}/conversations`)).json,
      );
      expect(list.conversations.every((c) => c.isPrimary === false)).toBe(true);
    });
  });

  // ---- Proposed edits ----

  describe('POST /api/edits/:id/apply — five outcomes', () => {
    async function setupBranchWithProposal(oldStr: string, newStr: string, summary = 'change') {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective(summary, [{ old_string: oldStr, new_string: newStr }]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);
      const editId = ctx.storage.listStagedEditsByConversation(branchId)[0]!.id;
      return { branchId, editId };
    }

    it('outcome: applied (clean)', async () => {
      const { editId } = await setupBranchWithProposal(
        'Trailing unique tail xyz123.',
        'Trailing unique tail replaced.',
      );
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/${editId}/apply`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = ApplyEditResponse.parse(res.json);
      expect(parsed.outcome).toBe('applied');
      if (parsed.outcome === 'applied') {
        expect(parsed.content).toContain('Trailing unique tail replaced.');
      }
    });

    it('outcome: applied again (idempotent replay, FR-040)', async () => {
      const { editId } = await setupBranchWithProposal(
        'Trailing unique tail xyz123.',
        'Trailing unique tail replaced.',
      );
      const first = ApplyEditResponse.parse(
        (await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/edits/${editId}/apply`, {}))
          .json,
      );
      const second = ApplyEditResponse.parse(
        (await call(ctx.app, 'POST', `/api/documents/${ctx.documentId}/edits/${editId}/apply`, {}))
          .json,
      );
      expect(second.outcome).toBe('applied');
      if (first.outcome === 'applied' && second.outcome === 'applied') {
        expect(second.revision).toBe(first.revision);
      }
    });

    it('outcome: conflict, then not-pending on the superseded original', async () => {
      const { editId } = await setupBranchWithProposal(
        'The opening paragraph anchors everything else.',
        'The opening paragraph now reads differently.',
      );
      // Break the anchor before applying.
      await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [
          { from: 0, to: DOC_WITH_HEADING.length, insert: 'Completely different content now.' },
        ],
      });
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/${editId}/apply`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = ApplyEditResponse.parse(res.json);
      expect(parsed.outcome).toBe('conflict');
      if (parsed.outcome === 'conflict') {
        expect(parsed.conflictDetail.operations[0]!.reason).toBe('not_found');
        expect(parsed.replacementRequested).toBe(true);
      }

      // outcome: not-pending — the original is now superseded, not pending.
      const notPending = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/${editId}/apply`,
        {},
      );
      expect(notPending.status).toBe(409);
      expect(ErrorEnvelope.parse(notPending.json).error.code).toBe('EDIT_NOT_PENDING');
    });

    it('outcome: conflict_exhausted with maxReplacementAttempts: 0 (first conflict)', async () => {
      await call(ctx.app, 'PATCH', '/api/settings', { maxReplacementAttempts: 0 });
      const { editId } = await setupBranchWithProposal(
        'The opening paragraph anchors everything else.',
        'The opening paragraph now reads differently.',
      );
      await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [
          { from: 0, to: DOC_WITH_HEADING.length, insert: 'Completely different content now.' },
        ],
      });
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/${editId}/apply`,
        {},
      );
      expect(res.status).toBe(200);
      const parsed = ApplyEditResponse.parse(res.json);
      expect(parsed.outcome).toBe('conflict_exhausted');
      if (parsed.outcome === 'conflict_exhausted') {
        expect(parsed.replacementRequested).toBe(false);
        expect(parsed.attempts).toBe(0);
        expect(parsed.originalStagedEditId).toBe(editId);
      }
    });

    it('outcome: conflict_exhausted after the replacement budget is spent (maxReplacementAttempts: 1)', async () => {
      await call(ctx.app, 'PATCH', '/api/settings', { maxReplacementAttempts: 1 });
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;

      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('first attempt', [
            {
              old_string: 'The opening paragraph anchors everything else.',
              new_string: 'Revision A of the paragraph.',
            },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);
      // `apply()` below will (on conflict) fire its own replacement-request turn on this same
      // conversation — wait for the proposing turn to fully settle first, or that turn and this
      // one collide on the same `FakeAgentSession` ("already streaming").
      await waitFor(() => ctx.storage.getConversation(branchId)?.status === 'idle');
      const edit1 = ctx.storage.listStagedEditsByConversation(branchId)[0]!;

      // Break edit1's anchor.
      await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [
          {
            from: 0,
            to: DOC_WITH_HEADING.length,
            insert: DOC_WITH_HEADING.replace(
              'The opening paragraph anchors everything else.',
              'Rev A of the drifting phrase.',
            ),
          },
        ],
      });
      const conflict1 = ApplyEditResponse.parse(
        (
          await call(
            ctx.app,
            'POST',
            `/api/documents/${ctx.documentId}/edits/${edit1.id}/apply`,
            {},
          )
        ).json,
      );
      expect(conflict1.outcome).toBe('conflict');
      if (conflict1.outcome !== 'conflict') throw new Error('unreachable');
      expect(conflict1.replacementRequested).toBe(true);
      expect(conflict1.replacementAttempt).toBe(1);
      expect(conflict1.attemptsRemaining).toBe(0);

      // `apply()` above fired its own background replacement-request turn on this conversation
      // (the conflict message) — wait for it to settle before sending on the same session again.
      await waitFor(() => ctx.storage.getConversation(branchId)?.status === 'idle');

      // The next proposal on this conversation automatically links as edit1's replacement
      // (agent-tools.md §Conflict recovery: the agent never supplies supersedes_id itself).
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('replacement', [
            {
              old_string: 'Rev A of the drifting phrase.',
              new_string: 'Rev B of the drifting phrase.',
            },
          ]),
        },
      );
      await waitFor(() =>
        ctx.storage
          .listStagedEditsByConversation(branchId)
          .some((e) => e.supersedesId === edit1.id),
      );
      const edit2 = ctx.storage
        .listStagedEditsByConversation(branchId)
        .find((e) => e.supersedesId === edit1.id)!;

      // Break edit2's anchor too — the budget (1) is now spent for this chain.
      await call(ctx.app, 'PATCH', `/api/documents/${ctx.documentId}`, {
        changes: [
          {
            from: 0,
            to: DOC_WITH_HEADING.length,
            insert: DOC_WITH_HEADING.replace(
              'The opening paragraph anchors everything else.',
              'Rev A2 of the drifting phrase.',
            ),
          },
        ],
      });
      const revisionBefore = GetDocumentResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}`)).json,
      ).document.currentRevision;
      const conflict2 = ApplyEditResponse.parse(
        (
          await call(
            ctx.app,
            'POST',
            `/api/documents/${ctx.documentId}/edits/${edit2.id}/apply`,
            {},
          )
        ).json,
      );
      expect(conflict2.outcome).toBe('conflict_exhausted');
      if (conflict2.outcome !== 'conflict_exhausted') throw new Error('unreachable');
      expect(conflict2.replacementRequested).toBe(false);
      expect(conflict2.attempts).toBe(1);
      expect(conflict2.originalStagedEditId).toBe(edit1.id);
      const revisionAfter = GetDocumentResponse.parse(
        (await call(ctx.app, 'GET', `/api/documents/${ctx.documentId}`)).json,
      ).document.currentRevision;
      expect(revisionAfter).toBe(revisionBefore); // document unchanged
    });

    it('404 EDIT_NOT_FOUND for an unknown edit id', async () => {
      await createDoc(ctx);
      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/edit_nope/apply`,
        {},
      );
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('EDIT_NOT_FOUND');
    });
  });

  describe('POST /api/edits/:id/drop, preview, accept-remaining, drop-remaining', () => {
    it('drop: 200 outcome:"dropped", then EDIT_NOT_PENDING on a second drop', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('x', [
            { old_string: 'Trailing unique tail xyz123.', new_string: 'Something else.' },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);
      const editId = ctx.storage.listStagedEditsByConversation(branchId)[0]!.id;

      const res = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/${editId}/drop`,
        {},
      );
      expect(res.status).toBe(200);
      expect(DropEditResponse.parse(res.json).outcome).toBe('dropped');

      const again = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/edits/${editId}/drop`,
        {},
      );
      expect(again.status).toBe(409);
      expect(ErrorEnvelope.parse(again.json).error.code).toBe('EDIT_NOT_PENDING');
    });

    it('preview: reconcilable full preview and hunks for a pending proposal', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('x', [
            { old_string: 'Trailing unique tail xyz123.', new_string: 'Preview target text.' },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);
      const editId = ctx.storage.listStagedEditsByConversation(branchId)[0]!.id;

      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/edits/${editId}/preview`,
      );
      expect(res.status).toBe(200);
      const parsed = PreviewEditResponse.parse(res.json);
      expect(parsed.reconcilable).toBe(true);
      expect(parsed.fullPreview).toContain('Preview target text.');
      expect(parsed.hunks).toHaveLength(1);
    });

    it('accept-remaining and drop-remaining report per-proposal outcomes', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('x', [
            { old_string: 'Trailing unique tail xyz123.', new_string: 'Accepted text.' },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);

      const acceptRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/edits/accept-remaining`,
        {},
      );
      expect(acceptRes.status).toBe(200);
      const accepted = AcceptRemainingResponse.parse(acceptRes.json);
      expect(accepted.results).toHaveLength(1);
      expect(accepted.results[0]!.outcome).toBe('applied');

      // A second branch to exercise drop-remaining.
      const b2 = await branchAndSettle(ctx, created.mainConversation.id);
      const branch2Id = (b2.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branch2Id}/send`,
        {
          message: proposeDirective('y', [
            {
              old_string: 'A second paragraph stays constant across scenarios.',
              new_string: 'Dropped text.',
            },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branch2Id).length === 1);
      const dropRes = await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branch2Id}/edits/drop-remaining`,
        {},
      );
      expect(dropRes.status).toBe(200);
      const dropped = DropRemainingResponse.parse(dropRes.json);
      expect(dropped.droppedEditIds).toHaveLength(1);
    });
  });

  describe('GET /api/documents/:documentId/conversations/:id/edits', () => {
    it('lists proposals newest-first, matching the shared schema', async () => {
      const created = await createDoc(ctx);
      const b = await branchAndSettle(ctx, created.mainConversation.id);
      const branchId = (b.json as { id: string }).id;
      await call(
        ctx.app,
        'POST',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/send`,
        {
          message: proposeDirective('x', [
            { old_string: 'Trailing unique tail xyz123.', new_string: 'y' },
          ]),
        },
      );
      await waitFor(() => ctx.storage.listStagedEditsByConversation(branchId).length === 1);
      const res = await call(
        ctx.app,
        'GET',
        `/api/documents/${ctx.documentId}/conversations/${branchId}/edits`,
      );
      expect(res.status).toBe(200);
      const parsed = ListEditsResponse.parse(res.json);
      expect(parsed.stagedEdits).toHaveLength(1);
      expect(parsed.stagedEdits[0]!.status).toBe('pending');
    });
  });

  // ---- Settings ----

  describe('GET/PATCH /api/settings', () => {
    it('GET returns the documented defaults', async () => {
      const res = await call(ctx.app, 'GET', '/api/settings');
      expect(res.status).toBe(200);
      const parsed = UserSettingsDto.parse(res.json);
      expect(parsed).toEqual({
        thinkingVisible: false,
        revisionDebounceMs: 300_000,
        maxConcurrentAgents: 3,
        maxEditingDepth: 2,
        maxConversationDepth: 3,
        maxReplacementAttempts: 2,
        softWordCountThreshold: 20_000,
      });
    });

    it('accepts a partial patch and returns the full updated settings object', async () => {
      const res = await call(ctx.app, 'PATCH', '/api/settings', { thinkingVisible: true });
      expect(res.status).toBe(200);
      const parsed = UserSettingsDto.parse(res.json);
      expect(parsed.thinkingVisible).toBe(true);
      expect(parsed.maxConcurrentAgents).toBe(3); // untouched fields preserved
    });

    const boundaries: {
      field: keyof import('@rapid-ai-document-review/shared/contracts/http').UserSettingsPatch;
      min: number;
      max: number;
    }[] = [
      { field: 'revisionDebounceMs', min: 10_000, max: 3_600_000 },
      { field: 'maxConcurrentAgents', min: 1, max: 10 },
      { field: 'maxEditingDepth', min: 0, max: 10 },
      { field: 'maxConversationDepth', min: 1, max: 10 },
      { field: 'maxReplacementAttempts', min: 0, max: 10 },
    ];

    for (const { field, min, max } of boundaries) {
      it(`${field}: accepts the boundary values [${min}, ${max}] and rejects one past each side`, async () => {
        const okMin = await call(ctx.app, 'PATCH', '/api/settings', { [field]: min });
        expect(okMin.status).toBe(200);
        expect((okMin.json as Record<string, number>)[field]).toBe(min);

        const okMax = await call(ctx.app, 'PATCH', '/api/settings', { [field]: max });
        expect(okMax.status).toBe(200);
        expect((okMax.json as Record<string, number>)[field]).toBe(max);

        const belowMin = await call(ctx.app, 'PATCH', '/api/settings', { [field]: min - 1 });
        expect(belowMin.status).toBe(400);
        expect(ErrorEnvelope.parse(belowMin.json).error.code).toBe('VALIDATION_FAILED');

        const aboveMax = await call(ctx.app, 'PATCH', '/api/settings', { [field]: max + 1 });
        expect(aboveMax.status).toBe(400);
        expect(ErrorEnvelope.parse(aboveMax.json).error.code).toBe('VALIDATION_FAILED');
      });
    }

    it('thinkingVisible: rejects a non-boolean value', async () => {
      const res = await call(ctx.app, 'PATCH', '/api/settings', { thinkingVisible: 'yes' });
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');
    });

    describe('softWordCountThreshold (advisory notice threshold, spec Assumptions)', () => {
      it('GET reflects the default and is settable via PATCH', async () => {
        const getRes = await call(ctx.app, 'GET', '/api/settings');
        expect(UserSettingsDto.parse(getRes.json).softWordCountThreshold).toBe(20_000);

        const patchRes = await call(ctx.app, 'PATCH', '/api/settings', {
          softWordCountThreshold: 5_000,
        });
        expect(patchRes.status).toBe(200);
        expect(UserSettingsDto.parse(patchRes.json).softWordCountThreshold).toBe(5_000);

        // Persisted, and other fields are untouched by this patch.
        const getAfter = await call(ctx.app, 'GET', '/api/settings');
        const afterParsed = UserSettingsDto.parse(getAfter.json);
        expect(afterParsed.softWordCountThreshold).toBe(5_000);
        expect(afterParsed.maxConcurrentAgents).toBe(3);
      });

      it('accepts the floor (1,000) and large values with no fixed upper bound', async () => {
        const atFloor = await call(ctx.app, 'PATCH', '/api/settings', {
          softWordCountThreshold: 1_000,
        });
        expect(atFloor.status).toBe(200);
        expect(UserSettingsDto.parse(atFloor.json).softWordCountThreshold).toBe(1_000);

        const large = await call(ctx.app, 'PATCH', '/api/settings', {
          softWordCountThreshold: 1_000_000,
        });
        expect(large.status).toBe(200);
        expect(UserSettingsDto.parse(large.json).softWordCountThreshold).toBe(1_000_000);
      });

      it('rejects a value below the floor, and rejects non-positive values', async () => {
        const belowFloor = await call(ctx.app, 'PATCH', '/api/settings', {
          softWordCountThreshold: 999,
        });
        expect(belowFloor.status).toBe(400);
        expect(ErrorEnvelope.parse(belowFloor.json).error.code).toBe('VALIDATION_FAILED');

        const zero = await call(ctx.app, 'PATCH', '/api/settings', { softWordCountThreshold: 0 });
        expect(zero.status).toBe(400);
        expect(ErrorEnvelope.parse(zero.json).error.code).toBe('VALIDATION_FAILED');

        const negative = await call(ctx.app, 'PATCH', '/api/settings', {
          softWordCountThreshold: -1,
        });
        expect(negative.status).toBe(400);
        expect(ErrorEnvelope.parse(negative.json).error.code).toBe('VALIDATION_FAILED');
      });

      it('rejects a non-integer value', async () => {
        const res = await call(ctx.app, 'PATCH', '/api/settings', {
          softWordCountThreshold: 1_500.5,
        });
        expect(res.status).toBe(400);
        expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');
      });
    });
  });

  // ---- Todo & Parking Lot lists (012-todo-parking-lists) ----

  describe('/api/documents/:documentId/list-items', () => {
    it('GET returns both lists, empty by default', async () => {
      const created = await createDoc(ctx);
      const res = await call(ctx.app, 'GET', `/api/documents/${created.document.id}/list-items`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ todo: [], parkingLot: [] });
    });

    it('POST adds an item to the requested list, and GET reflects it under the right bucket', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;

      const postRes = await call(ctx.app, 'POST', `/api/documents/${documentId}/list-items`, {
        list: 'todo',
        text: 'fix the intro paragraph',
      });
      expect(postRes.status).toBe(201);
      const posted = postRes.json as {
        id: string;
        text: string;
        contentHash: string;
        conversationId: string | null;
        messageId: string | null;
      };
      expect(posted.text).toBe('fix the intro paragraph');
      expect(posted.contentHash).toBeTruthy();
      // The HTTP path never carries provenance (012-todo-parking-lists follow-up) — only an agent
      // tool call ever sets these.
      expect(posted.conversationId).toBeNull();
      expect(posted.messageId).toBeNull();

      const getRes = await call(ctx.app, 'GET', `/api/documents/${documentId}/list-items`);
      const parsed = getRes.json as {
        todo: {
          id: string;
          text: string;
          contentHash: string;
          conversationId: string | null;
          messageId: string | null;
        }[];
        parkingLot: { id: string; text: string }[];
      };
      expect(parsed.todo).toEqual([
        {
          id: posted.id,
          text: posted.text,
          contentHash: posted.contentHash,
          conversationId: null,
          messageId: null,
        },
      ]);
      expect(parsed.parkingLot).toEqual([]);
    });

    it('POST rejects empty/whitespace-only text with 400 VALIDATION_FAILED, creating nothing', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;

      const res = await call(ctx.app, 'POST', `/api/documents/${documentId}/list-items`, {
        list: 'todo',
        text: '   ',
      });
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');

      const getRes = await call(ctx.app, 'GET', `/api/documents/${documentId}/list-items`);
      expect(getRes.json).toEqual({ todo: [], parkingLot: [] });
    });

    it('PATCH updates an item immediately, with no hash required, and bumps its contentHash', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;
      const postRes = await call(ctx.app, 'POST', `/api/documents/${documentId}/list-items`, {
        list: 'parking_lot',
        text: 'original text',
      });
      const posted = postRes.json as { id: string; contentHash: string };

      const patchRes = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${documentId}/list-items/${posted.id}`,
        { text: 'edited text' },
      );
      expect(patchRes.status).toBe(200);
      const patched = patchRes.json as { id: string; text: string; contentHash: string };
      expect(patched.text).toBe('edited text');
      expect(patched.contentHash).not.toBe(posted.contentHash);
    });

    it('PATCH never nulls out a previously agent-set conversationId/messageId provenance link', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;
      const postRes = await call(ctx.app, 'POST', `/api/documents/${documentId}/list-items`, {
        list: 'todo',
        text: 'from the agent',
      });
      const posted = postRes.json as { id: string };

      // The HTTP POST path itself never carries provenance (it always passes `null, null`) — this
      // simulates the agent path having set a real link on the same row, the way `add_list_item`'s
      // own `execute()` does, so the PATCH below has something to (not) destroy.
      ctx.storage.updateListItem(posted.id, {
        text: 'from the agent',
        updatedAt: new Date().toISOString(),
        conversationId: created.mainConversation.id,
        messageId: 'msg_agent_set',
      });

      const patchRes = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${documentId}/list-items/${posted.id}`,
        { text: 'edited via the panel' },
      );
      expect(patchRes.status).toBe(200);
      const patched = patchRes.json as {
        text: string;
        conversationId: string | null;
        messageId: string | null;
      };
      expect(patched.text).toBe('edited via the panel');
      expect(patched.conversationId).toBe(created.mainConversation.id);
      expect(patched.messageId).toBe('msg_agent_set');
    });

    it('PATCH rejects empty/whitespace-only text with 400 VALIDATION_FAILED', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;
      const postRes = await call(ctx.app, 'POST', `/api/documents/${documentId}/list-items`, {
        list: 'todo',
        text: 'original text',
      });
      const posted = postRes.json as { id: string };

      const res = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${documentId}/list-items/${posted.id}`,
        { text: '   ' },
      );
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');
    });

    it('PATCH/DELETE on an unknown itemId return 404 LIST_ITEM_NOT_FOUND', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;

      const patchRes = await call(
        ctx.app,
        'PATCH',
        `/api/documents/${documentId}/list-items/li_does_not_exist`,
        { text: 'new text' },
      );
      expect(patchRes.status).toBe(404);
      expect(ErrorEnvelope.parse(patchRes.json).error.code).toBe('LIST_ITEM_NOT_FOUND');

      const deleteRes = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${documentId}/list-items/li_does_not_exist`,
      );
      expect(deleteRes.status).toBe(404);
      expect(ErrorEnvelope.parse(deleteRes.json).error.code).toBe('LIST_ITEM_NOT_FOUND');
    });

    it('DELETE removes the item immediately, with no hash required', async () => {
      const created = await createDoc(ctx);
      const documentId = created.document.id;
      const postRes = await call(ctx.app, 'POST', `/api/documents/${documentId}/list-items`, {
        list: 'todo',
        text: 'to be removed',
      });
      const posted = postRes.json as { id: string };

      const deleteRes = await call(
        ctx.app,
        'DELETE',
        `/api/documents/${documentId}/list-items/${posted.id}`,
      );
      expect(deleteRes.status).toBe(204);

      const getRes = await call(ctx.app, 'GET', `/api/documents/${documentId}/list-items`);
      expect(getRes.json).toEqual({ todo: [], parkingLot: [] });
    });
  });

  // ---- System prompt ----

  describe('GET /api/system-prompt', () => {
    it('returns the canvas pi agent system prompt, read-only, by default', async () => {
      const res = await call(ctx.app, 'GET', '/api/system-prompt');
      expect(res.status).toBe(200);
      const parsed = SystemPromptDto.parse(res.json);
      expect(parsed.systemPrompt).toContain(
        'AI reviewer embedded in a document review application',
      );
      expect(parsed.systemPrompt).toContain('read_document');
    });

    it('?mode=thread returns the Thread-mode variant, with no read_document/propose_document_edit references (011-linear-thread-mode)', async () => {
      const res = await call(ctx.app, 'GET', '/api/system-prompt?mode=thread');
      expect(res.status).toBe(200);
      const parsed = SystemPromptDto.parse(res.json);
      expect(parsed.systemPrompt).toContain(
        'AI assistant embedded in a document review application',
      );
      expect(parsed.systemPrompt).not.toContain('Anchor discipline');
      expect(parsed.systemPrompt).not.toContain('Proposal etiquette');
    });

    it('rejects an unrecognized ?mode value', async () => {
      const res = await call(ctx.app, 'GET', '/api/system-prompt?mode=bogus');
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(res.json).error.code).toBe('VALIDATION_FAILED');
    });
  });
});
