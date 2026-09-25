import { describe, expect, it } from 'vitest';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { AutomergeStoreHolder } from '../../src/document/automerge-store-holder.js';
import { RevisionService } from '../../src/document/revision-service.js';
import { DocumentService } from '../../src/document/document-service.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { ToolCallMessageIdCache } from '../../src/events/tool-call-message-id-cache.js';
import { TurnRunner } from '../../src/pi/turn-runner.js';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';
import { PiService } from '../../src/pi/pi-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow, StorageAdapter } from '../../src/storage/storage-adapter.js';

/**
 * FIX 4: every document-mutating path — manual edits (`DocumentService.applyChanges`),
 * `EditService.apply()` (both the HTTP accept path and `acceptRemaining`), and the
 * `propose_document_edit` tool path — now serializes through the SAME per-document `PrimaryMutex`
 * lock, instead of only the propose-tool path acquiring it (document-tools.ts) while
 * `EditService.apply()`'s HTTP-triggered path went completely unlocked.
 */

interface Harness {
  storage: StorageAdapter;
  automerge: AutomergeStoreHolder;
  documentService: DocumentService;
  editService: EditService;
  primaryMutex: PrimaryMutex;
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
  const toolCallMessageIds = new ToolCallMessageIdCache();
  const piService = new PiService(storage, automerge, primaryMutex, undefined, toolCallMessageIds);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const turnRunner = new TurnRunner(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
    toolCallMessageIds,
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

  return { storage, automerge, documentService, editService, primaryMutex };
}

function createConversation(
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
    name: 'Conv',
    kind: 'branch',
    piSessionPath: `/tmp/${id}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary: false,
    contextRevision,
    branchDepth: 0,
    seedSelection: null,
    forkedFromMessageId: null,
    piLeafEntryId: null,
    doneAt: null,
    seedExcerptText: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
}

describe('FIX 4: document-mutating writes route through the shared per-document lock', () => {
  it('two concurrent apply() calls for two different pending edits on the same document both succeed and are assigned distinct, sequential revisions (no interleaving/corruption)', async () => {
    const h = buildHarness();
    const created = h.documentService.create('One two three four.\n', 'Doc');
    const documentId = created.document.id;
    const conv = createConversation(h.storage, documentId, created.document.currentRevision);

    // Two disjoint operations, staged as two separate proposals — exactly the "two accepts that
    // would otherwise race on reading/writing document content" scenario FIX 4 targets.
    const editA = h.editService.stage(
      conv.id,
      'call_a',
      'A',
      [{ old_string: 'One', new_string: 'ONE' }],
      created.document.currentRevision,
    );
    const editB = h.editService.stage(
      conv.id,
      'call_b',
      'B',
      [{ old_string: 'four', new_string: 'FOUR' }],
      created.document.currentRevision,
    );

    const revisionBefore = created.document.currentRevision;

    // Fired concurrently, without awaiting between them.
    const [resultA, resultB] = await Promise.all([
      h.editService.apply(editA.id),
      h.editService.apply(editB.id),
    ]);

    expect(resultA.response.outcome).toBe('applied');
    expect(resultB.response.outcome).toBe('applied');

    const revisions = [resultA, resultB].map((r) =>
      r.response.outcome === 'applied' ? r.response.revision : null,
    );
    // Each application produced its own, distinct revision — never the same number claimed twice,
    // which is exactly what would happen if both calls read `document.currentRevision` before
    // either had written its own increment.
    expect(new Set(revisions).size).toBe(2);
    expect(revisions.sort()).toEqual([revisionBefore + 1, revisionBefore + 2]);

    expect(h.storage.getDocument(documentId)?.currentRevision).toBe(revisionBefore + 2);
    expect(h.automerge.get(documentId).getContent()).toBe('ONE two three FOUR.\n');
    expect(h.storage.getStagedEdit(editA.id)?.status).toBe('applied');
    expect(h.storage.getStagedEdit(editB.id)?.status).toBe('applied');
  });
});
