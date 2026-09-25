import { defineStore } from 'pinia';
import type { ListItemDto } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame, WsClient } from '../transport/ws-client.js';

export interface ListItemsState {
  todo: ListItemDto[];
  parkingLot: ListItemDto[];
}

/**
 * Todo & Parking Lot list state for whichever document is currently active (012-todo-parking-lists).
 * `fetchListItems` seeds the snapshot from HTTP (called once when the panel/rail first becomes
 * visible, FR-012 — not eagerly on every document load, since the panel is opt-in); `handleServerFrame`
 * keeps it live afterward from the WS stream, the same event-sourcing split every other store here
 * uses (stores/edits.ts). Both the agent tool-call path and the user's HTTP path funnel through the
 * same backend `ListItemService`, so a change from either source arrives here identically.
 */
export const useListItemsStore = defineStore('listItems', {
  state: (): ListItemsState => ({ todo: [], parkingLot: [] }),

  actions: {
    async fetchListItems(documentId: string): Promise<void> {
      const response = await httpClient.listListItems(documentId);
      this.todo = response.todo;
      this.parkingLot = response.parkingLot;
    },

    handleServerFrame(frame: ServerFrame): void {
      if (frame.kind !== 'event') return;
      const event = frame.frame;

      switch (event.type) {
        case 'list_item_added': {
          const bucket = event.data.list === 'todo' ? this.todo : this.parkingLot;
          bucket.push(event.data.item);
          break;
        }
        case 'list_item_updated': {
          const bucket = event.data.list === 'todo' ? this.todo : this.parkingLot;
          const index = bucket.findIndex((item) => item.id === event.data.item.id);
          if (index === -1) bucket.push(event.data.item);
          else bucket[index] = event.data.item;
          break;
        }
        case 'list_item_removed': {
          const bucket = event.data.list === 'todo' ? this.todo : this.parkingLot;
          const index = bucket.findIndex((item) => item.id === event.data.itemId);
          if (index !== -1) bucket.splice(index, 1);
          break;
        }
        default:
          break;
      }
    },

    // Registered by App.vue's connectWs — see there for why every store owns this.
    subscribeToFrames(wsClient: WsClient): () => void {
      return wsClient.onFrame((frame) => this.handleServerFrame(frame));
    },
  },
});
