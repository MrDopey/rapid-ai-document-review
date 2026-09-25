import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ListItemDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useListItemsStore } from '../../src/stores/listItems.js';
import { httpClient } from '../../src/transport/http-client.js';
import type { ServerFrame } from '../../src/transport/ws-client.js';

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listListItems: vi.fn(),
  },
}));

function item(id: string, text: string, contentHash = 'hash'): ListItemDto {
  return { id, text, contentHash };
}

function addedFrame(list: 'todo' | 'parking_lot', dto: ListItemDto): ServerFrame {
  return {
    kind: 'event',
    frame: {
      type: 'list_item_added',
      sequence: 1,
      documentId: 'doc_1',
      conversationId: null,
      at: '2026-01-01T00:00:00.000Z',
      data: { list, item: dto },
    },
  } as ServerFrame;
}

function updatedFrame(list: 'todo' | 'parking_lot', dto: ListItemDto): ServerFrame {
  return {
    kind: 'event',
    frame: {
      type: 'list_item_updated',
      sequence: 2,
      documentId: 'doc_1',
      conversationId: null,
      at: '2026-01-01T00:00:00.000Z',
      data: { list, item: dto },
    },
  } as ServerFrame;
}

function removedFrame(list: 'todo' | 'parking_lot', itemId: string): ServerFrame {
  return {
    kind: 'event',
    frame: {
      type: 'list_item_removed',
      sequence: 3,
      documentId: 'doc_1',
      conversationId: null,
      at: '2026-01-01T00:00:00.000Z',
      data: { list, itemId },
    },
  } as ServerFrame;
}

describe('listItems store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.listListItems).mockReset();
  });

  it('fetchListItems seeds todo/parkingLot from the GET snapshot', async () => {
    vi.mocked(httpClient.listListItems).mockResolvedValue({
      todo: [item('li_1', 'fix the intro')],
      parkingLot: [item('li_2', 'parked idea')],
    });

    const store = useListItemsStore();
    await store.fetchListItems('doc_1');

    expect(store.todo).toEqual([item('li_1', 'fix the intro')]);
    expect(store.parkingLot).toEqual([item('li_2', 'parked idea')]);
  });

  it('handleServerFrame appends on list_item_added, routed by the event data.list', () => {
    const store = useListItemsStore();
    store.handleServerFrame(addedFrame('todo', item('li_1', 'new item')));
    store.handleServerFrame(addedFrame('parking_lot', item('li_2', 'parked')));

    expect(store.todo).toEqual([item('li_1', 'new item')]);
    expect(store.parkingLot).toEqual([item('li_2', 'parked')]);
  });

  it('handleServerFrame replaces the matching item on list_item_updated', () => {
    const store = useListItemsStore();
    store.handleServerFrame(addedFrame('todo', item('li_1', 'original')));
    store.handleServerFrame(updatedFrame('todo', item('li_1', 'edited', 'hash2')));

    expect(store.todo).toEqual([item('li_1', 'edited', 'hash2')]);
  });

  it('handleServerFrame removes the matching item on list_item_removed', () => {
    const store = useListItemsStore();
    store.handleServerFrame(addedFrame('parking_lot', item('li_1', 'to remove')));
    store.handleServerFrame(removedFrame('parking_lot', 'li_1'));

    expect(store.parkingLot).toEqual([]);
  });

  it('ignores non-list-item frames', () => {
    const store = useListItemsStore();
    store.handleServerFrame({
      kind: 'event',
      frame: {
        type: 'document_created',
        sequence: 1,
        documentId: 'doc_1',
        conversationId: null,
        at: '2026-01-01T00:00:00.000Z',
        data: { documentId: 'doc_1', title: 'Doc', revision: 1, content: '' },
      },
    } as ServerFrame);

    expect(store.todo).toEqual([]);
    expect(store.parkingLot).toEqual([]);
  });
});
