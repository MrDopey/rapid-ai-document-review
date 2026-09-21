import { ref, type Ref } from 'vue';
import {
  ApplicationEvent,
  SubscribedFrame,
  PongFrame,
  ErrorFrame,
} from '@rapid-ai-document-review/shared/contracts/events';

export type ServerFrame =
  | { kind: 'subscribed'; frame: ReturnType<typeof SubscribedFrame.parse> }
  | { kind: 'event'; frame: ReturnType<typeof ApplicationEvent.parse> }
  | { kind: 'pong' }
  | { kind: 'error'; frame: ReturnType<typeof ErrorFrame.parse> };

export type FrameHandler = (frame: ServerFrame) => void;

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 1_000;

/**
 * WebSocket transport for `/events` (contracts/websocket-events.md). `reconnecting` is true from
 * the moment a disconnect is detected until the caught-up `subscribed` handshake completes
 * (FR-037b) — the caller renders a non-blocking indicator from it, never clearing previously
 * loaded content.
 */
export class WsClient {
  readonly reconnecting: Ref<boolean> = ref(false);

  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Set<FrameHandler>();
  private closedByCaller = false;
  private readonly url: string;
  private readonly getDocumentId: () => string;
  private readonly getSinceSequence: () => number | null;

  constructor(url: string, getDocumentId: () => string, getSinceSequence: () => number | null) {
    this.url = url;
    this.getDocumentId = getDocumentId;
    this.getSinceSequence = getSinceSequence;
  }

  onFrame(handler: FrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(): void {
    this.closedByCaller = false;
    this.openSocket();
  }

  close(): void {
    this.closedByCaller = true;
    this.clearTimers();
    this.socket?.close();
  }

  send(frame: { type: string; [key: string]: unknown }): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  /** Re-subscribes the existing connection to whatever `getDocumentId()` now returns, instead of
   *  opening a second socket (contracts/http-and-ws.md) — used when the active document changes.
   *  A no-op while disconnected: the next `open` handler's own subscribe already picks up the
   *  latest `getDocumentId()`/`getSinceSequence()`. */
  resubscribe(): void {
    this.send({ type: 'subscribe', documentId: this.getDocumentId(), sinceSequence: null });
  }

  private openSocket(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          documentId: this.getDocumentId(),
          sinceSequence: this.getSinceSequence(),
        }),
      );
      this.startHeartbeat();
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }

      const subscribed = SubscribedFrame.safeParse(parsed);
      if (subscribed.success) {
        this.reconnecting.value = false;
        this.dispatch({ kind: 'subscribed', frame: subscribed.data });
        return;
      }
      const pong = PongFrame.safeParse(parsed);
      if (pong.success) {
        this.dispatch({ kind: 'pong' });
        return;
      }
      const appEvent = ApplicationEvent.safeParse(parsed);
      if (appEvent.success) {
        this.dispatch({ kind: 'event', frame: appEvent.data });
        return;
      }
      // Sent instead of `subscribed` when the just-sent `subscribe` frame named a document the
      // backend can't find (e.g. a resubscribe racing a delete from another tab — see
      // `ErrorFrame`'s own doc comment). Previously unhandled: this frame matched none of the
      // schemas above, so it silently fell through with no log and no propagation, leaving the
      // client believing it was still subscribed while nothing further ever arrived for it.
      const errorFrame = ErrorFrame.safeParse(parsed);
      if (errorFrame.success) {
        console.error(
          `WS subscribe failed: ${errorFrame.data.error.code} — ${errorFrame.data.error.message}`,
        );
        this.dispatch({ kind: 'error', frame: errorFrame.data });
      }
    });

    socket.addEventListener('close', () => {
      this.clearTimers();
      if (this.closedByCaller) return;
      this.reconnecting.value = true;
      this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS);
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private dispatch(frame: ServerFrame): void {
    for (const handler of this.handlers) handler(frame);
  }
}
