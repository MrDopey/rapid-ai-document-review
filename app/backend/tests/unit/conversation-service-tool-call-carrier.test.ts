import { describe, expect, it } from 'vitest';
import { computeIsToolCallCarrier } from '@rapid-ai-document-review/shared/domain';
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

/**
 * `MessageDto.isToolCallCarrier` (shared/contracts/http.ts) is computed fresh from the stored
 * `message_completed` event's `text`/`reasoning` facts by the pure `computeIsToolCallCarrier`
 * (shared/domain) — not persisted anywhere. That function is the single source of truth used by
 * both the backend's `message-log.ts` `buildMessages` (this file's first describe block tests it
 * directly, with no service harness) and the frontend's live WS handler.
 *
 * The second describe block below is genuinely integration-level: it exercises the full
 * `ConversationService`/`EventService` join of `tool_started`/`tool_completed` events onto a
 * carrier message's `toolCalls`, which `computeIsToolCallCarrier` itself has no part in.
 */

interface Harness {
  storage: SqliteStorageAdapter;
  eventService: EventService;
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

  return { storage, eventService, documentService, conversationService };
}

function appendMessageCompleted(
  h: Harness,
  documentId: string,
  conversationId: string,
  data: { messageId: string; role: 'user' | 'assistant'; text: string; reasoning: string | null },
): void {
  h.eventService.append(documentId, conversationId, 'message_completed', data);
}

describe('computeIsToolCallCarrier (pure function, shared/domain)', () => {
  it('is true for an empty segment (no text, no reasoning)', () => {
    expect(computeIsToolCallCarrier({ text: '', reasoning: null })).toBe(true);
  });

  it('is false for a normal reply with text', () => {
    expect(computeIsToolCallCarrier({ text: 'Here is the answer.', reasoning: null })).toBe(false);
  });

  it('is false for a reasoning-only segment (empty text, non-empty reasoning)', () => {
    expect(computeIsToolCallCarrier({ text: '', reasoning: 'Thinking it through.' })).toBe(false);
  });
});

describe('ConversationService.getOne: toolCalls is populated at read time (009-agent-activity-logging)', () => {
  it('joins tool_started/tool_completed events sharing a messageId into the carrier message toolCalls', () => {
    const h = buildHarness();
    const created = h.documentService.create('# Doc\n\nHello.\n', 'Doc');
    const documentId = created.document.id;
    const mainId = created.mainConversation.id;

    appendMessageCompleted(h, documentId, mainId, {
      messageId: 'msg_carrier',
      role: 'assistant',
      text: '',
      reasoning: null,
    });
    h.eventService.append(documentId, mainId, 'tool_started', {
      toolCallId: 'tc_1',
      toolName: 'web_search',
      messageId: 'msg_carrier',
      args: { query: 'rapid ai document review' },
    });
    h.eventService.append(documentId, mainId, 'tool_completed', {
      toolCallId: 'tc_1',
      toolName: 'web_search',
      messageId: 'msg_carrier',
      isError: false,
      resultText: 'Web search: 1 result',
      failureReason: null,
      stagedEditId: null,
    });

    const { messages } = h.conversationService.getOne(mainId);
    const carrier = messages.find((m) => m.id === 'msg_carrier');
    expect(carrier?.toolCalls).toEqual([
      {
        toolCallId: 'tc_1',
        name: 'web_search',
        args: { query: 'rapid ai document review' },
        resultText: 'Web search: 1 result',
        failureReason: null,
        stagedEditId: null,
      },
    ]);
  });

  it('leaves toolCalls empty for a message with no associated tool call events', () => {
    const h = buildHarness();
    const created = h.documentService.create('# Doc\n\nHello.\n', 'Doc');
    const documentId = created.document.id;
    const mainId = created.mainConversation.id;

    appendMessageCompleted(h, documentId, mainId, {
      messageId: 'msg_reply',
      role: 'assistant',
      text: 'Here is the answer.',
      reasoning: null,
    });

    const { messages } = h.conversationService.getOne(mainId);
    const reply = messages.find((m) => m.id === 'msg_reply');
    expect(reply?.toolCalls).toEqual([]);
  });
});
