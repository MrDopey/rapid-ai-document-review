import { defineStore } from 'pinia';
import type { StagedEditDto } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame, WsClient } from '../transport/ws-client.js';
import { announceStagedEditCreated } from '../a11y/live-regions.js';
import { useConversationsStore } from './conversations.js';
import { ensureArray } from './util.js';

export interface EditsState {
  /** Per-conversation staged edits, newest first (matches GET /conversations/:id/edits). */
  byConversation: Record<string, StagedEditDto[]>;
  /** conversationIds for which staged_edit_replacement_exhausted has fired and not yet been
   *  dismissed — drives the "budget exhausted" banner (FR-032b). */
  exhausted: Record<string, boolean>;
}

/**
 * Per-conversation staged-edit state (data-model.md §6, contracts/websocket-events.md §Proposed
 * edits). Follows stores/conversations.ts's event-dispatch pattern from US2: `load()` seeds from
 * HTTP, `handleServerFrame` keeps it live from the WS stream.
 */
export const useEditsStore = defineStore('edits', {
  state: (): EditsState => ({ byConversation: {}, exhausted: {} }),

  getters: {
    pendingFor:
      (state) =>
      (conversationId: string): StagedEditDto[] =>
        (state.byConversation[conversationId] ?? []).filter((e) => e.status === 'pending'),
  },

  actions: {
    async load(conversationId: string): Promise<void> {
      const response = await httpClient.listEdits(conversationId);
      this.byConversation[conversationId] = response.stagedEdits;
    },

    editsFor(conversationId: string): StagedEditDto[] {
      return this.byConversation[conversationId] ?? [];
    },

    async apply(editId: string, conversationId: string): Promise<void> {
      await httpClient.applyEdit(editId);
      await this.load(conversationId);
    },

    async drop(editId: string, conversationId: string): Promise<void> {
      await httpClient.dropEdit(editId);
      await this.load(conversationId);
    },

    async acceptRemaining(conversationId: string): Promise<void> {
      await httpClient.acceptRemaining(conversationId);
      await this.load(conversationId);
    },

    async dropRemaining(conversationId: string): Promise<void> {
      await httpClient.dropRemaining(conversationId);
      await this.load(conversationId);
    },

    dismissExhausted(conversationId: string): void {
      delete this.exhausted[conversationId];
    },

    handleServerFrame(frame: ServerFrame): void {
      if (frame.kind !== 'event') return;
      const event = frame.frame;
      const conversationId = event.conversationId;
      if (!conversationId) return;

      switch (event.type) {
        case 'staged_edit_created': {
          ensureArray(this.byConversation, conversationId);
          // A full row isn't in this event's payload (only summary fields) — refetch to stay
          // exactly in sync with the server-computed StagedEditDto shape (status, timestamps, …).
          void this.load(conversationId);
          // FR-043b: "a proposed edit arriving" — announced alongside, not instead of, the refetch
          // above; the conversation's display name comes from the sibling conversations store
          // rather than duplicating any conversation state in this store.
          const conversation = useConversationsStore().findConversation(conversationId);
          announceStagedEditCreated(conversation ? conversation.name : 'Conversation', event.data.summary);
          break;
        }

        case 'staged_edit_applied':
        case 'staged_edit_dropped':
        case 'staged_edit_superseded':
        case 'staged_edit_replacement_created':
          void this.load(conversationId);
          break;

        case 'staged_edit_replacement_exhausted':
          this.exhausted[conversationId] = true;
          void this.load(conversationId);
          break;

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
