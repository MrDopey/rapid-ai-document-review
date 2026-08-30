import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { AutomergeStoreHolder } from '../../src/document/automerge-store-holder.js';
import { RevisionService } from '../../src/document/revision-service.js';
import { DocumentService } from '../../src/document/document-service.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { PrimaryMutex } from '../../src/pi/primary-mutex.js';
import { PiService } from '../../src/pi/pi-service.js';
import { PrimaryService } from '../../src/conversation/primary-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { ConversationService } from '../../src/conversation/conversation-service.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow, StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { AgentSessionLike } from '../../src/pi/agent-session-port.js';
import { FakePiSession } from '../fakes/fake-pi-session.js';

/**
 * Service-level integration tests for `max_concurrent_agents` admission and FIFO queueing
 * (US1/US2, FR-015, FR-015a, T080). Same "no HTTP layer, real service graph, FakePiSession" shape
 * as `reconcile.test.ts` (US6) — see that file's header comment for the rationale.
 *
 * `FakePiSession.prompt()` resolves as soon as `agent_start` is emitted (it does not wait for the
 * run to settle), so a run occupies its concurrency slot from `agent_start` until the test scripts
 * `completeRun()`/`emitAgentError()`, which is exactly the window this suite needs to control to
 * observe "3 running, 1 queued" deterministically.
 */

interface Harness {
  storage: StorageAdapter;
  eventService: EventService;
  eventHub: EventHub;
  automerge: AutomergeStoreHolder;
  documentService: DocumentService;
  piService: PiService;
  concurrencyLimiter: ConcurrencyLimiter;
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

  const primaryService = new PrimaryService(storage, eventService, eventHub, primaryMutex);
  const conversationService = new ConversationService(
    storage,
    eventService,
    eventHub,
    runBuffer,
    piService,
    concurrencyLimiter,
    automerge,
    primaryService,
  );

  return { storage, eventService, eventHub, automerge, documentService, piService, concurrencyLimiter, conversationService };
}

/** Bypasses `ConversationService.branch()` (no fire-and-forget seed message) — this suite drives
 *  `send()` directly against plain storage-level conversation rows, exactly like
 *  `reconcile.test.ts`'s `createBranchConversation` helper. */
