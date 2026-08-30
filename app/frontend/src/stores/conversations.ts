import { defineStore } from 'pinia';
import type {
  ConversationDto,
  CreateConversationRequest,
  DesignatePrimaryResponse,
  PrimaryWhenBusy,
  ReviewConversationResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame } from '../transport/ws-client.js';
import {
  announceAgentError,
  announceAgentStarted,
  announceConversationStale,
  announceMessageCompleted,
} from '../a11y/live-regions.js';
import { ensureArray } from './util.js';

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

export interface FoldedSummaryInfo {
  summary: string;
  at: string;
}

export interface ConversationsState {
  conversations: ConversationDto[];
  messagesByConversation: Record<string, ConversationMessageState[]>;
  queueInfo: Record<string, QueueInfo>;
  /** FR-034: the most recently delivered fold summary per parent conversation id, from the
   *  `conversation_summary_folded` event — emitted only once the summary has actually been
   *  generated and delivered (never at close time). Surfaced in ConversationView.vue so the user
   *  (and e2e tests) can observe delivery without waiting on a subsequent agent turn. */
  foldedSummaries: Record<string, FoldedSummaryInfo>;
  /** Per-conversation unsent composer draft text (005-canvas-conversation-threads follow-up):
   *  mirrored here — not just held locally in `ConversationView.vue`'s own `draft` ref — so
   *  `discardIfEmpty` below can still see whether the user left unsent text behind at the moment a
   *  conversation's focus panel closes and that component is about to unmount. A conversation with
   *  no entry (or only whitespace) here counts as having no draft. */
  drafts: Record<string, string>;
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
    foldedSummaries: {},
    drafts: {},
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

    /** Refreshes only the conversation-level DTO (status, pendingEditCount, isPrimary, …) without
     *  touching `messagesByConversation` — unlike `loadDetail`, safe to call while a turn is still
     *  streaming (a `staged_edit_*` event can arrive mid-turn, e.g. from `propose_document_edit`). */
    async refreshConversationMeta(conversationId: string): Promise<void> {
      const detail = await httpClient.getConversation(conversationId);
      this.upsertConversation(detail.conversation);
    },

    async send(conversationId: string, message: string): Promise<void> {
      await httpClient.sendMessage(conversationId, message);
    },

    /** FR-018: refresh this conversation's context to the current document revision, then send —
     *  `contextRevision`/`isStale` update here from the `conversation_context_refreshed` WS event
     *  (handleServerFrame below), same as every other server-computed field in this store. */
    async refreshAndSend(conversationId: string, message: string): Promise<void> {
      await httpClient.refreshAndSend(conversationId, message);
    },

    async retry(conversationId: string): Promise<void> {
      await httpClient.retryConversation(conversationId);
    },

    /** FR-011: branch a new conversation from a document selection, or plainly from a parent. */
    async branch(request: CreateConversationRequest): Promise<ConversationDto> {
      const conversation = await httpClient.branchConversation(request);
      this.upsertConversation(conversation);
      return conversation;
    },

    /** FR-027/FR-028/FR-029: the caller (HudPanel) catches a `PRIMARY_TARGET_BUSY` `ApiError` and
     *  re-calls with an explicit `whenBusy` choice — this action itself just forwards to the HTTP
     *  client and lets the eventual `primary_changed` WS frame (handleServerFrame below) update
     *  `isPrimary` across the list, exactly as it already does for the close-clears-Primary case. */
    async designatePrimary(conversationId: string, whenBusy?: PrimaryWhenBusy): Promise<DesignatePrimaryResponse> {
      return httpClient.designatePrimary(conversationId, whenBusy);
    },

    /** FR-027a: clears the Primary designation without nominating a replacement. */
    async clearPrimary(conversationId: string): Promise<void> {
      await httpClient.clearPrimary(conversationId);
    },

