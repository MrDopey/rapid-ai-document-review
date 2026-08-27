import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import { logger } from '../logging.js';
import type { EventHub } from '../events/event-hub.js';
import type { EventService } from '../events/event-service.js';
import type { RunBuffer } from '../events/run-buffer.js';
import type { ConversationStatus, StorageAdapter } from '../storage/storage-adapter.js';
import type { AgentSessionEventLike } from './agent-session-port.js';

export interface EventBridgeContext {
  documentId: string;
  conversationId: string;
  turnId: string;
}

function extractStagedEditId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'stagedEditId' in result) {
    const value = (result as { stagedEditId?: unknown }).stagedEditId;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * Translates one Pi `AgentSession`'s event stream into the application event stream, per
 * contracts/agent-tools.md §Event bridge contract — the only place Pi event types cross into the
 * rest of the backend (Constitution Principle II). One instance is created per agent turn
 * (send/refresh-send/retry) by ConversationService and discarded once the turn settles.
 *
 * `text_delta`/`thinking_delta` are ephemeral: broadcast live via EventHub and buffered in
 * RunBuffer for mid-run reconnect replay (FR-037a), but never persisted. Every other event type
 * is persisted via EventService and broadcast. Once a run has settled (agent_settled/agent_error),
 * any further event for it is logged at `warn` and discarded — it can never retroactively regain
 * a status change or a proposal (agent-tools.md §Late and orphaned events).
 */
export class EventBridge {
  private settled = false;
  private readonly cleanupFns: Array<() => void> = [];

  constructor(
    private readonly storage: StorageAdapter,
    private readonly eventService: EventService,
    private readonly eventHub: EventHub,
    private readonly runBuffer: RunBuffer,
    private readonly ctx: EventBridgeContext,
    private readonly onSettle?: () => void,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** Registered by PiService right after subscribing to the session; run once, on settle. */
  addCleanup(fn: () => void): void {
    if (this.settled) {
      fn();
      return;
    }
    this.cleanupFns.push(fn);
  }

  handle(event: AgentSessionEventLike): void {
    if (this.settled) {
      logger.warn(
        {
          event: 'pi_event_discarded',
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          piEventType: event.type,
        },
        'discarding Pi event for an already-settled run',
      );
      return;
    }

    switch (event.type) {
      case 'agent_start':
        this.setStatus('working');
        this.publish({
          type: 'agent_started',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { turnId: this.ctx.turnId },
        });
        break;

      case 'message_start':
        this.publish({
          type: 'message_started',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { messageId: event.messageId, role: event.role },
        });
        break;

      case 'message_update':
        if (event.update.type === 'text_delta') {
          this.runBuffer.append(this.textBufferKey(event.messageId), event.update.delta);
          this.broadcastEphemeral({
            type: 'text_delta',
            sequence: null,
            documentId: this.ctx.documentId,
            conversationId: this.ctx.conversationId,
            at: new Date().toISOString(),
            data: { messageId: event.messageId, delta: event.update.delta },
          });
        } else if (event.update.type === 'thinking_delta') {
          if (!this.thinkingVisible()) break;
          this.runBuffer.append(this.reasoningBufferKey(event.messageId), event.update.delta);
          this.broadcastEphemeral({
            type: 'thinking_delta',
            sequence: null,
            documentId: this.ctx.documentId,
            conversationId: this.ctx.conversationId,
            at: new Date().toISOString(),
            data: { messageId: event.messageId, delta: event.update.delta },
          });
        }
        break;

      case 'message_end':
        this.publish({
          type: 'message_completed',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: {
            messageId: event.messageId,
            role: event.role,
            text: event.text,
            reasoning: this.thinkingVisible() ? (event.reasoning ?? null) : null,
          },
        });
        this.runBuffer.clear(this.textBufferKey(event.messageId));
        this.runBuffer.clear(this.reasoningBufferKey(event.messageId));
        break;

      case 'tool_execution_start':
        this.publish({
          type: 'tool_started',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { toolCallId: event.toolCallId, toolName: event.toolName },
        });
        break;

      case 'tool_execution_update':
        this.broadcastEphemeral({
          type: 'tool_output_delta',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { toolCallId: event.toolCallId, delta: event.delta },
        });
        break;

      case 'tool_execution_end':
        this.publish({
          type: 'tool_completed',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            stagedEditId: extractStagedEditId(event.result),
          },
        });
        break;

      case 'agent_settled':
        this.setStatus('idle');
        this.publish({
          type: 'agent_completed',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { turnId: this.ctx.turnId },
        });
        this.finalizeSettle();
        break;

      case 'agent_error':
        this.setStatus('errored', event.message);
        this.publish({
          type: 'agent_error',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { message: event.message, retryable: true },
        });
        this.finalizeSettle();
        break;

      // `agent_end` always precedes `agent_settled` for the same run (FakePiSession.completeRun,
      // and the real SDK per research R1) — acting only on `agent_settled` avoids emitting
      // `agent_completed` twice for one run. Pi's own context management is not application
      // state (Principle II), so compaction and the in-conversation steer/follow-up queue are
      // intentionally not surfaced (agent-tools.md §Event bridge contract).
      case 'agent_end':
      case 'compaction_start':
      case 'compaction_end':
      case 'queue_update':
        break;

      default:
        break;
    }
  }

  private thinkingVisible(): boolean {
    return this.storage.getSettings().thinkingVisible;
  }

  private textBufferKey(messageId: string): string {
    return `${this.ctx.turnId}:${messageId}:text`;
  }

  private reasoningBufferKey(messageId: string): string {
    return `${this.ctx.turnId}:${messageId}:reasoning`;
  }

  private setStatus(status: ConversationStatus, errorMessage: string | null = null): void {
    const current = this.storage.getConversation(this.ctx.conversationId);
    if (!current || current.status === status) return;
    const previousStatus = current.status;
    this.storage.updateConversation(this.ctx.conversationId, {
      status,
      errorMessage: status === 'errored' ? errorMessage : null,
    });
    this.publish({
      type: 'conversation_status_changed',
      sequence: null,
      documentId: this.ctx.documentId,
      conversationId: this.ctx.conversationId,
      at: new Date().toISOString(),
      data: { status, previousStatus },
    });
  }

  private finalizeSettle(): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettle?.();
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns.length = 0;
  }

  private publish(frame: ApplicationEvent): void {
    const persisted = this.eventService.append(this.ctx.documentId, frame.conversationId, frame.type, frame.data);
    this.eventHub.broadcast(this.ctx.documentId, {
      ...frame,
      sequence: persisted.sequence,
      at: persisted.createdAt,
    });
  }

  private broadcastEphemeral(frame: ApplicationEvent): void {
    this.eventHub.broadcast(this.ctx.documentId, frame);
  }
}
