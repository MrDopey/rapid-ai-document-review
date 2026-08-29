import { describe, expect, it } from 'vitest';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { AutomergeStoreHolder } from '../../src/document/automerge-store-holder.js';
import { RevisionService } from '../../src/document/revision-service.js';
import { DocumentService } from '../../src/document/document-service.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';
import { PiService } from '../../src/pi/pi-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow, StorageAdapter } from '../../src/storage/storage-adapter.js';

/**
 * FIX 3: a staged edit's apply path (updateStagedEdit -> updateConversation -> Automerge
 * splice/appendChange -> createRevision -> updateDocumentRevision) and a manual document edit
 * (splice/appendChange + its event-log write) each ran as several separate, un-transacted
 * `storage.*` calls. A crash (or here, a simulated mid-sequence throw) partway through could leave
 * SQL rows partially written — e.g. a staged edit marked `applied` with no corresponding `revision`
 * row, desyncing `document.current_revision` from the actual latest `revision` row.
 *
 * These tests force a throw from inside the write sequence (by stubbing one `storage.*` call, per
 * the intended reproduction) and assert every row touched by that sequence reverted together —
 * then confirm the same operation succeeds cleanly and moves the document forward exactly once
 * when retried without the stub, proving the failed attempt left no residue behind.
 */

interface Harness {
  storage: StorageAdapter;
  automerge: AutomergeStoreHolder;
  documentService: DocumentService;
  revisionService: RevisionService;
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
  const revisionService = new RevisionService(storage, eventService, eventHub, automerge);
  const primaryMutex = new PrimaryMutex();
  const documentService = new DocumentService(storage, eventService, eventHub, automerge, revisionService, primaryMutex);
  revisionService.setDocumentService(documentService);

  const runBuffer = new RunBuffer();
  const piService = new PiService(storage, automerge, primaryMutex);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const conflictService = new ConflictService(storage, eventService, eventHub, automerge);
  const editService = new EditService(
    storage,
    eventService,
    eventHub,
    automerge,
    revisionService,
    conflictService,
    piService,
    concurrencyLimiter,
    runBuffer,
    primaryMutex,
  );
  piService.setEditService(editService);

  return { storage, automerge, documentService, revisionService, editService };
}

