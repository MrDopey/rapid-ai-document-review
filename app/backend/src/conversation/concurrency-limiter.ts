import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import type { StorageAdapter } from '../storage/storage-adapter.ts';

interface QueueEntry {
  conversationId: string;
  turnId: string;
  /** Captured at submission time (FR-015a) — the revision a queued send was requested against,
   *  independent of whenever it actually gets dequeued. Not otherwise consumed here; kept for
   *  callers/telemetry that need to know what the request "meant" at submission time. */
  contextRevision: number;
  run: () => Promise<void>;
}

export interface AcquireResult {
  queued: boolean;
  queuePosition?: number;
  /** Present only when `queued` is false — the promise driving the immediately-started run, so
   *  the caller can await/catch an *immediate* failure (e.g. for `AGENT_UNAVAILABLE`) without
   *  blocking on the whole turn. Already has an internal `.catch` attached, so leaving it
   *  unawaited never produces an unhandled rejection. */
  immediateRun?: Promise<void>;
}

/**
 * Enforces `max_concurrent_agents` (FR-015/FR-015a). Only conversations with an actively-running
 * turn count toward the limit — a queued prompt does not, and no conversation (including Primary
 * or review, once those concepts exist) is exempt. Pi's own in-conversation steer/follow-up
 * queuing is a different concern (agent-tools.md §Event bridge contract) — this is strictly the
 * cross-conversation admission queue.
 */
export class ConcurrencyLimiter {
  private readonly running = new Map<string, Set<string>>(); // documentId -> running conversationIds
  private readonly queues = new Map<string, QueueEntry[]>(); // documentId -> FIFO queue

  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly publisher: EventPublisher;

  constructor(storage: StorageAdapter, eventService: EventService, eventHub: EventHub) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.publisher = new EventPublisher(eventService, eventHub);
  }

  /**
   * Starts `run` immediately if under the limit, else FIFO-queues it and emits `agent_queued`.
   * Cancellation is not supported in v1 — once submitted, a queued prompt always eventually runs.
   *
   * FIX 2: a conversation already admitted (its own turn still in flight) is never admitted a
   * second time, regardless of how much headroom is left under `max_concurrent_agents` — it is
   * queued instead, same as any other over-the-limit submission. Without this, a fast overlapping
   * second `send()` on the same conversation would reach `session.prompt()` while the first turn
   * was still streaming, which throws synchronously ("already streaming") and flips the
   * conversation to `errored` via the event bridge — a confusing failure mode for what is really
   * just a double-send, not a genuine agent error.
   */
  acquire(
    documentId: string,
    conversationId: string,
    turnId: string,
    contextRevision: number,
    run: () => Promise<void>,
  ): AcquireResult {
    const limit = this.storage.getSettings().maxConcurrentAgents;
    const runningSet = this.runningSetFor(documentId);

    if (runningSet.size < limit && !runningSet.has(conversationId)) {
      runningSet.add(conversationId);
      const immediateRun = run();
      immediateRun.catch(() => {
        // Swallowed here so an unawaited immediateRun never surfaces as an unhandled rejection;
        // the caller may still await/catch this exact promise for the immediate-failure case.
      });
      return { queued: false, immediateRun };
    }

    const queue = this.queueFor(documentId);
    queue.push({ conversationId, turnId, contextRevision, run });
    const queuePosition = queue.length;
    this.publishQueued(documentId, conversationId, queuePosition, runningSet.size, limit);
    return { queued: true, queuePosition };
  }

  /** Frees `conversationId`'s running slot and starts the next queued turn, if any. */
  release(documentId: string, conversationId: string): void {
    const runningSet = this.runningSetFor(documentId);
    runningSet.delete(conversationId);

    const queue = this.queueFor(documentId);
    const next = queue.shift();
    if (!next) return;

    runningSet.add(next.conversationId);
    this.publishDequeued(documentId, next.conversationId, next.turnId);
    this.reemitQueuePositions(documentId);

    const started = next.run();
    started.catch(() => {
      // A dequeued run's failure is surfaced entirely through the event stream (agent_error +
      // conversation_status_changed) — nothing here awaits this promise.
    });
  }

  private runningSetFor(documentId: string): Set<string> {
    let set = this.running.get(documentId);
    if (!set) {
      set = new Set();
      this.running.set(documentId, set);
    }
    return set;
  }

  private queueFor(documentId: string): QueueEntry[] {
    let queue = this.queues.get(documentId);
    if (!queue) {
      queue = [];
      this.queues.set(documentId, queue);
    }
    return queue;
  }

  private reemitQueuePositions(documentId: string): void {
    const limit = this.storage.getSettings().maxConcurrentAgents;
    const runningCount = this.runningSetFor(documentId).size;
    const queue = this.queueFor(documentId);
    queue.forEach((entry, index) => {
      this.publishQueued(documentId, entry.conversationId, index + 1, runningCount, limit);
    });
  }

  private publishQueued(
    documentId: string,
    conversationId: string,
    queuePosition: number,
    runningCount: number,
    limit: number,
  ): void {
    this.publish({
      type: 'agent_queued',
      sequence: null,
      documentId,
      conversationId,
      at: new Date().toISOString(),
      data: { queuePosition, runningCount, limit },
    });
  }

  private publishDequeued(documentId: string, conversationId: string, turnId: string): void {
    this.publish({
      type: 'agent_dequeued',
      sequence: null,
      documentId,
      conversationId,
      at: new Date().toISOString(),
      data: { turnId },
    });
  }

  private publish(frame: ApplicationEvent): void {
    this.publisher.publishFrame(frame);
  }
}
