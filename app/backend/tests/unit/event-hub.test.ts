import { describe, expect, it } from 'vitest';
import { EventHub, type DocumentSnapshot, type SocketLike } from '../../src/events/event-hub.js';
import { EventService } from '../../src/events/event-service.js';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { newId } from '../../src/ids.js';

function buildHub(): { hub: EventHub; storage: SqliteStorageAdapter } {
  const storage = new SqliteStorageAdapter(':memory:');
  const eventService = new EventService(storage);
  const emptySnapshot: DocumentSnapshot = {
    document: { id: '', title: '', currentRevision: 0, createdAt: '', updatedAt: '', content: '' },
    conversations: [],
  };
  const hub = new EventHub(eventService, () => emptySnapshot);
  return { hub, storage };
}

function createDocument(storage: SqliteStorageAdapter): string {
  const id = newId('doc');
  const now = new Date().toISOString();
  storage.createDocument({
    id,
    title: 'Fixture',
    piSessionDir: '/tmp/pi-sessions',
    documentType: 'canvas',
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  });
  return id;
}

function fakeSocket(): SocketLike & { received: string[] } {
  const received: string[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    received,
    send(data: string) {
      received.push(data);
    },
  };
}

describe("EventHub.subscribe replaces a socket's previous subscription", () => {
  it('a socket re-subscribed to a different document no longer receives broadcasts for the one it left', () => {
    const { hub, storage } = buildHub();
    const documentA = createDocument(storage);
    const documentB = createDocument(storage);
    const socket = fakeSocket();

    hub.subscribe(socket, documentA, null);
    hub.subscribe(socket, documentB, null);
    socket.received.length = 0;

    hub.broadcast(documentA, {
      type: 'settings_changed',
      sequence: null,
      documentId: documentA,
      conversationId: null,
      at: new Date().toISOString(),
      data: {},
    } as never);

    expect(socket.received).toHaveLength(0);
  });

  it('still receives broadcasts for the document it is currently subscribed to', () => {
    const { hub, storage } = buildHub();
    const documentA = createDocument(storage);
    const documentB = createDocument(storage);
    const socket = fakeSocket();

    hub.subscribe(socket, documentA, null);
    hub.subscribe(socket, documentB, null);
    socket.received.length = 0;

    hub.broadcast(documentB, {
      type: 'settings_changed',
      sequence: null,
      documentId: documentB,
      conversationId: null,
      at: new Date().toISOString(),
      data: {},
    } as never);

    expect(socket.received).toHaveLength(1);
  });
});