function createConversation(storage: StorageAdapter, documentId: string, contextRevision: number, isPrimary = false): ConversationRow {
  const now = new Date().toISOString();
  const id = newId('conv');
  return storage.createConversation({
    id,
    documentId,
    parentId: null,
    name: 'Conv',
    kind: isPrimary ? 'main' : 'branch',
    piSessionPath: `/tmp/${id}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary,
    contextRevision,
    branchDepth: 0,
    seedSelection: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
}

describe('FIX 3: multi-statement document/revision writes are transactional', () => {
  it('EditService.apply(): a mid-sequence throw rolls back the whole write sequence — staged edit stays pending, no orphan revision, current_revision unchanged', async () => {
    const h = buildHarness();
    const created = h.documentService.create('Hello world.\n', 'Doc');
    const documentId = created.document.id;
    const conv = createConversation(h.storage, documentId, created.document.currentRevision);

    const staged = h.editService.stage(
      conv.id,
      'tool_call_1',
      'Greeting',
      [{ old_string: 'Hello', new_string: 'Goodbye' }],
      created.document.currentRevision,
    );
    expect(staged.status).toBe('pending');

    const docBefore = h.storage.getDocument()!;
    const latestRevisionBefore = h.storage.getLatestRevision(documentId);

    // Simulate a crash partway through the write sequence: `createRevision` is the last storage
    // write in `applyClean`'s transaction, called after `updateStagedEdit`/`updateConversation`/
    // the Automerge splice have already run inside the same (still-open) transaction.
    const originalCreateRevision = h.storage.createRevision.bind(h.storage);
    let shouldThrow = true;
    h.storage.createRevision = ((row) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('simulated crash mid-sequence');
      }
      return originalCreateRevision(row);
    }) as typeof h.storage.createRevision;

    await expect(h.editService.apply(staged.id)).rejects.toThrow('simulated crash mid-sequence');

    // Nothing partial survived: the staged edit is back to (never left) pending, and no orphan
    // revision row or current_revision bump exists.
    expect(h.storage.getStagedEdit(staged.id)?.status).toBe('pending');
    expect(h.storage.getStagedEdit(staged.id)?.appliedRevision).toBeNull();
    expect(h.storage.getDocument()?.currentRevision).toBe(docBefore.currentRevision);
    expect(h.storage.getLatestRevision(documentId)?.revision).toBe(latestRevisionBefore?.revision ?? 0);
    expect(h.storage.getConversation(conv.id)?.contextRevision).toBe(conv.contextRevision);

    // Restoring the real storage call: the document remains fully usable afterward — a fresh
    // proposal still applies cleanly and moves the document forward by exactly one revision from
    // the pre-failure baseline, proving the failed attempt left no residue that corrupts revision
    // numbering for later, successful writes. (Note: this deliberately doesn't assert anything
    // about the *content* the earlier failed attempt's own Automerge splice produced in memory —
    // `storage.transaction()` guarantees the SQL rows revert together, but an in-memory Automerge
    // mutation that already ran before the simulated throw is not itself rolled back by it; that
    // is a separate, narrower concern than the SQL-row desync FIX 3 targets.)
    h.storage.createRevision = originalCreateRevision;
    const conv2 = createConversation(h.storage, documentId, docBefore.currentRevision);
    const currentFirstWord = h.automerge.get().getContent().split(' ')[0]!;
    const staged2 = h.editService.stage(
      conv2.id,
      'tool_call_2',
      'Follow-up',
      [{ old_string: currentFirstWord, new_string: 'Renamed' }],
      docBefore.currentRevision,
    );
    const result = await h.editService.apply(staged2.id);
    expect(result.response.outcome).toBe('applied');
    expect(h.storage.getStagedEdit(staged2.id)?.status).toBe('applied');
    expect(h.storage.getDocument()?.currentRevision).toBe(docBefore.currentRevision + 1);
    expect(h.storage.getLatestRevision(documentId)?.revision).toBe(docBefore.currentRevision + 1);
  });

  it('DocumentService.applyChanges(): a mid-sequence throw rolls back the Automerge change-log write together with its event-log write', async () => {
    const h = buildHarness();
    const created = h.documentService.create('Hello world.\n', 'Doc');
    const documentId = created.document.id;

    const changesBefore = h.storage.listChangesSince(documentId, 0).length;

    // `document_content_changed`'s event-log write (inside the same `storage.transaction()` as
    // the Automerge splice's own `appendChange` write) is what throws here.
    const originalAppendEvent = h.storage.appendEvent.bind(h.storage);
    let shouldThrow = true;
    h.storage.appendEvent = ((row) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('simulated crash mid-sequence');
      }
      return originalAppendEvent(row);
    }) as typeof h.storage.appendEvent;

    await expect(
      h.documentService.applyChanges(undefined, [{ from: 0, to: 5, insert: 'Howdy' }], undefined),
    ).rejects.toThrow('simulated crash mid-sequence');

    // The Automerge `document_change` row from the splice was rolled back along with the event
    // row, not left as an orphan write with no corresponding event.
    expect(h.storage.listChangesSince(documentId, 0)).toHaveLength(changesBefore);

    h.storage.appendEvent = originalAppendEvent;
    await h.documentService.applyChanges(undefined, [{ from: 0, to: 5, insert: 'Howdy' }], undefined);
    expect(h.storage.listChangesSince(documentId, 0)).toHaveLength(changesBefore + 1);
    expect(h.automerge.get().getContent()).toBe('Howdy world.\n');
  });

  it('RevisionService.createRevision(): a mid-sequence throw rolls back both the revision row and the document.current_revision bump together', () => {
    const h = buildHarness();
    const created = h.documentService.create('Hello world.\n', 'Doc');
    const documentId = created.document.id;
    const docBefore = h.storage.getDocument()!;
    const latestRevisionBefore = h.storage.getLatestRevision(documentId);

    const originalUpdateDocumentRevision = h.storage.updateDocumentRevision.bind(h.storage);
    let shouldThrow = true;
    h.storage.updateDocumentRevision = ((...args: Parameters<typeof originalUpdateDocumentRevision>) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('simulated crash mid-sequence');
      }
      return originalUpdateDocumentRevision(...args);
    }) as typeof h.storage.updateDocumentRevision;

    expect(() => h.revisionService.createRevision(documentId, { source: 'user', origin: 'manual_debounce' })).toThrow(
      'simulated crash mid-sequence',
    );

    // The `revision` row `createRevision` had already written (before the stubbed call threw) was
    // rolled back too — not left as an orphan with no matching `document.current_revision` bump.
    expect(h.storage.getLatestRevision(documentId)?.revision).toBe(latestRevisionBefore?.revision ?? 0);
    expect(h.storage.getDocument()?.currentRevision).toBe(docBefore.currentRevision);

    h.storage.updateDocumentRevision = originalUpdateDocumentRevision;
    const row = h.revisionService.createRevision(documentId, { source: 'user', origin: 'manual_debounce' });
    expect(row.revision).toBe(docBefore.currentRevision + 1);
    expect(h.storage.getDocument()?.currentRevision).toBe(docBefore.currentRevision + 1);
  });
});