function createConversation(storage: StorageAdapter, documentId: string, contextRevision: number, name: string): ConversationRow {
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

/** Same test-only seam `reconcile.test.ts` uses to pre-register a `FakePiSession` per
 *  conversation, so `PiService.getOrCreateSession` never falls through to the real Pi SDK. */
function registerFakeSession(piService: PiService, conversationId: string, session: FakePiSession): void {
  (piService as unknown as { sessions: Map<string, AgentSessionLike> }).sessions.set(conversationId, session);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const DOC_CONTENT = '# Concurrency Fixture\n\nHello world.\n';

describe('concurrency admission and FIFO queueing (US1/US2, FR-015/FR-015a)', () => {
  let h: Harness;
  let documentId: string;
  let conversations: ConversationRow[];
  let sessions: FakePiSession[];

  beforeEach(() => {
    h = buildHarness();
    const created = h.documentService.create(DOC_CONTENT, 'Concurrency Fixture');
    documentId = created.document.id;

    // 5 conversations: enough to prove 3 run concurrently, more than one queues, and a running
    // conversation's error doesn't disturb a queue with more than one entry left in it.
    conversations = Array.from({ length: 5 }, (_, i) =>
      createConversation(h.storage, documentId, created.document.currentRevision, `Conv ${i + 1}`),
    );
    sessions = conversations.map((conv) => {
      const session = new FakePiSession({ sessionId: conv.id });
      registerFakeSession(h.piService, conv.id, session);
      return session;
    });
  });

  function statusOf(conversationId: string): string | undefined {
    return h.storage.getConversation(conversationId)?.status;
  }

  it('runs up to max_concurrent_agents (3) immediately and queues the rest, FIFO', async () => {
    expect(h.storage.getSettings().maxConcurrentAgents).toBe(3);

    // Issuing all 5 sends back-to-back (no await between them) is deliberate: each `send()` call
    // runs synchronously through `ConcurrencyLimiter.acquire()` before its first internal await
    // (PiService.getOrCreateSession), so submission order is exactly what determines who runs
    // immediately versus who queues, and in what FIFO order (FR-015a).
    const sendPromises = conversations.map((conv, i) => h.conversationService.send(conv.id, `hello ${i + 1}`));
    await flushMicrotasks();
    await flushMicrotasks();

    // First 3 admitted immediately; last 2 queued at positions 1 and 2.
    expect(statusOf(conversations[0]!.id)).toBe('working');
    expect(statusOf(conversations[1]!.id)).toBe('working');
    expect(statusOf(conversations[2]!.id)).toBe('working');
    expect(statusOf(conversations[3]!.id)).toBe('idle');
    expect(statusOf(conversations[4]!.id)).toBe('idle');

    const results = await Promise.all(sendPromises);
    expect(results[0]).toMatchObject({ accepted: true, queued: false });
    expect(results[1]).toMatchObject({ accepted: true, queued: false });
    expect(results[2]).toMatchObject({ accepted: true, queued: false });
    expect(results[3]).toMatchObject({ accepted: true, queued: true });
    expect(results[4]).toMatchObject({ accepted: true, queued: true });

    // Never rejected — a prompt beyond the limit is always accepted and queued (FR-015).
    for (const r of results) expect(r.accepted).toBe(true);

    // agent_queued reports FIFO queue position for each queued conversation (FR-015a).
    const events = h.storage.listEventsSince(documentId, null);
    const queuedEvents = events.filter((e) => e.eventType === 'agent_queued');
    expect(queuedEvents).toHaveLength(2);
    expect(queuedEvents[0]).toMatchObject({
      conversationId: conversations[3]!.id,
      data: { queuePosition: 1, runningCount: 3, limit: 3 },
    });
    expect(queuedEvents[1]).toMatchObject({
      conversationId: conversations[4]!.id,
      data: { queuePosition: 2, runningCount: 3, limit: 3 },
    });

    // The three running sessions actually received their prompts; the two queued ones did not yet.
    expect(sessions[0]!.prompts).toEqual(['hello 1']);
    expect(sessions[1]!.prompts).toEqual(['hello 2']);
    expect(sessions[2]!.prompts).toEqual(['hello 3']);
    expect(sessions[3]!.prompts).toEqual([]);
    expect(sessions[4]!.prompts).toEqual([]);
  });

  it('drains the queue in FIFO order as running turns complete', async () => {
    conversations.forEach((conv, i) => void h.conversationService.send(conv.id, `hello ${i + 1}`));
    await flushMicrotasks();
    await flushMicrotasks();

    // Conv 1 finishes first: releases a slot, dequeues Conv 4 (first queued), not Conv 5.
    sessions[0]!.completeRun();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(statusOf(conversations[0]!.id)).toBe('idle');
    expect(statusOf(conversations[3]!.id)).toBe('working');
    expect(statusOf(conversations[4]!.id)).toBe('idle');
    expect(sessions[3]!.prompts).toEqual(['hello 4']);
    expect(sessions[4]!.prompts).toEqual([]);

    const dequeuedEvents = h.storage.listEventsSince(documentId, null).filter((e) => e.eventType === 'agent_dequeued');
    expect(dequeuedEvents).toHaveLength(1);
    expect(dequeuedEvents[0]!.conversationId).toBe(conversations[3]!.id);

    // Conv 5's queue position is re-emitted as 1 now that Conv 4 left the queue.
    const requeuedEvents = h.storage
      .listEventsSince(documentId, null)
      .filter((e) => e.eventType === 'agent_queued' && e.conversationId === conversations[4]!.id);
    expect(requeuedEvents.at(-1)).toMatchObject({ data: { queuePosition: 1 } });

    // Conv 2 finishes next: releases a slot, dequeues Conv 5 (now the only queued entry) — FIFO.
    sessions[1]!.completeRun();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(statusOf(conversations[1]!.id)).toBe('idle');
    expect(statusOf(conversations[4]!.id)).toBe('working');
    expect(sessions[4]!.prompts).toEqual(['hello 5']);

    // Nothing left queued.
    expect(
      h.storage.listEventsSince(documentId, null).filter((e) => e.eventType === 'agent_dequeued'),
    ).toHaveLength(2);
  });

  it('an agent_error on one running conversation releases only its own slot and leaves the rest of the queue intact', async () => {
    conversations.forEach((conv, i) => void h.conversationService.send(conv.id, `hello ${i + 1}`));
    await flushMicrotasks();
    await flushMicrotasks();

    // Conv 2 (running) errors out.
    sessions[1]!.emitAgentError('boom');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(statusOf(conversations[1]!.id)).toBe('errored');
    expect(h.storage.getConversation(conversations[1]!.id)?.errorMessage).toBe('boom');

    // The other two originally-running conversations are completely unaffected.
    expect(statusOf(conversations[0]!.id)).toBe('working');
    expect(statusOf(conversations[2]!.id)).toBe('working');

    // Exactly one slot was freed, so exactly one queued conversation (the FIFO head, Conv 4) was
    // dequeued and started — Conv 5 stays queued, not corrupted or skipped over.
    expect(statusOf(conversations[3]!.id)).toBe('working');
    expect(sessions[3]!.prompts).toEqual(['hello 4']);
    expect(statusOf(conversations[4]!.id)).toBe('idle');
    expect(sessions[4]!.prompts).toEqual([]);

    const dequeuedEvents = h.storage.listEventsSince(documentId, null).filter((e) => e.eventType === 'agent_dequeued');
    expect(dequeuedEvents).toHaveLength(1);
    expect(dequeuedEvents[0]!.conversationId).toBe(conversations[3]!.id);

    // Conv 5 is still queued at position 1 and can still be driven to completion normally
    // afterwards — the error did not stall or corrupt the queue.
    const requeuedEvents = h.storage
      .listEventsSince(documentId, null)
      .filter((e) => e.eventType === 'agent_queued' && e.conversationId === conversations[4]!.id);
    expect(requeuedEvents.at(-1)).toMatchObject({ data: { queuePosition: 1 } });

    sessions[0]!.completeRun();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(statusOf(conversations[4]!.id)).toBe('working');
    expect(sessions[4]!.prompts).toEqual(['hello 5']);
  });
});
