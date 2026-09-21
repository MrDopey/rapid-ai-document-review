import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CloseConversationResponse,
  ConversationDto,
  CreateDocumentResponse,
  GetConversationResponse,
  ListConversationsResponse,
  ListRevisionsResponse,
  SendMessageResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import { waitFor } from '../contract/test-app.js';

/**
 * specs/006-archivable-main-conversation, T014 (US1): archiving Main against a real SQLite file
 * (not `:memory:`) atomically closes the old Main and replaces it with a fresh, seeded, current
 * Main in the same slot — the document must never observably have zero or more than one
 * `isCurrentMain` conversation. Not yet implemented: `ConversationService.close()` still refuses to
 * close a `kind === 'main'` conversation outright (`CannotCloseMainConversationError`), so the
 * assertions below are expected to fail until `archiveMain()` (T020-T022) lands.
 *
 * Mirrors `restart.test.ts`'s real-file-database convention (a fresh temp-directory SQLite file per
 * test, booted through the real `buildApp()`/`server.ts` wiring with `RADR_BE_PI_FAKE_SESSIONS=1`)
 * rather than the `:memory:` harness other integration suites use — needed here specifically to
 * exercise `StorageAdapter.transaction()`'s real atomicity guarantees against on-disk SQLite, not an
 * in-memory connection.
 */

