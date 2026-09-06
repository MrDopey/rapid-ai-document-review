import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type {
  ClearPrimaryResponse,
  DesignatePrimaryResponse,
  PrimaryWhenBusy,
} from '@rapid-ai-document-review/shared/contracts/http';
import { logger } from '../logging.ts';
import type { EventHub, InternalEventListener } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import type { PrimaryMutex } from '../pi/primary-mutex.ts';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.ts';

export class PrimaryConversationNotFoundError extends Error {}
export class PrimaryConversationClosedError extends Error {}
export class PrimaryConversationErroredError extends Error {}

export class PrimaryTargetBusyError extends Error {
  readonly details: {
    currentPrimaryId: string | null;
    targetId: string;
    busyConversationId: string;
  };

  constructor(
    message: string,
    details: { currentPrimaryId: string | null; targetId: string; busyConversationId: string },
  ) {
    super(message);
    this.details = details;
  }
}

interface PendingDeferredSwitch {
  targetId: string;
  busyConversationId: string;
  unsubscribe: () => void;
}

/**
 * Enforces the at-most-one-Primary invariant above the DB's partial unique index
 * (data-model.md §5) and implements the designation/switch semantics of FR-027 through FR-030 and
 * FR-038a. The sole writer of `conversation.is_primary`. Holds `PrimaryMutex` around the actual
 * flip — the same mutex instance `document-tools.ts` locks for the whole duration of a
 * `propose_document_edit` execution — so a switch waits for any in-flight proposal to finish, and
 * a proposal that starts captures the Primary designation for its whole call
 * (http-api.md §POST /primary "mutually exclusive").
 */
export class PrimaryService {
  /** At most one pending "switch when idle" request per document (FR-029a) — keyed by
   *  `documentId`. A new designation request for the same document replaces it. */
  private readonly pending = new Map<string, PendingDeferredSwitch>();

  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly primaryMutex: PrimaryMutex;
  private readonly publisher: EventPublisher;

