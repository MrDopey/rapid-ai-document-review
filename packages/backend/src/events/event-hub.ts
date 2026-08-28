import { EPHEMERAL_EVENT_TYPES, type ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { ConversationDto, DocumentDto } from '@rapid-ai-document-review/shared/contracts/http';
import { EventService } from './event-service.js';
import type { RunBuffer } from './run-buffer.js';
import { logger } from '../logging.js';

const BACKPRESSURE_THRESHOLD_BYTES = 1_000_000; // 1MB, per websocket-events.md ordering guarantee 6

export interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
}

export interface DocumentSnapshot {
  document: DocumentDto & { content: string };
  conversations: ConversationDto[];
}

export type SnapshotProvider = (documentId: string) => DocumentSnapshot;

interface Subscription {
  socket: SocketLike;
  documentId: string;
}

const SOCKET_OPEN = 1;

export type InternalEventListener = (frame: ApplicationEvent) => void;

/** One conversation's currently-streaming assistant message, tracked so a reconnecting client can
 *  be caught up on its partial content (FR-037a) — see `EventHub.registerActiveMessage` below. */
interface ActiveMessage {
  documentId: string;
  messageId: string;
  textKey: string;
  reasoningKey: string;
}

/**
 * Fans out the application event stream to connected WebSocket clients (contracts/websocket-events.md).
 * Persisted frames are looked up from EventService for replay; ephemeral frames (text_delta,
 * thinking_delta, tool_output_delta) are broadcast live only and dropped under backpressure —
 * persisted frames are never dropped.
 */
export class EventHub {
  private readonly subscriptions = new Set<Subscription>();
  /** In-process listeners (as opposed to WebSocket subscriptions above) — every broadcast frame
   *  is also handed to these, regardless of any socket being connected. This is the seam
   *  `PrimaryService` (US5) uses to wait for a specific conversation's `agent_completed` frame
   *  when a "switch when idle" designation is pending, without EventHub needing to know anything
   *  about Primary semantics. */
  private readonly internalListeners = new Set<InternalEventListener>();

  /** Set once by the first `EventBridge` constructed (there is exactly one `RunBuffer` instance
   *  for the app's lifetime, so this is idempotent) — lets `subscribe()` read buffered partial
   *  text/reasoning for FR-037a without EventHub needing a constructor-time dependency on it. */
  private runBuffer: RunBuffer | null = null;
  /** conversationId -> its one currently-streaming assistant message, if any (FR-037a). Cleared on
   *  `message_end` or run settle (see `EventBridge`). */
  private readonly activeMessages = new Map<string, ActiveMessage>();

  constructor(
    private readonly eventService: EventService,
    private readonly getSnapshot: SnapshotProvider,
  ) {}

  addListener(listener: InternalEventListener): void {
    this.internalListeners.add(listener);
  }

  removeListener(listener: InternalEventListener): void {
    this.internalListeners.delete(listener);
  }

  setRunBuffer(runBuffer: RunBuffer): void {
    this.runBuffer = runBuffer;
  }

  /** `EventBridge` calls this on `message_start` for an assistant message, and clears it on
   *  `message_end`/settle — the bookkeeping `subscribe()` needs to replay a mid-run reconnect's
   *  partial response (FR-037a, websocket-events.md contract test expectation 4a). */
  registerActiveMessage(conversationId: string, info: ActiveMessage): void {
    this.activeMessages.set(conversationId, info);
  }

  clearActiveMessage(conversationId: string): void {
    this.activeMessages.delete(conversationId);
  }

  subscribe(socket: SocketLike, documentId: string, sinceSequence: number | null): void {
    const currentSequence = this.eventService.getLatestSequence(documentId);
    const rows = sinceSequence === null ? [] : this.eventService.getEventsSince(documentId, sinceSequence);

    const subscribedFrame = {
      type: 'subscribed' as const,
      sequence: null,
      currentSequence,
      replayCount: rows.length,
      snapshot: this.getSnapshot(documentId),
    };
    socket.send(JSON.stringify(subscribedFrame));

    for (const row of rows) {
      const frame = {
        type: row.eventType,
        sequence: row.sequence,
        documentId: row.documentId,
        conversationId: row.conversationId,
        at: row.createdAt,
        data: row.data,
      };
      socket.send(JSON.stringify(frame));
    }

    // FR-037a: a client reconnecting while a response is still streaming sees the partial text
    // (and, if buffered, reasoning) produced so far, as one caught-up chunk sent immediately after
    // replay and before any subsequent live delta — the ordering guaranteed by this being
    // synchronous with everything above, on a single-threaded event loop, before this socket is
    // ever added to `subscriptions` for live broadcast below.
    if (this.runBuffer) {
      for (const [conversationId, active] of this.activeMessages) {
        if (active.documentId !== documentId) continue;
        const reasoning = this.runBuffer.getBuffer(active.reasoningKey);
        if (reasoning) {
          socket.send(
            JSON.stringify({
              type: 'thinking_delta',
              sequence: null,
              documentId,
              conversationId,
              at: new Date().toISOString(),
              data: { messageId: active.messageId, delta: reasoning },
            }),
          );
        }
        const text = this.runBuffer.getBuffer(active.textKey);
        if (text) {
          socket.send(
            JSON.stringify({
              type: 'text_delta',
              sequence: null,
              documentId,
              conversationId,
              at: new Date().toISOString(),
              data: { messageId: active.messageId, delta: text },
            }),
          );
        }
      }
    }

    this.subscriptions.add({ socket, documentId });
  }

  unsubscribe(socket: SocketLike): void {
    for (const sub of this.subscriptions) {
      if (sub.socket === socket) {
        this.subscriptions.delete(sub);
      }
    }
  }

  broadcast(documentId: string, frame: ApplicationEvent): void {
    for (const listener of this.internalListeners) {
      try {
        listener(frame);
      } catch (err) {
        // No `event` field: an in-process listener throwing is an internal wiring bug, not one of
        // the closed vocabulary's domain events (FR-042).
        logger.error({ documentId, frameType: frame.type, err }, 'internal event listener threw');
      }
    }

    const isEphemeral = (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(frame.type);
    const payload = JSON.stringify(frame);
    for (const sub of this.subscriptions) {
      if (sub.documentId !== documentId) continue;
      if (sub.socket.readyState !== SOCKET_OPEN) continue;
      if (isEphemeral && sub.socket.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
        // No `event` field: dropping a frame is the absence of an event, not one of the closed
        // vocabulary's own values (FR-042); `frameType` already names what was dropped.
        logger.warn({ documentId, frameType: frame.type }, 'dropped ephemeral frame under backpressure');
        continue;
      }
      sub.socket.send(payload);
    }
  }
}