async function bootApp(
  databasePath: string,
): Promise<{ app: FastifyInstance; storage: StorageAdapter }> {
  process.env.RADR_BE_DATABASE_PATH = databasePath;
  process.env.RADR_BE_PI_FAKE_SESSIONS = '1';
  process.env.RADR_BE_HOST ??= '127.0.0.1';
  process.env.RADR_BE_LOG_LEVEL ??= 'silent';
  process.env.RADR_BE_PI_SESSION_STORAGE_PATH ??= './data/main-archive-test-pi-sessions';
  process.env.RADR_BE_PI_CODING_AGENT_DIR ??= './data/main-archive-test-pi-agent';
  process.env.RADR_BE_PI_AGENT_MODEL ??= 'anthropic/claude-opus-4-5';
  // `config.ts` (`app/backend/src/config.ts`) is a top-level `const` built once from `process.env`
  // at module-evaluation time, and this file now calls `bootApp()` more than once (US1, US2, US3 —
  // each wants its own genuinely fresh, isolated on-disk SQLite file). A plain `import('../../src/
  // server.js')` is cached by Node/Vitest's module registry, so every call after the first would
  // silently reuse the *first* call's frozen `config.databasePath` instead of the one just set above
  // — see `restart.test.ts`'s own comment on this exact constraint, which sidesteps it by reusing
  // one shared database across sequential `boot1/boot2/boot3` calls inside a single `it()` rather
  // than needing independent ones. `vi.resetModules()` forces Vitest's module registry to
  // re-evaluate `config.ts` (and everything that transitively imports it) fresh on every call, so
  // each `bootApp()` genuinely picks up the `RADR_BE_DATABASE_PATH` just assigned above.
  vi.resetModules();
  const { buildApp } = await import('../../src/server.js');
  return buildApp();
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH',
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

const DOC_CONTENT = [
  '# Main Archive Fixture',
  '',
  'The opening paragraph anchors everything else.',
  '',
  'A second paragraph stays constant across every scenario below.',
].join('\n');

describe('main-archive (specs/006-archivable-main-conversation, US1)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('atomically closes the old Main and replaces it with a fresh, current, seeded Main — exactly one isCurrentMain row before and after, never zero or more than one', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'main-archive-test-'));
    const databasePath = join(tmpDir, 'document-review.sqlite');
    const { app, storage } = await bootApp(databasePath);

    const createRes = await call(app, 'POST', '/api/documents', {
      title: 'Main Archive Fixture',
      content: DOC_CONTENT,
    });
    expect(createRes.status).toBe(201);
    const created = CreateDocumentResponse.parse(createRes.json);
    const documentId = created.document.id;
    const oldMainId = created.mainConversation.id;
    await waitFor(() => storage.getConversation(oldMainId)?.status === 'idle');

    // ---- Before archiving: exactly one isCurrentMain=true row, and it's the original Main. ----
    const beforeList = ListConversationsResponse.parse(
      (await call(app, 'GET', `/api/documents/${documentId}/conversations`)).json,
    );
    const beforeCurrentMains = beforeList.conversations.filter((c) => c.isCurrentMain);
    expect(beforeCurrentMains).toHaveLength(1);
    expect(beforeCurrentMains[0]!.id).toBe(oldMainId);

    // ---- Archive: closing the current Main is the archive-and-replace operation (US1). ----
    const closeRes = await call(
      app,
      'POST',
      `/api/documents/${documentId}/conversations/${oldMainId}/close`,
      {},
    );
    expect(closeRes.status).toBe(200);
    expect(CloseConversationResponse.parse(closeRes.json).status).toBe('closed');

    // ---- Immediately after: still exactly one isCurrentMain=true row — never zero, never more
    // than one — and it is a brand-new conversation, not the one just archived. ----
    const afterList = ListConversationsResponse.parse(
      (await call(app, 'GET', `/api/documents/${documentId}/conversations`)).json,
    );
    const afterCurrentMains = afterList.conversations.filter((c) => c.isCurrentMain);
    expect(afterCurrentMains).toHaveLength(1);
    const newMain = afterCurrentMains[0]!;
    expect(newMain.id).not.toBe(oldMainId);

    // ---- The old Main: closed, no longer current. ----
    const oldMain = storage.getConversation(oldMainId)!;
    expect(oldMain.status).toBe('closed');
    expect(oldMain.isCurrentMain).toBe(false);

    // ---- The new Main: current, kind main, never Primary, no parent (a fresh top-level Main). ----
    expect(newMain.kind).toBe('main');
    expect(newMain.isCurrentMain).toBe(true);
    expect(newMain.isPrimary).toBe(false);
    expect(newMain.parentId).toBeNull();

    // ---- Seeded with a message reflecting the document's current content (mirrors
    // `seed-excerpt.test.ts`'s `buildMainSeedMessage` assertions: the wrapped
    // `<document-revision-N>` block plus the literal document content). ----
    await waitFor(
      () =>
        storage
          .listEventsSince(documentId, null)
          .some((e) => e.conversationId === newMain.id && e.eventType === 'message_completed'),
      { message: "expected the new Main's seed message to be recorded" },
    );
    const detailRes = await call(
      app,
      'GET',
      `/api/documents/${documentId}/conversations/${newMain.id}`,
    );
    expect(detailRes.status).toBe(200);
    const detail = GetConversationResponse.parse(detailRes.json);
    expect(detail.messages.length).toBeGreaterThan(0);
    const seed = detail.messages[0]!;
    expect(seed.role).toBe('user');
    expect(seed.text).toContain(DOC_CONTENT);
    expect(seed.text).toContain(`<document-revision-${created.document.currentRevision}>`);
  });
});

/**
 * specs/006-archivable-main-conversation, T026 (US3): an auto-applied edit's revision keeps
 * recording its originating (now-archived) Main's `conversationId`, and `GET /api/revisions`
 * keeps resolving that id to a `conversationName` after the Main that produced it has been
 * archived. Per this feature's plan.md/research.md, `Revision.conversationId` is set once at
 * staged-edit-creation time and is never rewritten by `archiveMain()` — this is expected to PASS
 * with zero implementation changes, proving attribution survives archiving unchanged.
 *
 * Mirrors `http.test.ts`'s `PROPOSE_EDIT_DIRECTIVE` convention (a specially-prefixed message text
 * drives the real `FakeAgentSession` to actually invoke `propose_document_edit`) and its "Main is
 * Primary by default" comment (`DocumentService.create` sets `isPrimary: true` on the initial
 * Main — see `document-service.ts`), so a proposal sent to Main auto-applies immediately rather
 * than staying pending.
 */