    /** Renames a conversation's title. The updated DTO comes straight back from the PATCH
     *  response (same convention as `branch()`/`review()` above) — `handleServerFrame`'s
     *  `conversation_renamed` case below only matters for a second, already-connected client. */
    async rename(conversationId: string, name: string): Promise<ConversationDto> {
      const conversation = await httpClient.renameConversation(conversationId, name);
      this.upsertConversation(conversation);
      return conversation;
    },

    async close(conversationId: string, foldSummaryIntoParent = false): Promise<void> {
      await httpClient.closeConversation(conversationId, foldSummaryIntoParent);
      const conv = this.findConversation(conversationId);
      if (conv) {
        conv.status = 'closed';
        conv.closedAt = conv.closedAt ?? new Date().toISOString();
        conv.isPrimary = false;
      }
    },

    /** FR-036: request an independent review of a closed conversation and its branches. Returns
     *  the newly created `kind: 'review'` conversation so the caller can navigate to it. */
    async review(conversationId: string): Promise<ReviewConversationResponse> {
      const result = await httpClient.reviewConversation(conversationId);
      this.upsertConversation(result.conversation);
      return result;
    },

    messagesFor(conversationId: string): ConversationMessageState[] {
      return this.messagesByConversation[conversationId] ?? [];
    },

    /** Mirrors `ConversationView.vue`'s own composer `draft` ref for `conversationId` — see
     *  `drafts`'s doc comment above. Stores an empty string as a real (not deleted) entry so a
     *  conversation that once had draft text but was cleared (sent, or emptied by hand) is still
     *  distinguishable from one this store has simply never heard from. */
    setDraft(conversationId: string, text: string): void {
      this.drafts[conversationId] = text;
    },

    /**
     * 005-canvas-conversation-threads follow-up: discards a branch placeholder conversation the
     * user created and then closed without ever sending a message or leaving unsent draft text
     * behind (see `ConversationService.discardIfEmpty`'s doc comment for the full eligibility
     * rule). A no-op — never an error — for anything that doesn't meet every condition, so callers
     * (`App.vue`'s `unfocusConversation`) can call this unconditionally on every focus-panel close
     * rather than duplicating the eligibility check themselves. Best-effort: a failed HTTP call
     * (e.g. a race against a second client sending a message moments earlier) is swallowed rather
     * than surfaced, since the panel has already visually closed by the time this runs.
     */
    async discardIfEmpty(conversationId: string): Promise<boolean> {
      const conversation = this.findConversation(conversationId);
      if (!conversation || conversation.kind !== 'branch') return false;
      if (this.messagesFor(conversationId).length > 0) return false;
      if ((this.drafts[conversationId] ?? '').trim().length > 0) return false;

      try {
        await httpClient.discardConversation(conversationId);
      } catch {
        return false;
      }

      const index = this.conversations.findIndex((c) => c.id === conversationId);
      if (index !== -1) this.conversations.splice(index, 1);
      delete this.messagesByConversation[conversationId];
      delete this.foldedSummaries[conversationId];
      delete this.queueInfo[conversationId];
      delete this.drafts[conversationId];
      return true;
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
          const conv = this.findConversation(conversationId);
          if (conv) conv.status = event.data.status;
          break;
        }

        // A second connected client's rename lands here; the client that issued the PATCH itself
        // already applied it via `rename()`'s response above (`upsertConversation` makes this
        // idempotent either way).
        case 'conversation_renamed': {
          const conv = this.findConversation(conversationId);
          if (conv) conv.name = event.data.name;
          break;
        }

        case 'conversation_closed': {
          const conv = this.findConversation(conversationId);
          if (conv) {
            conv.status = 'closed';
            conv.closedAt = event.data.closedAt;
            conv.isPrimary = false;
          }
          break;
        }

