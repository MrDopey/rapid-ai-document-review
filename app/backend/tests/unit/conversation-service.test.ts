import { describe, expect, it } from 'vitest';
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
import { PrimaryService } from '../../src/conversation/primary-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { ConversationBusyError, ConversationService } from '../../src/conversation/conversation-service.js';
import { ConversationFoldService } from '../../src/conversation/conversation-fold-service.js';
import { ConversationReviewService } from '../../src/conversation/conversation-review-service.js';
import { EventPublisher } from '../../src/events/event-publisher.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow, StorageAdapter } from '../../src/storage/storage-adapter.js';

/**
 * specs/006-archivable-main-conversation, T013: `close()`'s new `status === 'working'` guard
 * (`ConversationBusyError`, mapped to 409/`CONVERSATION_BUSY` in api/http/conversations.ts). Not
 * yet implemented — today `close()` has no busy check at all, so these are expected to fail (a
 * `working` branch closes with no error at all today; a `working` Main throws
 * `CannotCloseMainConversationError` instead, since `close()`'s `kind === 'main'` early-throw still
 * runs before any busy check could).
 */

interface Harness {
  storage: SqliteStorageAdapter;
  documentService: DocumentService;
  conversationService: ConversationService;
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
  const revisionService = new RevisionService(storage, eventService, eventHub, automerge, primaryMutex);
  const documentService = new DocumentService(storage, eventService, eventHub, automerge, revisionService, primaryMutex);
  revisionService.setDocumentService(documentService);

  const runBuffer = new RunBuffer();
  const piService = new PiService(storage, automerge, primaryMutex);
  const concurrencyLimiter = new ConcurrencyLimiter(storage, eventService, eventHub);
  const turnRunner = new TurnRunner(storage, eventService, eventHub, runBuffer, piService, concurrencyLimiter);
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

  const primaryService = new PrimaryService(storage, eventService, eventHub, primaryMutex);
  const conversationEventPublisher = new EventPublisher(eventService, eventHub);
  const conversationFoldService = new ConversationFoldService(storage, piService, conversationEventPublisher);
  const conversationReviewService = new ConversationReviewService(
    storage,
    piService,
    conversationEventPublisher,
    automerge,
  );
  const conversationService = new ConversationService(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
    automerge,
    primaryService,
    turnRunner,
    conversationFoldService,
    conversationReviewService,
  );

  // Deliberately not wired via `documentService.setConversationService(...)`: this suite never
  // needs `DocumentService.create`'s own fire-and-forget seed message to actually fire (it would
  // require a real/fake Pi session), only the plain Main row it creates.
  return { storage, documentService, conversationService };
}

/** Bypasses `ConversationService.branch()` (no fire-and-forget seed message) — same seam
 *  `restart.test.ts`/`pi-session-eviction.test.ts` use to create a plain storage-level branch row
 *  directly, which is all a busy-guard test needs. */
function createBranch(storage: StorageAdapter, documentId: string, parentId: string, contextRevision: number): ConversationRow {
  const now = new Date().toISOString();
  const id = newId('conv');
  return storage.createConversation({
    id,
    documentId,
    parentId,
    name: 'Branch',
    kind: 'branch',
    piSessionPath: `/tmp/${id}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary: false,
    isCurrentMain: false,
    contextRevision,
    branchDepth: 1,
    seedSelection: null,
    forkedFromMessageId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
}

describe('ConversationService.close(): status === "working" guard (specs/006-archivable-main-conversation)', () => {
  it('throws ConversationBusyError for a working Main conversation', () => {
    const h = buildHarness();
    const created = h.documentService.create('# Doc\n\nHello.\n', 'Doc');
    const mainId = created.mainConversation.id;
    h.storage.updateConversation(mainId, { status: 'working' });

    expect(() => h.conversationService.close(mainId, false)).toThrow(ConversationBusyError);
  });

  it('throws ConversationBusyError for a working non-Main (branch) conversation', () => {
    const h = buildHarness();
    const created = h.documentService.create('# Doc\n\nHello.\n', 'Doc');
    const documentId = created.document.id;
    const main = h.storage.getConversation(created.mainConversation.id)!;
    const branch = createBranch(h.storage, documentId, main.id, created.document.currentRevision);
    h.storage.updateConversation(branch.id, { status: 'working' });

    expect(() => h.conversationService.close(branch.id, false)).toThrow(ConversationBusyError);
  });
});
