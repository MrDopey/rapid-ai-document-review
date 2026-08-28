import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ClientFrame } from '@rapid-ai-document-review/shared/contracts/events';
import type { EventHub } from '../../events/event-hub.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { logger } from '../../logging.js';

/**
 * `GET /events` — the sole WebSocket channel (contracts/websocket-events.md). The backend is the
 * only sender of state; the client sends only the opening subscribe frame and heartbeats.
 * A socket closing is routine and never interpreted as an agent or tool-call failure (FR-037).
 */
export function registerWsRoutes(
  app: FastifyInstance,
  deps: { eventHub: EventHub; storage: StorageAdapter },
): void {
  const { eventHub, storage } = deps;

  app.get('/events', { websocket: true }, (socket: WebSocket, _request) => {
    socket.on('message', (raw: Buffer) => {
      // No `event` field on either warn below: a malformed inbound frame has no counterpart in
      // the closed WebSocket event vocabulary (FR-042) — it never reaches EventService/EventHub.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        logger.warn('received non-JSON WebSocket frame');
        return;
      }
      const frame = ClientFrame.safeParse(parsed);
      if (!frame.success) {
        logger.warn('received frame failing shared schema validation');
        return;
      }
      if (frame.data.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      // subscribe
      const doc = storage.getDocument();
      if (!doc) return;
      eventHub.subscribe(socket, doc.id, frame.data.sinceSequence);
    });

    socket.on('close', () => {
      eventHub.unsubscribe(socket);
    });
  });
}
