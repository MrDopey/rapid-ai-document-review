import { defineStore } from 'pinia';
import type {
  ConversationDto,
  CreateConversationRequest,
  DesignatePrimaryResponse,
  PrimaryWhenBusy,
  ReviewConversationResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import { computeIsToolCallCarrier } from '@rapid-ai-document-review/shared/domain';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame } from '../transport/ws-client.js';
import {
  announceAgentError,
  announceAgentStarted,
  announceConversationStale,
  announceMessageCompleted,
} from '../a11y/live-regions.js';
import { loadMessageExpanded, persistMessageExpanded } from '../composables/messageDisplayState.js';
import { ensureArray } from './util.js';

/** Module-scoped (not store state — this is transient request bookkeeping, not data the app ever
 *  needs to serialize/inspect) in-flight-request de-dupe for `loadDetail` below (bug fix: a
 *  conversation that's simultaneously mounted as both a canvas box (`ConversationThreadBox.vue`)
 *  and a focused detail panel (`ConversationView.vue`) — exactly the scenario `expandedByMessage`
 *  above this file now has to handle too — used to fire two independent, redundant
 *  `GET /conversations/:id` requests if both mounted in the same tick; callers sharing the one
 *  in-flight promise for the same id fixes that without needing either caller to coordinate with
 *  the other. */
const inFlightDetailLoads = new Map<string, Promise<void>>();

