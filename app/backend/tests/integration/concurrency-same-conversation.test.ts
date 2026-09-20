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
import { ConversationService } from '../../src/conversation/conversation-service.js';
import { ConversationFoldService } from '../../src/conversation/conversation-fold-service.js';
import { ConversationReviewService } from '../../src/conversation/conversation-review-service.js';
import { EventPublisher } from '../../src/events/event-publisher.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow, StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { AgentSessionLike } from '../../src/pi/agent-session-port.js';
import { FakePiSession } from '../fakes/fake-pi-session.js';

/**
 * FIX 2: two overlapping `send()` calls on the SAME conversation must not corrupt its state.
 * `ConcurrencyLimiter.acquire` tracked running turns in a `Set<conversationId>` per document, but
 * nothing stopped the *same* conversationId being admitted twice concurrently — a fast second send
 * on a conversation whose turn was still in flight reached `session.prompt()`, which throws
 * synchronously ("already streaming"), flipping the conversation to `errored` via the event bridge
 * for what is really just a double-send. This suite proves the second overlapping send is now
 * queued instead of ever reaching the session/prompt layer.
 *
 * Same "no HTTP layer, real service graph, FakePiSession" harness shape as
 * `tests/integration/concurrency.test.ts` (US1/US2) and `reconcile.test.ts` (US6).
 */

interface Harness {
  storage: StorageAdapter;
  piService: PiService;
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

  const primaryService = new PrimaryService(storage, eventService, eventHub, primaryMutex);
  const conversationEventPublisher = new EventPublisher(eventService, eventHub);
  const conversationFoldService = new ConversationFoldService(
    storage,
    piService,
    conversationEventPublisher,
  );
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

  documentService.create('# Doc\n\nHello.\n', 'Doc');

  return { storage, piService, conversationService };
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
    branchDepth: 1,
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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('FIX 2: overlapping sends on the same conversation do not corrupt its state', () => {
  it('a second send fired before the first has settled is queued, not thrown into the session (no spurious agent_error/"already streaming")', async () => {
    const h = buildHarness();
    const document = h.storage.listDocuments()[0]!;
    const conv = createConversation(h.storage, document.id, document.currentRevision);
    const session = new FakePiSession({ sessionId: conv.id });
    registerFakeSession(h.piService, conv.id, session);

    const first = h.conversationService.send(conv.id, 'first message');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(h.storage.getConversation(conv.id)?.status).toBe('working');
    expect(session.prompts).toEqual(['first message']);

    // Fired back-to-back, without awaiting `first` — exactly the "fast overlapping second send"
    // scenario FIX 2 targets.
    const second = h.conversationService.send(conv.id, 'second message');
    await flushMicrotasks();
    await flushMicrotasks();

    // Must not have reached `session.prompt()` at all (which would throw "already streaming" and
    // flip the conversation to errored) — it is queued behind the first turn instead.
    expect(session.prompts).toEqual(['first message']);
    expect(h.storage.getConversation(conv.id)?.status).toBe('working');
    expect(h.storage.getConversation(conv.id)?.errorMessage).toBeNull();

    const firstResult = await first;
    expect(firstResult).toMatchObject({ accepted: true, queued: false });
    const secondResult = await second;
    expect(secondResult).toMatchObject({ accepted: true, queued: true });

    // Completing the first run drains the queue and delivers the second message normally.
    session.completeRun();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(session.prompts).toEqual(['first message', 'second message']);
    expect(h.storage.getConversation(conv.id)?.status).toBe('working');
    expect(h.storage.getConversation(conv.id)?.errorMessage).toBeNull();

    session.completeRun();
    await flushMicrotasks();
    expect(h.storage.getConversation(conv.id)?.status).toBe('idle');
    expect(h.storage.getConversation(conv.id)?.errorMessage).toBeNull();
  });

  it('does not affect a second send on a DIFFERENT conversation, which still runs immediately alongside the first', async () => {
    const h = buildHarness();
    const document = h.storage.listDocuments()[0]!;
    const convA = createConversation(h.storage, document.id, document.currentRevision);
    const convB = createConversation(h.storage, document.id, document.currentRevision);
    const sessionA = new FakePiSession({ sessionId: convA.id });
    const sessionB = new FakePiSession({ sessionId: convB.id });
    registerFakeSession(h.piService, convA.id, sessionA);
    registerFakeSession(h.piService, convB.id, sessionB);

    void h.conversationService.send(convA.id, 'to A');
    void h.conversationService.send(convB.id, 'to B');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(h.storage.getConversation(convA.id)?.status).toBe('working');
    expect(h.storage.getConversation(convB.id)?.status).toBe('working');
    expect(sessionA.prompts).toEqual(['to A']);
    expect(sessionB.prompts).toEqual(['to B']);
  });
});