        // FR-016: a convenience signal — `isStale` is also recomputed server-side any time this
        // conversation's DTO is refetched (`toConversationDto`), but reacting to the event
        // directly means the HUD's stale badge updates without a round trip.
        case 'conversation_stale': {
          const conv = this.findConversation(conversationId);
          if (conv) conv.isStale = true;
          announceConversationStale(conv ? conv.name : 'Conversation');
          break;
        }

        // FR-043b: announced (assertive) purely alongside the existing `conversation_status_changed`
        // handler above, which already performs the actual state update (`status: 'errored'`) —
        // this case adds nothing but the announcement.
        case 'agent_error': {
          const conv = this.findConversation(conversationId);
          announceAgentError(conv ? conv.name : 'Conversation', event.data.message);
          break;
        }

        // FR-043b: a response beginning — announced without touching any state (`agent_started`
        // carries no data this store tracks).
        case 'agent_started': {
          const conv = this.findConversation(conversationId);
          announceAgentStarted(conv ? conv.name : 'Conversation');
          break;
        }

        // FR-018: the refreshed context revision, reflected immediately so the stale badge
        // clears without waiting for a separate refetch.
        case 'conversation_context_refreshed': {
          const conv = this.findConversation(conversationId);
          if (conv) {
            conv.contextRevision = event.data.contextRevision;
            conv.isStale = false;
          }
          break;
        }

        // FR-034: delivered (not merely requested) once this arrives — `close()` may return long
        // before this fires, since generating the synopsis is a genuine, unawaited Pi call.
        case 'conversation_summary_folded': {
          if (conversationId) {
            this.foldedSummaries[conversationId] = { summary: event.data.summary, at: event.at };
          }
          break;
        }

        case 'primary_changed': {
          for (const conv of this.conversations) {
            conv.isPrimary = conv.id === event.data.primaryConversationId;
          }
          break;
        }

        // Refetching the freshly-branched conversation's DTO (rather than trusting the event's
        // smaller payload) keeps this store's shape identical to what GET /conversations already
        // returns, with no second definition of a ConversationDto assembled from event fields.
        case 'conversation_started': {
          if (conversationId && !this.conversations.some((c) => c.id === conversationId)) {
            void this.refreshConversationMeta(conversationId);
          }
          break;
        }

        // Server-computed `pendingEditCount` (FR-032c excludes superseded) is refreshed from the
        // server rather than incremented/decremented locally, so this store never risks drifting
        // from the same computation `toConversationDto` performs. Uses `refreshConversationMeta`
        // (not `loadDetail`) since these can arrive mid-turn and must not clobber a message still
        // streaming in via text_delta.
        case 'staged_edit_created':
        case 'staged_edit_applied':
        case 'staged_edit_dropped':
        case 'staged_edit_superseded': {
          if (conversationId) void this.refreshConversationMeta(conversationId);
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
          const list = ensureArray(this.messagesByConversation, conversationId);
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
          const list = ensureArray(this.messagesByConversation, conversationId);
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
          const list = ensureArray(this.messagesByConversation, conversationId);
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
          const list = ensureArray(this.messagesByConversation, conversationId);
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
          // FR-043b: "a response... completing" — the user's own message also settles through
          // this event type, but only the assistant's completion is the announcement-worthy one.
          if (event.data.role === 'assistant') {
            announceMessageCompleted(this.findConversation(conversationId)?.name ?? 'Conversation');
          }
          break;
        }

        default:
          break;
      }
    },

    /** Looks up a conversation by id, tolerating the falsy/optional ids that WS event payloads
     *  (`event.conversationId`) can carry — used everywhere `handleServerFrame` below needs the
     *  conversation a frame refers to. */
    findConversation(conversationId: string | null | undefined): ConversationDto | null {
      if (!conversationId) return null;
      return this.conversations.find((c) => c.id === conversationId) ?? null;
    },

    upsertConversation(dto: ConversationDto): void {
      const index = this.conversations.findIndex((c) => c.id === dto.id);
      if (index === -1) this.conversations.push(dto);
      else this.conversations[index] = dto;
    },
  },
});
