import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentResponse,
  GetConversationResponse,
  GetDocumentResponse,
  ListConversationsResponse,
  ListRevisionsResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import type { ConversationRow, StagedEditRow, StorageAdapter } from '../../src/storage/storage-adapter.js';
import { newId } from '../../src/ids.js';
import { waitFor } from '../contract/test-app.js';

/**
 * Integration coverage for restart recovery (FR-039/FR-039a), the scenario quickstart.md documents
 * under "Restart recovery" as `npm run test:integration -- --grep "restart"` — previously
 * unimplemented as a test despite the recovery logic itself living in `server.ts#buildApp`
 * (`documentService.loadIfExists()` + `conversationService.recoverInterruptedRuns()`).
 *
 * Unlike `tests/contract/test-app.ts`'s `createTestApp()` (`:memory:` SQLite, a brand-new database
 * per call), this suite needs state to survive a literal "restart": it points `RADR_BE_DATABASE_PATH` at a
 * real file in a temp directory and calls the exported `buildApp()` twice against that same file —
 * once to create state, once (after closing the first instance's connection) to simulate the
 * fresh-process boot that re-runs the recovery logic above. `config.ts` reads its env vars exactly
 * once per process, but that's harmless here because both boots use the very same `databasePath`.
 */

async function bootApp(databasePath: string): Promise<{ app: FastifyInstance; storage: StorageAdapter }> {
  process.env.RADR_BE_DATABASE_PATH = databasePath;
  process.env.RADR_BE_PI_FAKE_SESSIONS = '1';
  process.env.RADR_BE_HOST ??= '127.0.0.1';
  process.env.RADR_BE_LOG_LEVEL ??= 'silent';
  process.env.RADR_BE_PI_SESSION_STORAGE_PATH ??= './data/restart-test-pi-sessions';
  process.env.RADR_BE_PI_CODING_AGENT_DIR ??= './data/restart-test-pi-agent';
  process.env.RADR_BE_PI_AGENT_MODEL ??= 'anthropic/claude-opus-4-5';
  // Same test-only seam `test-app.ts`'s harness leaves for e2e specs: makes the manual-edit
  // debounce (default 300000ms, migrations.ts) observably fast so this test doesn't need to wait
  // minutes for the second revision to land.
  process.env.RADR_BE_E2E_SEED_REVISION_DEBOUNCE_MS ??= '20';
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

/** Bypasses `ConversationService.branch()` (no fire-and-forget seed message) — same seam
 *  `concurrency.test.ts`/`reconcile.test.ts` use to create a plain storage-level conversation row
 *  directly, which is all this suite needs to set up pre-restart conversation state. */
function createBranchConversation(
  storage: StorageAdapter,
  documentId: string,
  contextRevision: number,
  name: string,
): ConversationRow {
  const now = new Date().toISOString();
  const id = newId('conv');
  return storage.createConversation({
    id,
    documentId,
    parentId: null,
    name,
    kind: 'branch',
    piSessionPath: `/tmp/${id}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary: false,
    contextRevision,
    branchDepth: 1,
    seedSelection: null,
    forkedFromMessageId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
}

const DOC_CONTENT = [
  '# Restart Fixture',
  '',
  'The opening paragraph anchors everything else.',
  '',
  'A second paragraph stays constant across every scenario below.',
].join('\n');

describe('restart recovery (FR-039/FR-039a)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'restart-test-'));
  const databasePath = join(tmpDir, 'document-review.sqlite');

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recovers document content, revision history, interrupted conversation status, pending proposals, and Primary designation after a fresh boot against the same database file', async () => {
    // ---- Boot 1: create pre-restart state ----
    const boot1 = await bootApp(databasePath);
    const app1 = boot1.app;
    const storage1 = boot1.storage;

    const createRes = await call(app1, 'POST', '/api/document', {
      title: 'Restart Fixture',
      content: DOC_CONTENT,
    });
    expect(createRes.status).toBe(201);
    const created = CreateDocumentResponse.parse(createRes.json);
    const documentId = created.document.id;
    const mainConversationId = created.mainConversation.id;
    expect(created.document.currentRevision).toBe(1);
    // Main is Primary by default (ConversationService.ensureMain) — the baseline this test moves
    // Primary away from below, to prove the *moved* designation is what survives, not just the
    // default.
    expect(created.mainConversation.isPrimary).toBe(true);

    // Document creation fires a fire-and-forget seed message on Main (the document-injection
    // feature — `DocumentService.create` -> `ConversationService.seedMain`), on its own
    // `FakeAgentSession`. Wait for that turn to settle before this test closes `storage1` below —
    // otherwise the still-running turn's later event-bridge writes hit an already-closed database
    // (an unhandled rejection, not a real assertion failure, but one worth avoiding).
    await waitFor(() => storage1.getConversation(mainConversationId)?.status === 'idle');

    // A manual edit, debounced into revision 2 — exercises the real Automerge persistence path
    // (splice + snapshot/changes), not just a directly-poked DB row.
    const patchRes = await call(app1, 'PATCH', '/api/document', {
      baseRevision: created.document.currentRevision,
      changes: [{ from: 0, to: 0, insert: 'PREFIX ' }],
    });
    expect(patchRes.status).toBe(200);
    await waitFor(() => (storage1.getDocument()?.currentRevision ?? 0) >= 2, {
      message: 'manual-edit debounce revision never landed',
    });
    expect(storage1.getDocument()?.currentRevision).toBe(2);
    expect(storage1.getDocument()?.currentRevision).toBe(
      storage1.getLatestRevision(documentId)?.revision,
    );

    // A branch conversation holding a pending staged proposal that is never resolved before
    // "restart" — inserted directly via the storage adapter (no live agent run needed) since only
    // its persisted state, not the proposal pipeline itself, is what restart recovery touches.
    const proposalBranch = createBranchConversation(storage1, documentId, 2, 'Reviewer Branch');
    const stagedEdit: StagedEditRow = {
      id: newId('edit'),
      documentId,
      conversationId: proposalBranch.id,
      piToolCallId: 'tool_restart_1',
      sourceRevision: 2,
      summary: 'Proposed change that should survive a restart untouched',
      operations: [{ old_string: 'second paragraph', new_string: 'SECOND PARAGRAPH' }],
      status: 'pending',
      autoApplied: false,
      appliedRevision: null,
      supersedesId: null,
      conflictDetail: null,
      replacementAttempt: 0,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    storage1.createStagedEdit(stagedEdit);

    // A second conversation left mid-`working` when the process "stops" — simulating a run
    // interrupted by an unclean stop, per this suite's header comment.
    const interruptedBranch = createBranchConversation(storage1, documentId, 2, 'Interrupted Branch');
    storage1.updateConversation(interruptedBranch.id, { status: 'working' });
    expect(storage1.getConversation(interruptedBranch.id)?.status).toBe('working');

    // Move Primary off Main and onto the (idle) proposal branch, directly at the storage layer:
    // `PrimaryService.designate()`'s busy/mutex handling is orthogonal to what restart recovery
    // itself is responsible for — only the persisted `is_primary` flag needs to exist and survive.
    storage1.updateConversation(mainConversationId, { isPrimary: false });
    storage1.updateConversation(proposalBranch.id, { isPrimary: true });

    // "Restart": close this instance's connection, then boot a fresh app/service graph against the
    // exact same on-disk database file.
    storage1.close();
    await app1.close();

    // ---- Boot 2: fresh instance against the same file, re-running startup recovery ----
    const boot2 = await bootApp(databasePath);
    const app2 = boot2.app;
    const storage2 = boot2.storage;

    // Document content and current_revision are intact.
    const getDocRes = await call(app2, 'GET', '/api/document');
    expect(getDocRes.status).toBe(200);
    const getDoc = GetDocumentResponse.parse(getDocRes.json);
    expect(getDoc.document.id).toBe(documentId);
    expect(getDoc.document.currentRevision).toBe(2);
    expect(getDoc.content.startsWith('PREFIX ')).toBe(true);
    expect(getDoc.content).toContain('A second paragraph stays constant');

    // Revision history is intact.
    const revsRes = await call(app2, 'GET', '/api/revisions');
    expect(revsRes.status).toBe(200);
    const revs = ListRevisionsResponse.parse(revsRes.json);
    expect(revs.revisions.map((r) => r.revision).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(revs.revisions.find((r) => r.revision === 1)?.origin).toBe('creation');
    expect(revs.revisions.find((r) => r.revision === 2)?.origin).toBe('manual_debounce');

    // The conversation left `working` before "restart" is now `errored`, with the interruption
    // visible in its error message (FR-039a) — verified both at the storage layer directly...
    const interruptedRow = storage2.getConversation(interruptedBranch.id);
    expect(interruptedRow?.status).toBe('errored');
    expect(interruptedRow?.errorMessage).toBe('Interrupted by application restart');

    // ...and via a fresh client's GET /api/conversations resync (connected-client resync, in scope
    // at this basic level; full WS/e2e resync machinery is out of scope for this suite).
    const listRes = await call(app2, 'GET', '/api/conversations');
    expect(listRes.status).toBe(200);
    const list = ListConversationsResponse.parse(listRes.json);
    const interruptedDto = list.conversations.find((c) => c.id === interruptedBranch.id);
    expect(interruptedDto?.status).toBe('errored');
    expect(interruptedDto?.errorMessage).toBe('Interrupted by application restart');

    // The pending staged proposal's status is unchanged — still pending, not lost or silently
    // resolved by recovery.
    const getConvRes = await call(app2, 'GET', `/api/conversations/${proposalBranch.id}`);
    expect(getConvRes.status).toBe(200);
    const getConv = GetConversationResponse.parse(getConvRes.json);
    expect(getConv.stagedEdits).toHaveLength(1);
    expect(getConv.stagedEdits[0]).toMatchObject({
      id: stagedEdit.id,
      status: 'pending',
      summary: stagedEdit.summary,
    });

    // Primary designation survived the restart: still the proposal branch, not reset to Main.
    expect(getConv.conversation.isPrimary).toBe(true);
    const mainDto = list.conversations.find((c) => c.id === mainConversationId);
    expect(mainDto?.isPrimary).toBe(false);

    storage2.close();
    await app2.close();
  });
});