const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';
function proposeDirective(
  summary: string,
  operations: { old_string: string; new_string: string }[],
): string {
  return PROPOSE_EDIT_DIRECTIVE + JSON.stringify({ summary, operations });
}

describe('main-archive — revision attribution survives archiving (specs/006-archivable-main-conversation, US3)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("an auto-applied edit's revision stays attributed (by conversationId and resolved conversationName) to its originating Main even after that Main is archived", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'main-archive-attribution-test-'));
    const databasePath = join(tmpDir, 'document-review.sqlite');
    const { app, storage } = await bootApp(databasePath);

    const createRes = await call(app, 'POST', '/api/documents', {
      title: 'Main Archive Fixture',
      content: DOC_CONTENT,
    });
    expect(createRes.status).toBe(201);
    const created = CreateDocumentResponse.parse(createRes.json);
    const oldMainId = created.mainConversation.id;
    await waitFor(() => storage.getConversation(oldMainId)?.status === 'idle');

    // ---- Main is Primary by default, so this proposal auto-applies immediately rather than
    // staying pending, producing a revision attributed to Main (conversationId = oldMainId). ----
    const beforeRevision = created.document.currentRevision;
    await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${oldMainId}/send`,
      {
        message: proposeDirective('auto-apply for attribution test', [
          {
            old_string: 'The opening paragraph anchors everything else.',
            new_string: 'Edited paragraph.',
          },
        ]),
      },
    );
    const afterAutoApplyRevision = beforeRevision + 1;
    await waitFor(
      () => storage.getDocument(created.document.id)?.currentRevision === afterAutoApplyRevision,
    );
    await waitFor(() => storage.getConversation(oldMainId)?.status === 'idle');

    // ---- Before archiving: the auto-applied edit's revision is attributed to (still-current)
    // Main, by id and by resolved name. ----
    const beforeRes = await call(app, 'GET', `/api/documents/${created.document.id}/revisions`);
    expect(beforeRes.status).toBe(200);
    const beforeRevisions = ListRevisionsResponse.parse(beforeRes.json).revisions;
    const autoAppliedBefore = beforeRevisions.find((r) => r.revision === afterAutoApplyRevision)!;
    expect(autoAppliedBefore).toBeTruthy();
    expect(autoAppliedBefore.autoApplied).toBe(true);
    expect(autoAppliedBefore.conversationId).toBe(oldMainId);
    expect(autoAppliedBefore.conversationName).toBe('Main');

    // ---- Archive Main (close it) — this replaces it with a fresh current Main in the same slot. ----
    const closeRes = await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${oldMainId}/close`,
      {},
    );
    expect(closeRes.status).toBe(200);
    expect(CloseConversationResponse.parse(closeRes.json).status).toBe('closed');
    expect(storage.getConversation(oldMainId)!.status).toBe('closed');
    expect(storage.getConversation(oldMainId)!.isCurrentMain).toBe(false);

    // ---- After archiving: the same revision is still attributed to the same (now-archived)
    // conversationId, and the name still resolves (both old and new Main are named "Main", so this
    // also proves the lookup is genuinely keyed by conversationId, not by an "is this the current
    // Main" special case). ----
    const afterRes = await call(app, 'GET', `/api/documents/${created.document.id}/revisions`);
    expect(afterRes.status).toBe(200);
    const afterRevisions = ListRevisionsResponse.parse(afterRes.json).revisions;
    const autoAppliedAfter = afterRevisions.find((r) => r.revision === afterAutoApplyRevision)!;
    expect(autoAppliedAfter).toBeTruthy();
    expect(autoAppliedAfter.conversationId).toBe(oldMainId);
    expect(autoAppliedAfter.conversationName).toBe('Main');
  });
});