export interface ConversationMessageState {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string | null;
  /** True only for a real-SDK tool-call-carrier assistant segment (event-bridge.ts's `message_end`
   *  handling) — an internal artifact of the tool-calling protocol with no visible reply text.
   *  `MessageBubble.vue` gates its visibility on the "Show reasoning" toggle, same as reasoning
   *  content, instead of always rendering it as a blank "Assistant" bubble. */
  isToolCallCarrier: boolean;
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
  /** Bug fix (lifted out of `ConversationThreadBox.vue`/`ConversationView.vue`'s own local
   *  per-component refs): per-message expand/collapse state, keyed by conversationId then
   *  messageId. Both components can be mounted simultaneously for the same focused conversation
   *  (the box always renders on the canvas; the detail view renders separately once focused) — a
   *  local ref per component let the two silently diverge (the same bug class already patched
   *  twice for the shared status badges/actions). `localStorage` (`messageDisplayState.ts`) stays
   *  purely the persistence layer underneath this shared, single source of truth — see
   *  `ensureMessageExpandedSeeded`/`setMessageExpanded`/`setMessagesExpanded` below. */
  expandedByMessage: Record<string, Record<string, boolean>>;
  /** Bug fix (store race): per-conversation generation counter guarding `refreshConversationMeta`
   *  against an older in-flight GET resolving after a newer one and overwriting fresher state — see
   *  that action's own doc comment. */
  refreshGeneration: Record<string, number>;
  /** Bug fix (event-sequence gap detection): the last persisted (non-null) `event.sequence` this
   *  store has observed on the current document's WS stream — see `handleServerFrame`'s gap check
   *  below. `sequence` is a single per-*document* counter (shared across every conversation and
   *  every document-level event, not per-conversation), so one field is all that's needed; `null`
   *  until the first `subscribed`/`event` frame arrives. */
  lastEventSequence: number | null;
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
    expandedByMessage: {},
    refreshGeneration: {},
    lastEventSequence: null,
    loaded: false,
  }),

  actions: {
    async load(): Promise<void> {
      const page = await httpClient.listConversations();
      this.conversations = page.conversations;
      this.loaded = true;
    },

    /** Perf/correctness fix: a conversation simultaneously mounted as both a canvas box
     *  (`ConversationThreadBox.vue`, unconditional-on-cache) and a focused detail panel
     *  (`ConversationView.vue`, unconditional every time) can trigger two concurrent
     *  `GET /conversations/:id` requests for the same id — `inFlightDetailLoads` (module scope,
     *  above) coalesces any overlapping calls for the same id into the one in-flight request. */
    async loadDetail(conversationId: string): Promise<void> {
      const existing = inFlightDetailLoads.get(conversationId);
      if (existing) return existing;
      const promise = (async () => {
        const detail = await httpClient.getConversation(conversationId);
        this.upsertConversation(detail.conversation);
        this.messagesByConversation[conversationId] = detail.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          reasoning: m.reasoning ?? null,
          isToolCallCarrier: m.isToolCallCarrier ?? false,
          streaming: false,
          createdAt: m.createdAt,
        }));
      })();
      inFlightDetailLoads.set(conversationId, promise);
      try {
        await promise;
      } finally {
        inFlightDetailLoads.delete(conversationId);
      }
    },

    /** Refreshes only the conversation-level DTO (status, pendingEditCount, isPrimary, …) without
     *  touching `messagesByConversation` — unlike `loadDetail`, safe to call while a turn is still
     *  streaming (a `staged_edit_*` event can arrive mid-turn, e.g. from `propose_document_edit`).
     *
     *  Bug fix (store race): both the `conversation_started` and every `staged_edit_*` handler
     *  below call this unawaited (`void this.refreshConversationMeta(...)`) with no de-duplication
     *  or response-ordering guard — if two fire in quick succession for the same conversation, an
     *  older GET can resolve *after* a newer one and clobber fresher state with stale data. A
     *  per-conversation generation counter fixes that: each call stamps the current generation
     *  before awaiting, and only applies its response if it's still the most recent call issued for
     *  this id by the time the response comes back — an older, since-superseded response is
     *  discarded instead. */
    async refreshConversationMeta(conversationId: string): Promise<void> {
      const generation = (this.refreshGeneration[conversationId] ?? 0) + 1;
      this.refreshGeneration[conversationId] = generation;
      const detail = await httpClient.getConversation(conversationId);
      if (this.refreshGeneration[conversationId] !== generation) return;
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

    /** Bug fix: seeds `expandedByMessage[conversationId]` for every message not already present
     *  there, from `localStorage` (an assistant reply defaults to expanded, a user message keeps
     *  the pre-existing collapsed-by-default behaviour — same defaults `ConversationThreadBox.vue`'s
     *  and `ConversationView.vue`'s own watchers used before this state moved here). Both call
     *  sites invoke this from a `watch(messages, …, { immediate: true })`, same as before — it's
     *  idempotent (only ever fills in *missing* keys), so both components calling it for the same
     *  conversation is harmless, unlike the previous bug where each held its own separate copy of
     *  the resulting state. */
    ensureMessageExpandedSeeded(conversationId: string): void {
      const forConv = (this.expandedByMessage[conversationId] ??= {});
      for (const message of this.messagesFor(conversationId)) {
        if (!(message.id in forConv)) {
          forConv[message.id] = loadMessageExpanded(message.id, message.role === 'assistant');
        }
      }
    },

    /** Single-message expand/collapse write — shared by both call sites' own `setMessageExpanded`
     *  wrapper (which additionally handles host-specific scroll-into-view behavior). */
    setMessageExpanded(conversationId: string, messageId: string, expanded: boolean): void {
      const forConv = (this.expandedByMessage[conversationId] ??= {});
      forConv[messageId] = expanded;
      persistMessageExpanded({ [messageId]: expanded });
    },

    /** Bulk expand/collapse write (FR-009's "Expand all"/"Collapse all") — one `localStorage`
     *  read-merge-write for every affected message, not one per message. Used by
     *  `useBulkToggleAction` in `conversationActions.ts`. */
    setMessagesExpanded(conversationId: string, entries: Record<string, boolean>): void {
      const forConv = (this.expandedByMessage[conversationId] ??= {});
      Object.assign(forConv, entries);
      persistMessageExpanded(entries);
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
      delete this.expandedByMessage[conversationId];
      delete this.refreshGeneration[conversationId];
      return true;
    },

    handleServerFrame(frame: ServerFrame): void {
      if (frame.kind === 'subscribed') {
        this.conversations = frame.frame.snapshot.conversations;
        this.lastEventSequence = frame.frame.currentSequence;
        return;
      }
      if (frame.kind !== 'event') return;
      const event = frame.frame;

      // Bug fix (event-sequence gap detection): every persisted event carries a non-null,
      // per-document, monotonically increasing `sequence` (ephemeral `text_delta`/`thinking_delta`/
      // `tool_output_delta` frames carry `sequence: null` and are exempt — they're broadcast live
      // only, never persisted/replayed, so there's no ordering guarantee to check). A jump of more
      // than 1 past the last one seen here means at least one persisted event was never received
      // (a dropped/lost message, or a WS ordering bug) — rather than silently keep applying this
      // (and any subsequent) event against context this store may now be missing, discard it and
      // pull a fully consistent resync instead.
      if (event.sequence !== null) {
        if (this.lastEventSequence !== null && event.sequence > this.lastEventSequence + 1) {
          this.lastEventSequence = event.sequence;
          void this.resyncAfterGap();
          return;
        }
        this.lastEventSequence = event.sequence;
      }

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
            isToolCallCarrier: false,
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
              isToolCallCarrier: false,
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
              isToolCallCarrier: false,
              streaming: true,
              createdAt: event.at,
            });
          }
          break;
        }

        case 'message_completed': {
          if (!conversationId) break;
          const list = ensureArray(this.messagesByConversation, conversationId);
          // `isToolCallCarrier` isn't part of the persisted/broadcast event's data (event-sourcing:
          // the event stores the raw `text`/`reasoning` facts, not this derived interpretation) —
          // computed here via the same shared `computeIsToolCallCarrier` the HTTP `MessageDto` path
          // uses server-side (conversation-service.ts's `buildMessages`), so a live WS update and a
          // page reload always agree on the same message's tagging with no duplicated logic.
          const isToolCallCarrier = computeIsToolCallCarrier(event.data);
          const existing = list.find((m) => m.id === event.data.messageId);
          if (existing) {
            existing.text = event.data.text;
            existing.reasoning = event.data.reasoning;
            existing.isToolCallCarrier = isToolCallCarrier;
            existing.streaming = false;
          } else {
            list.push({
              id: event.data.messageId,
              role: event.data.role,
              text: event.data.text,
              reasoning: event.data.reasoning,
              isToolCallCarrier,
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

    /** Bug fix (event-sequence gap detection): a full resync once a gap is detected in
     *  `handleServerFrame` above — re-fetches the conversation list wholesale (recovers any
     *  `conversation_started`/`conversation_closed`/etc. this store might have missed) plus the
     *  message detail of every conversation this store already has messages loaded for (recovers
     *  any missed `message_*`/`staged_edit_*` events for whichever conversations are actually being
     *  looked at right now — refetching every conversation's detail unconditionally would be far
     *  more requests than necessary for conversations nothing is currently rendering). */
    async resyncAfterGap(): Promise<void> {
      await this.load();
      const conversationIds = Object.keys(this.messagesByConversation);
      await Promise.all(conversationIds.map((id) => this.loadDetail(id)));
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
