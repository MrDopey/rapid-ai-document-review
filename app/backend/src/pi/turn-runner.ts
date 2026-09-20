import { newId } from '../ids.ts';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import type { RunBuffer } from '../events/run-buffer.ts';
import type { AcquireResult, ConcurrencyLimiter } from '../conversation/concurrency-limiter.ts';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.ts';
import { EventBridge } from './event-bridge.ts';
import type { PiService } from './pi-service.ts';

/**
 * Shared turn-starting wiring used by both `ConversationService.send()` and
 * `EditService.requestReplacement()`. Both services depend on this collaborator rather than one
 * of them calling into the other's turn-starting method directly, which would create a
 * `PiService <-> EditService <-> ConversationService` construction cycle — `PiService` already
 * depends on `EditService` (to build the `propose_document_edit` tool), and
 * `EditService`/`ConversationService` both need to start a turn against `PiService`.
 */
export class TurnRunner {
  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly runBuffer: RunBuffer;
  private readonly piService: PiService;
  private readonly concurrencyLimiter: ConcurrencyLimiter;

  constructor(
    storage: StorageAdapter,
    eventService: EventService,
    eventHub: EventHub,
    runBuffer: RunBuffer,
    piService: PiService,
    concurrencyLimiter: ConcurrencyLimiter,
  ) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.runBuffer = runBuffer;
    this.piService = piService;
    this.concurrencyLimiter = concurrencyLimiter;
  }

  /**
   * Starts a new turn for `conversation` with `message`: a fresh `EventBridge` (its release
   * callback wired to free this conversation's `ConcurrencyLimiter` slot once the turn settles),
   * admitted through `ConcurrencyLimiter.acquire` (which runs it immediately if under
   * `maxConcurrentAgents`, else FIFO-queues it). Returns the same `AcquireResult` shape
   * `ConcurrencyLimiter.acquire` does, so callers can handle an immediate failure
   * (`AGENT_UNAVAILABLE`) themselves.
   */
  start(conversation: ConversationRow, message: string): AcquireResult {
    const turnId = newId('turn');
    const bridge = new EventBridge(
      this.storage,
      this.eventService,
      this.eventHub,
      this.runBuffer,
      { documentId: conversation.documentId, conversationId: conversation.id, turnId },
      () => this.concurrencyLimiter.release(conversation.documentId, conversation.id),
    );

    // 011-linear-thread-mode: a Thread's turn runs through the shared-session leaf-repositioning
    // path instead of the ordinary per-conversation-file one — see `PiService.sendOnThread`.
    const run = () =>
      conversation.kind === 'thread-root' || conversation.kind === 'thread-branch'
        ? this.piService.sendOnThread(conversation, message, bridge)
        : this.piService.send(conversation, message, bridge);

    return this.concurrencyLimiter.acquire(
      conversation.documentId,
      conversation.id,
      turnId,
      conversation.contextRevision,
      run,
    );
  }
}
