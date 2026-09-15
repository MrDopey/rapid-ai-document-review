import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { AutomergeStoreHolder } from '../../src/document/automerge-store-holder.js';
import { RevisionService } from '../../src/document/revision-service.js';
import { DocumentService } from '../../src/document/document-service.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { TurnRunner } from '../../src/pi/turn-runner.js';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';
import { PiService } from '../../src/pi/pi-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { newId } from '../../src/ids.js';
import type {
  ConversationRow,
  StagedEditRow,
  StorageAdapter,
} from '../../src/storage/storage-adapter.js';
import type { AgentSessionLike } from '../../src/pi/agent-session-port.js';
import { FakePiSession } from '../fakes/fake-pi-session.js';

/**
 * Service-level integration tests for the full conflict/reconciliation pipeline (US6, FR-031,
 * FR-032, FR-032a-d). Builds the real service graph (no HTTP/Fastify layer, no real Pi SDK — see
 * quickstart.md's "service-level, temp DB + FakePiSession" characterization of `test:integration`)
 * against an in-memory SQLite database, and drives the agent side of every conflict-replacement
 * exchange with `FakePiSession` (tests/fakes/fake-pi-session.ts) — the double documented there as
 * existing specifically "to drive FR-032 (conflict/replacement)... without a live model."
 *
 * `FakePiSession` never auto-invokes a tool (unlike `FakeAgentSession`, which runs scripted
 * directives): the agent's "decision" to call `propose_document_edit` again is simulated directly
 * by calling `EditService.stage()` — exactly what that tool's `execute` does — while the session's
 * event stream (`emitToolStarted`/`emitToolCompleted`/`emitMessageStart`/`emitMessageCompleted`/
 * `completeRun`) is scripted alongside it so the real EventBridge/ConcurrencyLimiter machinery
 * that `ConflictService`'s replacement request depends on is genuinely exercised.
 */

interface Harness {
  storage: StorageAdapter;
  eventService: EventService;
  eventHub: EventHub;
  automerge: AutomergeStoreHolder;
  revisionService: RevisionService;
  documentService: DocumentService;
  piService: PiService;
  conflictService: ConflictService;
  editService: EditService;
}

function buildHarness(): Harness {
  const storage = new SqliteStorageAdapter(':memory:');
  const eventService = new EventService(storage);
  const emptySnapshot: DocumentSnapshot = {
    document: { id: '', title: '', currentRevision: 0, createdAt: '', updatedAt: '', content: '' },
    conversations: [],
  };
  const eventHub = new EventHub(eventService, () => emptySnapshot);
  const automerge = new AutomergeStoreHolder();
  const primaryMutex = new PrimaryMutex();
  const revisionService = new RevisionService(
    storage,
    eventService,
    eventHub,
    automerge,
    primaryMutex,
  );
  const documentService = new DocumentService(
    storage,
    eventService,
    eventHub,
    automerge,
    revisionService,
    primaryMutex,
  );
  revisionService.setDocumentService(documentService);

  const runBuffer = new RunBuffer();
  const piService = new PiService(storage, automerge, primaryMutex);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const turnRunner = new TurnRunner(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
  );
  const conflictService = new ConflictService(storage, eventService, eventHub, automerge);
  const editService = new EditService(
    storage,
    eventService,
    eventHub,
    automerge,
    revisionService,
    conflictService,
    turnRunner,
    primaryMutex,
  );
  piService.setEditService(editService);

  return {
    storage,
    eventService,
    eventHub,
    automerge,
    revisionService,
    documentService,
    piService,
    conflictService,
    editService,
  };
}

/** Bypasses `ConversationService.branch()` entirely (no fire-and-forget seed message, no real Pi
 *  session lookup) — this suite tests EditService/ConflictService/TextAnchor directly, so a plain
 *  storage-level row with a known id is all a "conversation" needs to be here. */
