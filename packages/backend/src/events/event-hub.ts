import { EPHEMERAL_EVENT_TYPES, type ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { ConversationDto, DocumentDto } from '@rapid-ai-document-review/shared/contracts/http';
import { EventService } from './event-service.js';
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

/**
 * Fans out the application event stream to connected WebSocket clients (contracts/websocket-events.md).
 * Persisted frames are looked up from EventService for replay; ephemeral frames (text_delta,
 * thinking_delta, tool_output_delta) are broadcast live only and dropped under backpressure —
 * persisted frames are never dropped.
 */
export class EventHub {
  private readonly subscriptions = new Set<Subscription>();

  constructor(
    private readonly eventService: EventService,
    private readonly getSnapshot: SnapshotProvider,
  ) {}

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
    const isEphemeral = (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(frame.type);
    const payload = JSON.stringify(frame);
    for (const sub of this.subscriptions) {
      if (sub.documentId !== documentId) continue;
      if (sub.socket.readyState !== SOCKET_OPEN) continue;
      if (isEphemeral && sub.socket.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
        logger.warn({ event: 'ws_backpressure_drop', documentId, frameType: frame.type }, 'dropped ephemeral frame under backpressure');
        continue;
      }
      sub.socket.send(payload);
    }
  }
}