  constructor(
    storage: StorageAdapter,
    eventService: EventService,
    eventHub: EventHub,
    primaryMutex: PrimaryMutex,
  ) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.primaryMutex = primaryMutex;
    this.publisher = new EventPublisher(eventService, eventHub);
  }

  /**
   * FR-027/FR-028/FR-029/FR-029a/FR-030/FR-038a. `whenBusy` is required only when the current
   * Primary or the target is `working` at the instant of the call; otherwise the switch is
   * immediate. Never throws for "no Primary yet" — that is a valid state (FR-027a), not an error.
   */
  async designate(
    conversationId: string,
    whenBusy?: PrimaryWhenBusy,
  ): Promise<DesignatePrimaryResponse> {
    const target = this.getOrThrow(conversationId);
    if (target.status === 'closed') {
      throw new PrimaryConversationClosedError(
        'A closed conversation cannot be designated Primary',
      );
    }
    if (target.status === 'errored') {
      throw new PrimaryConversationErroredError(
        'An errored conversation cannot be designated Primary',
      );
    }

    // A new designation request supersedes any pending deferred switch for this document,
    // regardless of what this request itself goes on to do (FR-029a).
    this.cancelPending(target.documentId);

    if (target.isPrimary) {
      return {
        primaryConversationId: target.id,
        applied: 'already_primary',
        previousPrimaryId: target.id,
        previousPrimaryStillWorking: false,
      };
    }

    const currentPrimary = this.storage.getPrimaryConversation(target.documentId);
    const currentPrimaryBusy = currentPrimary?.status === 'working';
    const targetBusy = target.status === 'working';

    if ((!currentPrimaryBusy && !targetBusy) || whenBusy === 'switch_now') {
      return this.performSwitch(target.documentId, target.id, currentPrimary, 'immediately');
    }

    const busyConversationId = currentPrimaryBusy ? currentPrimary!.id : target.id;

    if (!whenBusy) {
      throw new PrimaryTargetBusyError(
        'The current Primary or the target conversation is actively working',
        {
          currentPrimaryId: currentPrimary?.id ?? null,
          targetId: target.id,
          busyConversationId,
        },
      );
    }

    if (whenBusy === 'cancel') {
      return {
        primaryConversationId: currentPrimary?.id ?? null,
        applied: 'cancelled',
        previousPrimaryId: currentPrimary?.id ?? null,
        previousPrimaryStillWorking: currentPrimaryBusy,
      };
    }

    // whenBusy === 'switch_when_idle'
    this.scheduleDeferredSwitch(target.documentId, target.id, busyConversationId);
    return {
      primaryConversationId: currentPrimary?.id ?? null,
      applied: 'deferred_until_idle',
      previousPrimaryId: currentPrimary?.id ?? null,
      previousPrimaryStillWorking: currentPrimaryBusy,
    };
  }

  /** `DELETE /api/conversations/:id/primary` (FR-027a): clears the designation without
   *  nominating a replacement. A no-op if `conversationId` isn't currently Primary. */
  async clear(conversationId: string): Promise<ClearPrimaryResponse> {
    const conversation = this.getOrThrow(conversationId);
    if (!conversation.isPrimary) {
      return { primaryConversationId: null, previousPrimaryId: null };
    }

    this.cancelPending(conversation.documentId);
    await this.primaryMutex.withLock(conversation.documentId, () => {
      this.storage.updateConversation(conversationId, { isPrimary: false });
      this.publish(conversation.documentId, null, 'primary_changed', {
        primaryConversationId: null,
        previousPrimaryId: conversationId,
        applied: 'cleared',
        previousPrimaryStillWorking: conversation.status === 'working',
      });
    });
    return { primaryConversationId: null, previousPrimaryId: conversationId };
  }

  /**
   * Called by `ConversationService.close()` once a conversation that *was* Primary has just been
   * marked `closed` (FR-027a) — clears the flag without nominating a replacement. The caller is
   * expected to only call this when the conversation being closed was actually Primary; safe to
   * call on a conversation with no `is_primary` flag set regardless (nothing to clear).
   */
  closeClears(conversationId: string): void {
    const conversation = this.storage.getConversation(conversationId);
    if (!conversation || !conversation.isPrimary) return;
    this.storage.updateConversation(conversationId, { isPrimary: false });
    this.publish(conversation.documentId, null, 'primary_changed', {
      primaryConversationId: null,
      previousPrimaryId: conversationId,
      applied: 'cleared',
      previousPrimaryStillWorking: false,
    });
  }

  /** Registers a one-time listener for `agent_completed` on `busyConversationId`. When it fires,
   *  re-validates the target before switching — this is what makes FR-029a's cancellation "free":
   *  if the target has closed or errored by then, the switch simply never happens, and nothing
   *  reports it as an error. */
  private scheduleDeferredSwitch(
    documentId: string,
    targetId: string,
    busyConversationId: string,
  ): void {
    const listener: InternalEventListener = (frame) => {
      if (frame.documentId !== documentId) return;
      if (frame.type !== 'agent_completed') return;
      if (frame.conversationId !== busyConversationId) return;
      this.eventHub.removeListener(listener);
      this.pending.delete(documentId);
      void this.executeDeferredSwitch(documentId, targetId).catch((err) => {
        // No `event` field: the switch never completed, so no `primary_changed` frame was
        // published for it — nothing in the closed vocabulary names this failure (FR-042).
        logger.error(
          { documentId, targetId, err: err instanceof Error ? err.message : String(err) },
          'deferred Primary switch failed',
        );
      });
    };
    this.eventHub.addListener(listener);
    this.pending.set(documentId, {
      targetId,
      busyConversationId,
      unsubscribe: () => this.eventHub.removeListener(listener),
    });
  }

  private async executeDeferredSwitch(documentId: string, targetId: string): Promise<void> {
    const target = this.storage.getConversation(targetId);
    if (!target || target.status === 'closed' || target.status === 'errored') {
      // FR-029a: cancelled without effect, no error surfaced, current Primary unchanged. No
      // `event` field: nothing changed, so no `primary_changed` frame fires for this path (FR-042).
      logger.info(
        { documentId, targetId },
        'deferred Primary switch cancelled: target no longer eligible',
      );
      return;
    }
    if (target.isPrimary) return; // already Primary somehow (e.g. a later request already applied it)

    const currentPrimary = this.storage.getPrimaryConversation(documentId);
    await this.performSwitch(documentId, targetId, currentPrimary, 'deferred_until_idle');
  }

  private cancelPending(documentId: string): void {
    const existing = this.pending.get(documentId);
    if (existing) {
      existing.unsubscribe();
      this.pending.delete(documentId);
    }
  }

  /** The only place `is_primary` is ever written for a switch (as opposed to `clear`/
   *  `closeClears`). Runs inside `PrimaryMutex` so it serializes against any in-flight
   *  `propose_document_edit` execution for this document. */
  private performSwitch(
    documentId: string,
    targetId: string,
    previousPrimary: ConversationRow | null,
    applied: 'immediately' | 'deferred_until_idle',
  ): Promise<DesignatePrimaryResponse> {
    return this.primaryMutex.withLock(documentId, () => {
      const target = this.storage.getConversation(targetId);
      if (!target)
        throw new PrimaryConversationNotFoundError(`Conversation not found: ${targetId}`);

      const freshPrevious = previousPrimary
        ? this.storage.getConversation(previousPrimary.id)
        : null;
      const previousStillWorking = freshPrevious?.status === 'working';

      if (freshPrevious && freshPrevious.id !== target.id) {
        this.storage.updateConversation(freshPrevious.id, { isPrimary: false });
      }
      this.storage.updateConversation(target.id, { isPrimary: true });

      this.publish(documentId, null, 'primary_changed', {
        primaryConversationId: target.id,
        previousPrimaryId: freshPrevious?.id ?? null,
        applied,
        previousPrimaryStillWorking: previousStillWorking,
      });

      return {
        primaryConversationId: target.id,
        applied,
        previousPrimaryId: freshPrevious?.id ?? null,
        previousPrimaryStillWorking: previousStillWorking,
      };
    });
  }

  private getOrThrow(conversationId: string): ConversationRow {
    const conversation = this.storage.getConversation(conversationId);
    if (!conversation)
      throw new PrimaryConversationNotFoundError(`Conversation not found: ${conversationId}`);
    return conversation;
  }

  private publish(
    documentId: string,
    conversationId: string | null,
    type: ApplicationEvent['type'],
    data: unknown,
  ): void {
    this.publisher.publish(documentId, conversationId, type, data);
  }
}