function createBranchConversation(
  storage: StorageAdapter,
  documentId: string,
  contextRevision: number,
): ConversationRow {
  const now = new Date().toISOString();
  const id = newId('conv');
  return storage.createConversation({
    id,
    documentId,
    parentId: null,
    name: 'Reviewer',
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

/** Reaches into `PiService`'s private session cache to pre-register a `FakePiSession` for a known
 *  conversation id, so `getOrCreateSession` hits the cache and never falls through to the real Pi
 *  SDK branch (which would require live model credentials). This is a test-only seam accessed via
 *  a type assertion rather than a production code change. */
function registerFakeSession(
  piService: PiService,
  conversationId: string,
  session: FakePiSession,
): void {
  (piService as unknown as { sessions: Map<string, AgentSessionLike> }).sessions.set(
    conversationId,
    session,
  );
}

/** Advances the document the way a concurrent manual edit would: splice the live Automerge text
 *  and record a `manual_debounce` revision (skipping the real debounce timer, which is orthogonal
 *  to what this suite tests). */
function advance(h: Harness, documentId: string, oldStr: string, newStr: string): void {
  const content = h.automerge.get(documentId).getContent();
  const from = content.indexOf(oldStr);
  if (from === -1) throw new Error(`advance(): "${oldStr}" not found in current content`);
  h.automerge.get(documentId).splice([{ from, to: from + oldStr.length, insert: newStr }]);
  h.revisionService.createRevision(documentId, { source: 'user', origin: 'manual_debounce' });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Asserts the cross-entity invariants documented in data-model.md's "§Cross-entity invariants"
 *  section, restricted to the ones this conflict-pipeline suite can actually exercise (Primary/
 *  Main, idempotency, no-silent-application, revision continuity, event-sequence gaplessness, and
 *  bounded replacement — invariants 1-4, 8-10). Close-safety (#6) and depth enforcement (#7) are
 *  not exercised by this suite (no conversation here is ever closed or branch-depth-limited) and
 *  are covered elsewhere (US3/US7 e2e, US5 primary-service tests). */
function assertCrossEntityInvariants(storage: StorageAdapter, documentId: string): void {
  const conversations = storage.listAllConversations(documentId);

  // 1. At most one Primary among non-closed conversations; a closed conversation never has it.
  const nonClosedPrimaries = conversations.filter((c) => c.isPrimary && c.status !== 'closed');
  expect(nonClosedPrimaries.length).toBeLessThanOrEqual(1);
  expect(conversations.some((c) => c.isPrimary && c.status === 'closed')).toBe(false);

  // 2. Exactly one Main, never closed.
  const mains = conversations.filter((c) => c.kind === 'main');
  expect(mains).toHaveLength(1);
  expect(mains[0]!.status).not.toBe('closed');

  const allEdits: StagedEditRow[] = conversations.flatMap((c) =>
    storage.listStagedEditsByConversation(c.id),
  );

  // 4. Idempotency: (conversationId, piToolCallId) unique across every staged_edit ever created.
  const toolCallKeys = new Set<string>();
  for (const edit of allEdits) {
    const key = `${edit.conversationId}:${edit.piToolCallId}`;
    expect(toolCallKeys.has(key)).toBe(false);
    toolCallKeys.add(key);
  }

  // 10. Bounded replacement: no staged_edit exceeds the configured cap, and
  // `replacement_attempt = 0 <=> supersedes_id IS NULL` (data-model.md §6 validation rule).
  const maxAttempts = storage.getSettings().maxReplacementAttempts;
  for (const edit of allEdits) {
    expect(edit.replacementAttempt).toBeLessThanOrEqual(maxAttempts);
    expect(edit.replacementAttempt === 0).toBe(edit.supersedesId === null);
  }

  // Superseded rows never re-activate: every non-pending row has resolvedAt set, and a
  // superseded/dropped/applied row is never subsequently pending again (checked structurally —
  // status is one-way from `pending` in this schema, so simply asserting resolvedAt is present is
  // sufficient corroboration here).
  for (const edit of allEdits) {
    if (edit.status !== 'pending') {
      expect(edit.resolvedAt).not.toBeNull();
    }
  }

  // At most one pending proposal per supersession chain: no staged_edit is both superseded and
  // has more than one non-superseded successor.
  for (const edit of allEdits) {
    const successors = allEdits.filter((e) => e.supersedesId === edit.id);
    expect(successors.length).toBeLessThanOrEqual(1);
  }

  // 3. No silent application: every agent_edit revision names an `applied` staged_edit.
  const revisions = [];
  for (let r = 1; ; r += 1) {
    const row = storage.getRevision(documentId, r);
    if (!row) break;
    revisions.push(row);
  }
  for (const rev of revisions) {
    if (rev.origin === 'agent_edit') {
      expect(rev.stagedEditId).not.toBeNull();
      const edit = storage.getStagedEdit(rev.stagedEditId!);
      expect(edit?.status).toBe('applied');
    }
  }

  // 8. Revision continuity: gapless from 1..currentRevision.
  const doc = storage.getDocument(documentId);
  if (doc) {
    expect(revisions).toHaveLength(doc.currentRevision);
  }

  // 9. Event ordering: sequence gapless per document.
  const events = storage.listEventsSince(documentId, null);
  events.forEach((e, i) => expect(e.sequence).toBe(i + 1));
}

const DOC_CONTENT = [
  '# Reconciliation Fixture',
  '',
  'The quick fox jumps over the lazy dog.',
  '',
  'A second paragraph stays constant across every scenario below.',
  '',
  'abcdefgh',
].join('\n');

describe('conflict/reconciliation pipeline (US6)', () => {
  let h: Harness;
  let documentId: string;
  let branch: ConversationRow;
  let fakeSession: FakePiSession;

  beforeEach(() => {
    h = buildHarness();
    const created = h.documentService.create(DOC_CONTENT, 'Reconciliation Fixture');
    documentId = created.document.id;
    branch = createBranchConversation(h.storage, documentId, created.document.currentRevision);
    fakeSession = new FakePiSession({ sessionId: branch.id });
    registerFakeSession(h.piService, branch.id, fakeSession);
  });

  it('reconciles cleanly when the document advanced elsewhere without touching the anchor', async () => {
    const edit = h.editService.stage(
      branch.id,
      'tool_clean_1',
      'Swap quick for swift',
      [
        {
          old_string: 'The quick fox jumps over the lazy dog.',
          new_string: 'The swift fox jumps over the lazy dog.',
        },
      ],
      branch.contextRevision,
    );

    // A manual edit lands elsewhere in the document — does not overlap the proposal's anchor.
    advance(h, documentId, 'A second paragraph stays constant', 'A second paragraph now differs');

    const outcome = await h.editService.apply(edit.id);
    expect(outcome.response.outcome).toBe('applied');

    const content = h.automerge.get(documentId).getContent();
    // SC-005: both changes preserved — the proposal's and the concurrent manual edit's.
    expect(content).toContain('The swift fox jumps over the lazy dog.');
    expect(content).toContain('A second paragraph now differs');

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('supersedes on not_found, requests a replacement, and applies it (FR-032)', async () => {
    const edit1 = h.editService.stage(
      branch.id,
      'tool_notfound_1',
      'Swap quick for swift',
      [
        {
          old_string: 'The quick fox jumps over the lazy dog.',
          new_string: 'The swift fox jumps over the lazy dog.',
        },
      ],
      branch.contextRevision,
    );

    // Rewrite the exact region the proposal targets — its anchor no longer exists at all.
    advance(
      h,
      documentId,
      'The quick fox jumps over the lazy dog.',
      'The swift wolf leaps over the sleepy dog.',
    );

    const result = await h.editService.apply(edit1.id);
    expect(result.response.outcome).toBe('conflict');
    if (result.response.outcome !== 'conflict') throw new Error('unreachable');
    expect(result.response.conflictDetail.operations).toEqual([
      { index: 0, reason: 'not_found', occurrences: 0 },
    ]);
    expect(result.response.replacementRequested).toBe(true);
    expect(result.response.replacementAttempt).toBe(1);

    await flushMicrotasks();
    expect(h.storage.getConversation(branch.id)?.status).toBe('working');
    expect(fakeSession.prompts).toHaveLength(1);

    // Simulate the agent proposing a replacement informed by the conflict detail it was sent.
    const toolCallId2 = 'tool_notfound_2';
    fakeSession.emitToolStarted(toolCallId2, 'propose_document_edit');
    const replacement = h.editService.stage(
      branch.id,
      toolCallId2,
      'Swap quick for swift (revised)',
      [
        {
          old_string: 'The swift wolf leaps over the sleepy dog.',
          new_string: 'The swift fox leaps over the sleepy dog.',
        },
      ],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId2, 'propose_document_edit', {
      result: { details: { stagedEditId: replacement.id } },
    });
    fakeSession.emitMessageStart('msg_1');
    fakeSession.emitMessageCompleted('msg_1', 'Here is a revised proposal.');
    fakeSession.completeRun();
    await flushMicrotasks();

    expect(replacement.status).toBe('pending');
    expect(replacement.supersedesId).toBe(edit1.id);
    expect(replacement.replacementAttempt).toBe(1);
    expect(h.storage.getStagedEdit(edit1.id)?.status).toBe('superseded');
    expect(h.storage.getStagedEdit(edit1.id)?.conflictDetail).toEqual({
      operations: [{ index: 0, reason: 'not_found', occurrences: 0 }],
    });
    expect(h.storage.getConversation(branch.id)?.status).toBe('idle');

    const applied = await h.editService.apply(replacement.id);
    expect(applied.response.outcome).toBe('applied');
    expect(h.automerge.get(documentId).getContent()).toContain(
      'The swift fox leaps over the sleepy dog.',
    );

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('supersedes on ambiguous and requests a replacement (FR-032)', async () => {
    const edit1 = h.editService.stage(
      branch.id,
      'tool_ambiguous_1',
      'Rename dog',
      [{ old_string: 'lazy dog', new_string: 'sleepy dog' }],
      branch.contextRevision,
    );

    // Duplicate the anchored text elsewhere so it is no longer unique.
    advance(h, documentId, 'abcdefgh', 'abcdefgh and one more lazy dog');

    const result = await h.editService.apply(edit1.id);
    expect(result.response.outcome).toBe('conflict');
    if (result.response.outcome !== 'conflict') throw new Error('unreachable');
    expect(result.response.conflictDetail.operations).toEqual([
      { index: 0, reason: 'ambiguous', occurrences: 2 },
    ]);
    expect(result.response.replacementRequested).toBe(true);

    await flushMicrotasks();
    const toolCallId2 = 'tool_ambiguous_2';
    fakeSession.emitToolStarted(toolCallId2, 'propose_document_edit');
    const replacement = h.editService.stage(
      branch.id,
      toolCallId2,
      'Rename dog (revised, unique anchor)',
      [{ old_string: 'jumps over the lazy dog', new_string: 'jumps over the sleepy dog' }],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId2, 'propose_document_edit', {
      result: { details: { stagedEditId: replacement.id } },
    });
    fakeSession.emitMessageStart('msg_1');
    fakeSession.emitMessageCompleted('msg_1', 'Revised with more context.');
    fakeSession.completeRun();
    await flushMicrotasks();

    expect(replacement.supersedesId).toBe(edit1.id);
    const applied = await h.editService.apply(replacement.id);
    expect(applied.response.outcome).toBe('applied');
    expect(h.automerge.get(documentId).getContent()).toContain('jumps over the sleepy dog');

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('supersedes on overlapping operations within one proposal and requests a replacement (FR-032)', async () => {
    // "abcdefgh" is present verbatim in the fixture; these two operations resolve to overlapping
    // ranges within it (research R4 / text-anchor.ts), independent of any concurrent document change.
    const edit1 = h.editService.stage(
      branch.id,
      'tool_overlap_1',
      'Two overlapping replacements',
      [
        { old_string: 'abcdef', new_string: 'X' },
        { old_string: 'cdefgh', new_string: 'Y' },
      ],
      branch.contextRevision,
    );

    const result = await h.editService.apply(edit1.id);
    expect(result.response.outcome).toBe('conflict');
    if (result.response.outcome !== 'conflict') throw new Error('unreachable');
    expect(result.response.conflictDetail.operations).toHaveLength(2);
    expect(result.response.conflictDetail.operations.every((o) => o.reason === 'overlapping')).toBe(
      true,
    );
    expect(result.response.replacementRequested).toBe(true);

    await flushMicrotasks();
    const toolCallId2 = 'tool_overlap_2';
    fakeSession.emitToolStarted(toolCallId2, 'propose_document_edit');
    // Disjoint replacement this time — no overlap.
    const replacement = h.editService.stage(
      branch.id,
      toolCallId2,
      'Two disjoint replacements',
      [{ old_string: 'abcdefgh', new_string: 'XY' }],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId2, 'propose_document_edit', {
      result: { details: { stagedEditId: replacement.id } },
    });
    fakeSession.emitMessageStart('msg_1');
    fakeSession.emitMessageCompleted('msg_1', 'Revised without overlap.');
    fakeSession.completeRun();
    await flushMicrotasks();

    const applied = await h.editService.apply(replacement.id);
    expect(applied.response.outcome).toBe('applied');
    expect(h.automerge.get(documentId).getContent()).toContain('XY');

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('chains a second replacement when the first replacement itself goes stale (edge case)', async () => {
    const edit1 = h.editService.stage(
      branch.id,
      'tool_chain_1',
      'Swap quick for swift',
      [
        {
          old_string: 'The quick fox jumps over the lazy dog.',
          new_string: 'The swift fox jumps over the lazy dog.',
        },
      ],
      branch.contextRevision,
    );
    advance(
      h,
      documentId,
      'The quick fox jumps over the lazy dog.',
      'The swift wolf leaps over the sleepy dog.',
    );

    const r1 = await h.editService.apply(edit1.id);
    expect(r1.response.outcome).toBe('conflict');
    await flushMicrotasks();

    const toolCallId2 = 'tool_chain_2';
    fakeSession.emitToolStarted(toolCallId2, 'propose_document_edit');
    const edit2 = h.editService.stage(
      branch.id,
      toolCallId2,
      'Swap quick for swift (revised)',
      [
        {
          old_string: 'The swift wolf leaps over the sleepy dog.',
          new_string: 'The swift fox leaps over the sleepy dog.',
        },
      ],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId2, 'propose_document_edit', {
      result: { details: { stagedEditId: edit2.id } },
    });
    fakeSession.emitMessageStart('msg_1');
    fakeSession.emitMessageCompleted('msg_1', 'Revised once.');
    fakeSession.completeRun();
    await flushMicrotasks();
    expect(edit2.replacementAttempt).toBe(1);

    // The replacement itself goes stale before the user (or Primary auto-apply) gets to it.
    advance(
      h,
      documentId,
      'The swift wolf leaps over the sleepy dog.',
      'The swift wolf sprints past the sleepy dog.',
    );

    const r2 = await h.editService.apply(edit2.id);
    expect(r2.response.outcome).toBe('conflict');
    if (r2.response.outcome !== 'conflict') throw new Error('unreachable');
    expect(r2.response.replacementRequested).toBe(true);
    expect(r2.response.replacementAttempt).toBe(2);
    await flushMicrotasks();

    const toolCallId3 = 'tool_chain_3';
    fakeSession.emitToolStarted(toolCallId3, 'propose_document_edit');
    const edit3 = h.editService.stage(
      branch.id,
      toolCallId3,
      'Swap quick for swift (revised again)',
      [
        {
          old_string: 'The swift wolf sprints past the sleepy dog.',
          new_string: 'The swift fox sprints past the sleepy dog.',
        },
      ],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId3, 'propose_document_edit', {
      result: { details: { stagedEditId: edit3.id } },
    });
    fakeSession.emitMessageStart('msg_2');
    fakeSession.emitMessageCompleted('msg_2', 'Revised twice.');
    fakeSession.completeRun();
    await flushMicrotasks();

    expect(edit3.supersedesId).toBe(edit2.id);
    expect(edit3.replacementAttempt).toBe(2);
    expect(h.conflictService.getChainAttempts(edit3.id)).toBe(2);

    const r3 = await h.editService.apply(edit3.id);
    expect(r3.response.outcome).toBe('applied');
    expect(h.automerge.get(documentId).getContent()).toContain(
      'The swift fox sprints past the sleepy dog.',
    );

    expect(h.storage.getStagedEdit(edit1.id)?.status).toBe('superseded');
    expect(h.storage.getStagedEdit(edit2.id)?.status).toBe('superseded');
    expect(h.storage.getStagedEdit(edit3.id)?.status).toBe('applied');

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('stops after the replacement budget is exhausted and leaves the document unchanged (FR-032a/FR-032b)', async () => {
    const edit1 = h.editService.stage(
      branch.id,
      'tool_exhaust_1',
      'Swap quick for swift',
      [
        {
          old_string: 'The quick fox jumps over the lazy dog.',
          new_string: 'The swift fox jumps over the lazy dog.',
        },
      ],
      branch.contextRevision,
    );
    // Each `advance` below rewrites whatever the *actual* live content currently is — a staged
    // (but not yet applied) replacement never changes the document itself, so the next conflict
    // must be manufactured against the real current text, not the replacement's own new_string.
    advance(
      h,
      documentId,
      'The quick fox jumps over the lazy dog.',
      'Rev A of the drifting phrase.',
    );

    const r1 = await h.editService.apply(edit1.id);
    expect(r1.response.outcome).toBe('conflict');
    await flushMicrotasks();

    const toolCallId2 = 'tool_exhaust_2';
    fakeSession.emitToolStarted(toolCallId2, 'propose_document_edit');
    const edit2 = h.editService.stage(
      branch.id,
      toolCallId2,
      'Replacement 1',
      [
        {
          old_string: 'Rev A of the drifting phrase.',
          new_string: 'Rev B of the drifting phrase.',
        },
      ],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId2, 'propose_document_edit', {
      result: { details: { stagedEditId: edit2.id } },
    });
    fakeSession.emitMessageStart('msg_1');
    fakeSession.emitMessageCompleted('msg_1', 'Replacement 1.');
    fakeSession.completeRun();
    await flushMicrotasks();

    // Break the replacement again, at the budget's last remaining attempt (default max = 2).
    advance(h, documentId, 'Rev A of the drifting phrase.', 'Rev A2 of the drifting phrase.');
    const r2 = await h.editService.apply(edit2.id);
    expect(r2.response.outcome).toBe('conflict');
    if (r2.response.outcome !== 'conflict') throw new Error('unreachable');
    expect(r2.response.replacementRequested).toBe(true);
    expect(r2.response.replacementAttempt).toBe(2);
    await flushMicrotasks();

    const toolCallId3 = 'tool_exhaust_3';
    fakeSession.emitToolStarted(toolCallId3, 'propose_document_edit');
    const edit3 = h.editService.stage(
      branch.id,
      toolCallId3,
      'Replacement 2',
      [
        {
          old_string: 'Rev A2 of the drifting phrase.',
          new_string: 'Rev C of the drifting phrase.',
        },
      ],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId3, 'propose_document_edit', {
      result: { details: { stagedEditId: edit3.id } },
    });
    fakeSession.emitMessageStart('msg_2');
    fakeSession.emitMessageCompleted('msg_2', 'Replacement 2.');
    fakeSession.completeRun();
    await flushMicrotasks();
    expect(h.conflictService.getChainAttempts(edit3.id)).toBe(2);

    // One more conflict: the chain is already at the cap (max_replacement_attempts = 2 default).
    advance(h, documentId, 'Rev A2 of the drifting phrase.', 'Rev A3 of the drifting phrase.');
    const contentBeforeExhaustion = h.automerge.get(documentId).getContent();
    const r3 = await h.editService.apply(edit3.id);
    expect(r3.response.outcome).toBe('conflict_exhausted');
    if (r3.response.outcome !== 'conflict_exhausted') throw new Error('unreachable');
    expect(r3.response.replacementRequested).toBe(false);
    expect(r3.response.attempts).toBe(2);
    expect(r3.response.originalStagedEditId).toBe(edit1.id);

    await flushMicrotasks();
    // No third replacement was requested — only two `propose_document_edit`-triggering sends
    // occurred in this conversation's whole history (for edit1's and edit2's conflicts).
    expect(fakeSession.prompts).toHaveLength(2);
    // The document is unchanged by the exhausted apply attempt, and the conversation stays usable.
    expect(h.automerge.get(documentId).getContent()).toBe(contentBeforeExhaustion);
    expect(h.storage.getConversation(branch.id)?.status).not.toBe('errored');

    expect(h.storage.getStagedEdit(edit3.id)?.status).toBe('superseded');
    expect(h.storage.getStagedEdit(edit3.id)?.replacementAttempt).toBe(2);

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('disables automatic replacement entirely when maxReplacementAttempts is 0 (edge case)', async () => {
    h.storage.updateSettings({ maxReplacementAttempts: 0 }, new Date().toISOString());

    const edit1 = h.editService.stage(
      branch.id,
      'tool_zero_1',
      'Swap quick for swift',
      [
        {
          old_string: 'The quick fox jumps over the lazy dog.',
          new_string: 'The swift fox jumps over the lazy dog.',
        },
      ],
      branch.contextRevision,
    );
    advance(
      h,
      documentId,
      'The quick fox jumps over the lazy dog.',
      'The swift wolf leaps over the sleepy dog.',
    );

    const result = await h.editService.apply(edit1.id);
    expect(result.response.outcome).toBe('conflict_exhausted');
    if (result.response.outcome !== 'conflict_exhausted') throw new Error('unreachable');
    expect(result.response.replacementRequested).toBe(false);
    expect(result.response.attempts).toBe(0);
    expect(result.response.originalStagedEditId).toBe(edit1.id);

    await flushMicrotasks();
    // maxReplacementAttempts: 0 disables automatic replacement outright — no send is ever issued.
    expect(fakeSession.prompts).toHaveLength(0);
    expect(h.storage.getConversation(branch.id)?.status).toBe('idle');
    expect(h.storage.getStagedEdit(edit1.id)?.status).toBe('superseded');
    expect(h.storage.getStagedEdit(edit1.id)?.replacementAttempt).toBe(0);

    assertCrossEntityInvariants(h.storage, documentId);
  });

  it('exposes getChainAttempts as the chain-wide, ancestry-derived replacement count', async () => {
    const edit1 = h.editService.stage(
      branch.id,
      'tool_getchain_1',
      'Swap quick for swift',
      [
        {
          old_string: 'The quick fox jumps over the lazy dog.',
          new_string: 'The swift fox jumps over the lazy dog.',
        },
      ],
      branch.contextRevision,
    );
    expect(h.conflictService.getChainAttempts(edit1.id)).toBe(0);

    advance(
      h,
      documentId,
      'The quick fox jumps over the lazy dog.',
      'The swift wolf leaps over the sleepy dog.',
    );
    await h.editService.apply(edit1.id);
    await flushMicrotasks();

    const toolCallId2 = 'tool_getchain_2';
    fakeSession.emitToolStarted(toolCallId2, 'propose_document_edit');
    const edit2 = h.editService.stage(
      branch.id,
      toolCallId2,
      'Revised',
      [
        {
          old_string: 'The swift wolf leaps over the sleepy dog.',
          new_string: 'The swift fox leaps over the sleepy dog.',
        },
      ],
      branch.contextRevision,
    );
    fakeSession.emitToolCompleted(toolCallId2, 'propose_document_edit', {
      result: { details: { stagedEditId: edit2.id } },
    });
    fakeSession.emitMessageStart('msg_1');
    fakeSession.emitMessageCompleted('msg_1', 'Revised.');
    fakeSession.completeRun();
    await flushMicrotasks();

    expect(h.conflictService.getChainAttempts(edit2.id)).toBe(1);
    expect(h.conflictService.getChainAttempts(edit2.id)).toBe(edit2.replacementAttempt);

    assertCrossEntityInvariants(h.storage, documentId);
  });
});
