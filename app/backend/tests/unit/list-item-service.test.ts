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

/** A minimal real conversation row — `conversation_event.conversation_id` has an FK constraint
 *  (unlike `list_item.conversation_id`/`message_id`, deliberately unconstrained per this
 *  feature's own design), so publishing a `list_item_*` event with a non-null conversationId
 *  requires one to actually exist. */
function createConversation(storage: SqliteStorageAdapter, documentId: string): string {
  const now = new Date().toISOString();
  const conversationId = newId('conv');
  storage.createConversation({
    id: conversationId,
    documentId,
    parentId: null,
    name: 'Main',
    kind: 'main',
    piSessionPath: `/tmp/${conversationId}.jsonl`,
    status: 'idle',
    errorMessage: null,
    // `false`/`false`, not `true`/`true`: a test creating more than one conversation on the same
    // document (e.g. simulating two different turns) would otherwise collide with
    // `conversation_one_primary`/`conversation_one_current_main`'s partial unique indexes — this
    // helper only needs a row that satisfies `conversation_event`'s FK, not a "real" Main.
    isPrimary: false,
    isCurrentMain: false,
    contextRevision: 1,
    branchDepth: 0,
    seedSelection: null,
    forkedFromMessageId: null,
    piLeafEntryId: null,
    doneAt: null,
    seedExcerptText: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });
  return conversationId;
}

describe('ListItemService', () => {
  it('supports the full add -> update -> remove round trip', () => {
    const { service, documentId } = buildHarness();

    const added = service.addItem(documentId, 'todo', 'fix the intro paragraph', null, null);
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
    service.addItem(documentId, 'todo', 'todo item', null, null);
    service.addItem(documentId, 'parking_lot', 'parked item', null, null);

    const result = service.listItems(documentId);
    expect(result.todo).toHaveLength(1);
    expect(result.parkingLot).toHaveLength(1);
    expect(result.todo[0]?.text).toBe('todo item');
    expect(result.parkingLot[0]?.text).toBe('parked item');
  });

  it('rejects empty or whitespace-only text on add, without creating an item', () => {
    const { service, documentId } = buildHarness();
    expect(() => service.addItem(documentId, 'todo', '   ', null, null)).toThrow(
      EmptyListItemTextError,
    );
    expect(service.listItems(documentId).todo).toEqual([]);
  });

  it('rejects empty or whitespace-only text on update, leaving the item unchanged', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'original', null, null);

    expect(() =>
      service.updateItem(documentId, added.id, '   ', null, {
        expectedContentHash: computeContentHash(added.text),
      }),
    ).toThrow(EmptyListItemTextError);
    expect(service.listItems(documentId).todo[0]?.text).toBe('original');
  });

  it('rejects update/remove with an id that does not exist on the given list, leaving both lists unchanged', () => {
    const { service, documentId } = buildHarness();
    const added = service.addItem(documentId, 'todo', 'todo item', null, null);

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
    const added = service.addItem(documentId, 'todo', 'original', null, null);
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
    const added = service.addItem(documentId, 'todo', 'original', null, null);
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
    const added = service.addItem(documentId, 'todo', 'original', null, null);

    const updated = service.updateItem(documentId, added.id, 'edited directly', null);
    expect(updated.text).toBe('edited directly');

    service.removeItem(documentId, added.id, null);
    expect(service.listItems(documentId).todo).toEqual([]);
  });

  it('persists a non-null conversationId/messageId provenance link on add', () => {
    const { storage, service, documentId } = buildHarness();
    const conversationId = createConversation(storage, documentId);
    const messageId = newId('msg');

    const added = service.addItem(documentId, 'todo', 'from the agent', conversationId, messageId);
    expect(added.conversationId).toBe(conversationId);
    expect(added.messageId).toBe(messageId);

    const [todoItem] = service.listItems(documentId).todo;
    expect(todoItem?.conversationId).toBe(conversationId);
    expect(todoItem?.messageId).toBe(messageId);
  });

  it('overwrites the provenance link with an explicit messageId on update (agent path)', () => {
    const { storage, service, documentId } = buildHarness();
    const firstConversationId = createConversation(storage, documentId);
    const firstMessageId = newId('msg');
    const secondConversationId = createConversation(storage, documentId);
    const secondMessageId = newId('msg');

    const added = service.addItem(
      documentId,
      'todo',
      'original',
      firstConversationId,
      firstMessageId,
    );

    const updated = service.updateItem(
      documentId,
      added.id,
      'updated by a later turn',
      secondConversationId,
      {
        expectedContentHash: computeContentHash(added.text),
        messageId: secondMessageId,
      },
    );
    expect(updated.conversationId).toBe(secondConversationId);
    expect(updated.messageId).toBe(secondMessageId);
  });

  it('preserves an existing provenance link when messageId is omitted from update options (HTTP path)', () => {
    const { storage, service, documentId } = buildHarness();
    const conversationId = createConversation(storage, documentId);
    const messageId = newId('msg');
    const added = service.addItem(documentId, 'todo', 'original', conversationId, messageId);

    // HTTP-shaped call: no `options.messageId` at all — mirrors `api/http/list-items.ts`'s own
    // `updateItem(documentId, itemId, data.text, null)` call, which never supplies it.
    const updated = service.updateItem(documentId, added.id, 'edited by a human', null);
    expect(updated.text).toBe('edited by a human');
    expect(updated.conversationId).toBe(conversationId);
    expect(updated.messageId).toBe(messageId);
  });
});