/**
 * specs/006-archivable-main-conversation, T024 (US2): a conversation branched from Main keeps
 * working normally — and keeps its historical `parentId` link — after that Main is archived.
 * No production code change is expected here: `Conversation.parentId` is never rewritten by a
 * close, and the branch-to-parent lookup is a live read of the (never-deleted) parent conversation
 * row, so this is a pure characterization test of already-implemented US1 behaviour
 * (quickstart.md Scenario 2).
 */
describe('main-archive (specs/006-archivable-main-conversation, US2 — branch survival)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a branch's status, message-sending, and further-branchability all survive its parent Main's archival", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'main-archive-branch-test-'));
    const databasePath = join(tmpDir, 'document-review.sqlite');
    const { app, storage } = await bootApp(databasePath);

    const createRes = await call(app, 'POST', '/api/documents', {
      title: 'Branch Survival Fixture',
      content: DOC_CONTENT,
    });
    expect(createRes.status).toBe(201);
    const created = CreateDocumentResponse.parse(createRes.json);
    const mainId = created.mainConversation.id;
    await waitFor(() => storage.getConversation(mainId)?.status === 'idle');

    // ---- Branch off Main via the sidebar "Branch this conversation" path (no `selection`) — no
    // seed message is sent on this path, so the branch is already `idle` right after creation,
    // same as the plain-branch contract-test convention (`branch()`/`branchAndSettle` in
    // http.test.ts) minus the wait these don't need here. ----
    const branchRes = await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations`,
      {
        parentConversationId: mainId,
      },
    );
    expect(branchRes.status).toBe(201);
    const branch = ConversationDto.parse(branchRes.json);
    expect(branch.parentId).toBe(mainId);
    expect(branch.branchDepth).toBe(1);
    await waitFor(() => storage.getConversation(branch.id)?.status === 'idle');
    const statusBeforeArchive = storage.getConversation(branch.id)!.status;

    // ---- Archive Main (US1's close-and-replace). ----
    const closeRes = await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${mainId}/close`,
      {},
    );
    expect(closeRes.status).toBe(200);
    expect(CloseConversationResponse.parse(closeRes.json).status).toBe('closed');
    const archivedMain = storage.getConversation(mainId)!;
    expect(archivedMain.status).toBe('closed');
    expect(archivedMain.isCurrentMain).toBe(false);

    // ---- The branch's own status is unaffected by its parent's archival. ----
    const branchAfterArchive = storage.getConversation(branch.id)!;
    expect(branchAfterArchive.status).toBe(statusBeforeArchive);
    // ---- `parentId` is never rewritten — the branch still points at the now-archived Main. ----
    expect(branchAfterArchive.parentId).toBe(mainId);

    // ---- The branch still accepts a new message (doesn't throw/reject due to its parent being
    // archived — same 202/accepted shape as the plain-Main case in http.test.ts). ----
    const sendRes = await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${branch.id}/send`,
      {
        message: 'Still alive after Main archived?',
      },
    );
    expect(sendRes.status).toBe(202);
    const sendParsed = SendMessageResponse.parse(sendRes.json);
    expect(sendParsed.accepted).toBe(true);
    await waitFor(() => storage.getConversation(branch.id)?.status === 'idle');

    // ---- The branch can still be branched from again, subject to `maxConversationDepth` (default
    // 3 — data-model.md/settings default in `app/shared/src/domain/index.ts`). One more level
    // (branchDepth 1 -> 2) stays comfortably under that limit. ----
    const subBranchRes = await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations`,
      {
        parentConversationId: branch.id,
      },
    );
    expect(subBranchRes.status).toBe(201);
    const subBranch = ConversationDto.parse(subBranchRes.json);
    expect(subBranch.parentId).toBe(branch.id);
    expect(subBranch.branchDepth).toBe(2);
  });
});
