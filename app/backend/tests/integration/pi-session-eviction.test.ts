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
import { FakeAgentSession } from '../../src/pi/fake-agent-session.js';
import { PrimaryService } from '../../src/conversation/primary-service.js';
import { ConcurrencyLimiter } from '../../src/conversation/concurrency-limiter.js';
import { ConflictService } from '../../src/edit/conflict-service.js';
import { EditService } from '../../src/edit/edit-service.js';
import { ConversationService } from '../../src/conversation/conversation-service.js';
import { newId } from '../../src/ids.js';
import type { ConversationRow, StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { AgentSessionLike } from '../../src/pi/agent-session-port.js';
import { waitFor } from '../contract/test-app.js';

/**
 * FIX 5: `PiService.sessions` previously never evicted a conversation's cached session once it
 * closed — every conversation's session stayed in the map for the process's entire remaining
 * lifetime. `ConversationService.close()` now evicts a closed conversation's session as soon as
 * nothing else needs it: immediately when there's no fold-summary to generate, or once the fold
 * flow (which itself still needs `getOrCreateSession` for the *closing* conversation, to ask its
 * own session for a synopsis) has finished with it.
 */

interface Harness {
  storage: StorageAdapter;
  documentService: DocumentService;
  conversationService: ConversationService;
  piService: PiService;
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

  return { storage, documentService, conversationService, piService };
}

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
    contextRevision,
    branchDepth: 1,
    seedSelection: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
}

function sessionsMap(piService: PiService): Map<string, AgentSessionLike> {
  return (piService as unknown as { sessions: Map<string, AgentSessionLike> }).sessions;
}

describe('FIX 5: PiService evicts a conversation\'s cached session once it closes', () => {
  it('evicts immediately on close() when there is no fold summary pending', () => {
    const h = buildHarness();
    const created = h.documentService.create('# Doc\n\nHello.\n', 'Doc');
    const documentId = created.document.id;
    const main = h.storage.getConversation(created.mainConversation.id)!;
    const branch = createBranch(h.storage, documentId, main.id, created.document.currentRevision);

    sessionsMap(h.piService).set(branch.id, new FakeAgentSession(branch.piSessionPath, []));
    expect(sessionsMap(h.piService).has(branch.id)).toBe(true);

    // No fold requested (`foldSummaryIntoParent: false`) — the session is dropped synchronously,
    // within `close()` itself, not left cached for the rest of the process's lifetime.
    h.conversationService.close(branch.id, false);

    expect(sessionsMap(h.piService).has(branch.id)).toBe(false);
  });

  it('does not evict the closing conversation\'s session before its fold-summary flow has finished using it, but does evict it once that flow completes', async () => {
    const h = buildHarness();
    const created = h.documentService.create('# Doc\n\nHello.\n', 'Doc');
    const documentId = created.document.id;
    const main = h.storage.getConversation(created.mainConversation.id)!;
    const branch = createBranch(h.storage, documentId, main.id, created.document.currentRevision);

    // Registered for both: the closing conversation's own session answers `generateFoldSynopsis`;
    // the parent's session receives the folded summary via `deliverFoldSummary`.
    sessionsMap(h.piService).set(branch.id, new FakeAgentSession(branch.piSessionPath, []));
    sessionsMap(h.piService).set(main.id, new FakeAgentSession(main.piSessionPath, []));

    h.conversationService.close(branch.id, true);

    // Immediately after `close()` returns, the fold-summary flow is still in flight (it needs
    // `generateFoldSynopsis` against the closing conversation's own session first) — evicting
    // the session here would break that still-pending use of it.
    expect(sessionsMap(h.piService).has(branch.id)).toBe(true);

    // Once the (fire-and-forget) fold flow actually completes, the closing conversation's session
    // is evicted — but the parent's is left alone; it's still an open, live conversation.
    await waitFor(() => !sessionsMap(h.piService).has(branch.id), {
      timeoutMs: 2000,
      message: "expected the closing conversation's session to be evicted once its fold flow finished",
    });
    expect(sessionsMap(h.piService).has(main.id)).toBe(true);

    const events = h.storage.listEventsSince(documentId, null);
    expect(events.some((e) => e.eventType === 'conversation_summary_folded')).toBe(true);
  });
});
