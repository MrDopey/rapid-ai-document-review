import { describe, expect, it } from 'vitest';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.ts';
import { EventService } from '../../src/events/event-service.ts';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.ts';
import { newId } from '../../src/ids.ts';
import { computeContentHash } from '../../src/list-items/content-hash.ts';
import {
  EmptyListItemTextError,
  ListItemNotFoundError,
  ListItemService,
  StaleContentHashError,
} from '../../src/list-items/list-item-service.ts';

function buildHarness() {
  const storage = new SqliteStorageAdapter(':memory:');
  const eventService = new EventService(storage);
  const emptySnapshot: DocumentSnapshot = {
    document: { id: '', title: '', currentRevision: 0, createdAt: '', updatedAt: '', content: '' },
    conversations: [],
  };
  const eventHub = new EventHub(eventService, () => emptySnapshot);
  const service = new ListItemService(storage, eventService, eventHub);

  const now = new Date().toISOString();
  const documentId = newId('doc');
  storage.createDocument({
    id: documentId,
    title: 'Doc',
    piSessionDir: '/tmp/pi',
    documentType: 'canvas',
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  });

  return { storage, service, documentId };
}

describe('ListItemService', () => {
  it('supports the full add -> update -> remove round trip', () => {
    const { service, documentId } = buildHarness();

    const added = service.addItem(documentId, 'todo', 'fix the intro paragraph', null);
    expect(added.text).toBe('fix the intro paragraph');
    expect(added.list).toBe('todo');

    const updated = service.updateItem(documentId, added.id, 'fix the intro', null, {
      expectedContentHash: computeContentHash(added.text),
    });
    expect(updated.text).toBe('fix the intro');

    service.removeItem(documentId, added.id, null, {
      expectedContentHash: computeContentHash(updated.text),
    });
    expect(service.listItems(documentId).todo).toEqual([]);
  });

  it('lists items bucketed by list', () => {
    const { service, documentId } = buildHarness();
    service.addItem(documentId, 'todo', 'todo item', null);
    service.addItem(documentId, 'parking_lot', 'parked item', null);

    const result = service.listItems(documentId);
    expect(result.todo).toHaveLength(1);
    expect(result.parkingLot).toHaveLength(1);
    expect(result.todo[0]?.text).toBe('todo item');
    expect(result.parkingLot[0]?.text).toBe('parked item');
  });

  it('rejects empty or whitespace-only text on add, without creating an item', () => {
    const { service, documentId } = buildHarness();
    expect(() => service.addItem(documentId, 'todo', '   ', null)).toThrow(EmptyListItemTextError);
    expect(service.listItems(documentId).todo).toEqual([]);
  });

  it('rejects empty or whitespace-only text on update, leaving the item unchanged', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'original', null);

    expect(() =>
      service.updateItem(documentId, added.id, '   ', null, {
        expectedContentHash: computeContentHash(added.text),
      }),
    ).toThrow(EmptyListItemTextError);
    expect(service.listItems(documentId).todo[0]?.text).toBe('original');
  });

  it('rejects update/remove with an id that does not exist on the given list, leaving both lists unchanged', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'todo item', null);

    expect(() =>
      service.updateItem(documentId, added.id, 'new text', null, {
        list: 'parking_lot',
        expectedContentHash: computeContentHash(added.text),
      }),
    ).toThrow(ListItemNotFoundError);
    expect(() => service.removeItem(documentId, added.id, null, { list: 'parking_lot' })).toThrow(
      ListItemNotFoundError,
    );
    expect(service.listItems(documentId).todo[0]?.text).toBe('todo item');
  });

  it('rejects a stale expectedContentHash on update, reporting the item actual current text/hash', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'original', null);
    service.updateItem(documentId, added.id, 'changed by someone else', null, {
      expectedContentHash: computeContentHash(added.text),
    });

    let caught: StaleContentHashError | undefined;
    try {
      service.updateItem(documentId, added.id, 'agent proposed text', null, {
        expectedContentHash: computeContentHash(added.text), // the stale, original hash
      });
    } catch (err) {
      caught = err as StaleContentHashError;
    }
    expect(caught).toBeInstanceOf(StaleContentHashError);
    expect(caught?.currentText).toBe('changed by someone else');
    expect(caught?.currentContentHash).toBe(computeContentHash('changed by someone else'));
    expect(service.listItems(documentId).todo[0]?.text).toBe('changed by someone else');
  });

  it('rejects a stale expectedContentHash on remove, leaving the item in place', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'original', null);
    service.updateItem(documentId, added.id, 'changed by someone else', null, {
      expectedContentHash: computeContentHash(added.text),
    });

    expect(() =>
      service.removeItem(documentId, added.id, null, {
        expectedContentHash: computeContentHash(added.text),
      }),
    ).toThrow(StaleContentHashError);
    expect(service.listItems(documentId).todo).toHaveLength(1);
  });

  it('applies a user-driven (HTTP path) update/remove with no hash supplied, unconditionally', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'original', null);

    const updated = service.updateItem(documentId, added.id, 'edited directly', null);
    expect(updated.text).toBe('edited directly');

    service.removeItem(documentId, added.id, null);
    expect(service.listItems(documentId).todo).toEqual([]);
  });
});
