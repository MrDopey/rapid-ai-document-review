import { defineStore } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame } from '../transport/ws-client.js';

export interface ConversationMessageState {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string | null;
  streaming: boolean;
  createdAt: string;
}

export interface QueueInfo {
  queuePosition: number;
  runningCount: number;
  limit: number;
}

export interface ConversationsState {
  conversations: ConversationDto[];
  messagesByConversation: Record<string, ConversationMessageState[]>;
  queueInfo: Record<string, QueueInfo>;
  loaded: boolean;
}

/**
 * Conversation list + per-conversation streaming message history, driven by the WS event stream
 * (contracts/websocket-events.md §Agent run and streaming). `text_delta`/`thinking_delta` are
 * ephemeral — they mutate the in-flight message in place; `message_completed` is the durable
 * truth that a reconnecting client relies on instead of replayed deltas.
 */
export const useConversationsStore = defineStore('conversations', {
  state: (): ConversationsState => ({
    conversations: [],
    messagesByConversation: {},
    queueInfo: {},
    loaded: false,
  }),

  actions: {
    async load(): Promise<void> {
      const page = await httpClient.listConversations();
      this.conversations = page.conversations;
      this.loaded = true;
    },

    async loadDetail(conversationId: string): Promise<void> {
      const detail = await httpClient.getConversation(conversationId);
      this.upsertConversation(detail.conversation);
      this.messagesByConversation[conversationId] = detail.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        reasoning: m.reasoning ?? null,
        streaming: false,
        createdAt: m.createdAt,
      }));
    },

    async send(conversationId: string, message: string): Promise<void> {
      await httpClient.sendMessage(conversationId, message);
    },

    async retry(conversationId: string): Promise<void> {
      await httpClient.retryConversation(conversationId);
    },

    messagesFor(conversationId: string): ConversationMessageState[] {
      return this.messagesByConversation[conversationId] ?? [];
    },

    handleServerFrame(frame: ServerFrame): void {
      if (frame.kind === 'subscribed') {
        this.conversations = frame.frame.snapshot.conversations;
        return;
      }
      if (frame.kind !== 'event') return;
      const event = frame.frame;
      const conversationId = event.conversationId;

      switch (event.type) {
        case 'conversation_status_changed': {
          const conv = conversationId && this.conversations.find((c) => c.id === conversationId);
          if (conv) conv.status = event.data.status;
          break;
        }

        case 'agent_queued':
          if (conversationId) this.queueInfo[conversationId] = { ...event.data };
          break;

        case 'agent_dequeued':
          if (conversationId) delete this.queueInfo[conversationId];
          break;

        case 'message_started': {
          if (!conversationId) break;
          const list = this.ensureList(conversationId);
          list.push({
            id: event.data.messageId,
            role: event.data.role,
            text: '',
            reasoning: null,
            streaming: true,
            createdAt: event.at,
          });
          break;
        }

        case 'text_delta': {
          if (!conversationId) break;
          const list = this.ensureList(conversationId);
          const existing = list.find((m) => m.id === event.data.messageId);
          if (existing) {
            existing.text += event.data.delta;
          } else {
            list.push({
              id: event.data.messageId,
              role: 'assistant',
              text: event.data.delta,
              reasoning: null,
              streaming: true,
              createdAt: event.at,
            });
          }
          break;
        }

        case 'thinking_delta': {
          if (!conversationId) break;
          const list = this.ensureList(conversationId);
          const existing = list.find((m) => m.id === event.data.messageId);
          if (existing) {
            existing.reasoning = (existing.reasoning ?? '') + event.data.delta;
          } else {
            list.push({
              id: event.data.messageId,
              role: 'assistant',
              text: '',
              reasoning: event.data.delta,
              streaming: true,
              createdAt: event.at,
            });
          }
          break;
        }

        case 'message_completed': {
          if (!conversationId) break;
          const list = this.ensureList(conversationId);
          const existing = list.find((m) => m.id === event.data.messageId);
          if (existing) {
            existing.text = event.data.text;
            existing.reasoning = event.data.reasoning;
            existing.streaming = false;
          } else {
            list.push({
              id: event.data.messageId,
              role: event.data.role,
              text: event.data.text,
              reasoning: event.data.reasoning,
              streaming: false,
              createdAt: event.at,
            });
          }
          break;
        }

        default:
          break;
      }
    },

    ensureList(conversationId: string): ConversationMessageState[] {
      const existing = this.messagesByConversation[conversationId];
      if (existing) return existing;
      const created: ConversationMessageState[] = [];
      this.messagesByConversation[conversationId] = created;
      return created;
    },

    upsertConversation(dto: ConversationDto): void {
      const index = this.conversations.findIndex((c) => c.id === dto.id);
      if (index === -1) this.conversations.push(dto);
      else this.conversations[index] = dto;
    },
  },
});
