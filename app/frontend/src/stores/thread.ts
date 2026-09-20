import { defineStore } from 'pinia';
import type {
  BranchThreadRequest,
  ConversationDto,
} from '@rapid-ai-document-review/shared/contracts/http';
import {
  buildThreadBranchSeedMessage,
  computeIsToolCallCarrier,
} from '@rapid-ai-document-review/shared/domain';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame, WsClient } from '../transport/ws-client.js';
import {
  anyCollapsed,
  buildExpandedEntries,
  seedExpandedForEntity,
  setExpandedForEntity,
  setManyExpandedForEntity,
} from '../composables/expandableMessages.js';
import { useDocumentStore } from './document.js';
import type { ConversationMessageState } from './conversations.js';
import { ensureArray } from './util.js';

/** 011-linear-thread-mode: a document's canvas conversations and its Threads are two genuinely
 *  separate, non-interoperating sets (spec Clarifications) — this store is a parallel sibling of
 *  `stores/conversations.ts`, not an extension of it, scoped to whichever document is currently
 *  active and is `documentType: 'thread'`. Every action below resolves the active document
 *  internally (same convention as `conversations.ts`'s own `activeDocumentId()`), so callers never
 *  thread a documentId through by hand. */
function activeDocumentId(): string {
  return useDocumentStore().activeDocumentId!;
}

/** Same in-flight-request de-dupe convention as `conversations.ts`'s `inFlightDetailLoads` — a
 *  Thread simultaneously rendered by more than one open segment/card could otherwise fire two
 *  redundant `GET .../threads/:id/messages` requests in the same tick. */
const inFlightDetailLoads = new Map<string, Promise<void>>();

export interface ThreadsState {
  threads: ConversationDto[];
  messagesByThread: Record<string, ConversationMessageState[]>;
  /** Same per-thread generation-counter guard as `conversations.ts`'s `refreshGeneration` — see
   *  that store's own doc comment for why this matters when two refreshes race. */
  refreshGeneration: Record<string, number>;
  /** Mirrors `conversations.ts`'s `lastEventSequence`: the last persisted per-document WS
   *  `event.sequence` this store has observed, used for the same gap-detection/resync check. */
  lastEventSequence: number | null;
  /** Per-message expand/collapse state, keyed by threadId then messageId — the same shared,
   *  `localStorage`-backed pattern as `conversations.ts`'s own `expandedByMessage`. `ThreadCard.vue`
   *  is the sole renderer of a Thread's messages, but it mounts recursively (once per branch), so
   *  this still needs to live in the store rather than a local ref: a re-mount (e.g. after
   *  `loadDetail`) must not forget a message the user already expanded. */
  expandedByMessage: Record<string, Record<string, boolean>>;
  /** "Quote from here"'s own composer draft, keyed by threadId — lives here rather than as a local
   *  `ref` inside `ThreadComposer.vue` so `quoteHighlightIntoComposer` (triggered from
   *  `ThreadCard.vue`, a sibling of the composer, not an ancestor with direct access to its
   *  internals) has somewhere to write the quoted excerpt into. In-memory only, unlike
   *  `expandedByMessage` — a draft-in-progress is exactly as ephemeral as canvas mode's own
   *  composer state, which likewise isn't `localStorage`-persisted. */
  draftByThread: Record<string, string>;
  loaded: boolean;
}

/**
 * Linear thread mode's (011-linear-thread-mode) Thread list + per-Thread streaming message
 * history — the parallel of `stores/conversations.ts` for a `documentType: 'thread'` document.
 * `GET /api/documents/:documentId/threads` returns every Thread (root + branches, active and
 * done, FR-008/FR-009) for the document; done-filtering for the default view is a purely
 * presentational concern left to `ThreadModeView.vue` (`doneAt === null`), not this store.
 */
export const useThreadStore = defineStore('thread', {
  state: (): ThreadsState => ({
    threads: [],
    messagesByThread: {},
    refreshGeneration: {},
    lastEventSequence: null,
    expandedByMessage: {},
    draftByThread: {},
    loaded: false,
  }),

  actions: {
    /** Mirrors `conversations.ts`'s own `ensureMessageExpandedSeeded` — see that action's doc
     *  comment for the full rationale. Both stores delegate to the same
     *  `composables/expandableMessages.ts` implementation rather than each keeping their own copy. */
    ensureMessageExpandedSeeded(threadId: string): void {
      seedExpandedForEntity(this.expandedByMessage, threadId, this.messagesFor(threadId));
    },

    /** Mirrors `conversations.ts`'s own `setMessageExpanded`. */
    setMessageExpanded(threadId: string, messageId: string, expanded: boolean): void {
      setExpandedForEntity(this.expandedByMessage, threadId, messageId, expanded);
    },

    /** Mirrors `conversations.ts`'s own `setMessagesExpanded` — one `localStorage`
     *  read-merge-write for every affected message, not one per message. */
    setMessagesExpanded(threadId: string, entries: Record<string, boolean>): void {
      setManyExpandedForEntity(this.expandedByMessage, threadId, entries);
    },

    /** Document-wide "Expand all"/"Collapse all" (`ThreadModeView.vue`'s toolbar) — unlike
     *  canvas mode's `useBulkToggleAction`, which toggles one conversation at a time, a
     *  threaded-conversation document has no single "current" Thread to scope this to: every
     *  Thread currently mounted (every active Thread and branch — `ThreadCard.vue` mounts its
     *  active children eagerly, so this covers the whole visible tree) toggles together. */
    anyMessageCollapsed(): boolean {
      for (const threadId of Object.keys(this.messagesByThread)) {
        const forThread = this.expandedByMessage[threadId] ?? {};
        if (anyCollapsed(this.messagesFor(threadId), forThread)) return true;
      }
      return false;
    },

    toggleAllMessages(): void {
      const nextExpanded = this.anyMessageCollapsed();
      for (const threadId of Object.keys(this.messagesByThread)) {
        const entries = buildExpandedEntries(this.messagesFor(threadId), nextExpanded);
        this.setMessagesExpanded(threadId, entries);
      }
    },

    async load(): Promise<void> {
      const page = await httpClient.listThreads(activeDocumentId());
      this.threads = page.conversations;
      this.loaded = true;
      this.pruneStaleThreadState();
    },

    /** Mirrors `conversations.ts`'s `pruneStaleConversationState` — drops any per-thread-id state
     *  left over from a document that is no longer the active one. */
    pruneStaleThreadState(): void {
      const liveIds = new Set(this.threads.map((t) => t.id));
      for (const map of [
        this.messagesByThread,
        this.refreshGeneration,
        this.expandedByMessage,
        this.draftByThread,
      ]) {
        for (const id of Object.keys(map)) {
          if (!liveIds.has(id)) delete map[id];
        }
      }
    },

    async loadDetail(threadId: string): Promise<void> {
      const existing = inFlightDetailLoads.get(threadId);
      if (existing) return existing;
      const promise = (async () => {
        const detail = await httpClient.getThreadMessages(activeDocumentId(), threadId);
        this.upsertThread(detail.conversation);
        this.messagesByThread[threadId] = detail.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          reasoning: m.reasoning ?? null,
          isToolCallCarrier: m.isToolCallCarrier ?? false,
          toolCalls: m.toolCalls ?? [],
          streaming: false,
          createdAt: m.createdAt,
        }));
      })();
      inFlightDetailLoads.set(threadId, promise);
      try {
        await promise;
      } finally {
        inFlightDetailLoads.delete(threadId);
      }
    },

    /** Refreshes only the Thread-level DTO (status, doneAt, pendingEditCount, …) without touching
     *  `messagesByThread` — safe to call mid-turn, same rationale as `conversations.ts`'s own
     *  `refreshConversationMeta`. */
    async refreshThreadMeta(threadId: string): Promise<void> {
      const generation = (this.refreshGeneration[threadId] ?? 0) + 1;
      this.refreshGeneration[threadId] = generation;
      const detail = await httpClient.getThreadMessages(activeDocumentId(), threadId);
      if (this.refreshGeneration[threadId] !== generation) return;
      this.upsertThread(detail.conversation);
    },

    async send(threadId: string, message: string): Promise<void> {
      await httpClient.sendThreadMessage(activeDocumentId(), threadId, message);
    },

    /** `ThreadComposer.vue`'s draft text for `threadId` — see `draftByThread`'s own doc comment
     *  for why this lives here instead of a local `ref`. */
    setThreadDraft(threadId: string, text: string): void {
      this.draftByThread[threadId] = text;
    },

    /** "Quote from here": seeds `threadId`'s own next composer message with the highlighted
     *  passage, wrapped in the exact same `<branch-seed-excerpt>` tag "Branch from here" seeds a
     *  new branch's first message with (`buildThreadBranchSeedMessage`, shared with
     *  `ThreadService.branchFromHighlight` on the backend so the two can never format the excerpt
     *  differently) — but writes into this *same* Thread's draft rather than creating a branch.
     *  Appended after any text the reviewer had already started typing (rather than overwriting
     *  it), separated by a blank line, so a reviewer who quotes mid-draft never loses work. */
    quoteHighlightIntoComposer(threadId: string, highlightedText: string): void {
      const excerpt = buildThreadBranchSeedMessage(highlightedText);
      const existing = this.draftByThread[threadId] ?? '';
      this.draftByThread[threadId] =
        existing.trim().length > 0 ? `${existing}\n\n${excerpt}` : excerpt;
    },

    /** FR-005/FR-005a: branch a new Thread from a highlighted passage in an earlier (non-tip)
     *  message. Returns the newly created branch's DTO so the caller (`ThreadCard.vue`) can
     *  immediately show/focus it. */
    async branch(threadId: string, request: BranchThreadRequest): Promise<ConversationDto> {
      const thread = await httpClient.branchThread(activeDocumentId(), threadId, request);
      this.upsertThread(thread);
      return thread;
    },

    /** FR-008/FR-009: non-destructive, reversible — see `reopen` below. */
    async markDone(threadId: string): Promise<void> {
      const result = await httpClient.markThreadDone(activeDocumentId(), threadId);
      const thread = this.findThread(threadId);
      if (thread) thread.doneAt = result.doneAt;
    },

    async reopen(threadId: string): Promise<void> {
      await httpClient.reopenThread(activeDocumentId(), threadId);
      const thread = this.findThread(threadId);
      if (thread) thread.doneAt = null;
    },

    messagesFor(threadId: string): ConversationMessageState[] {
      return this.messagesByThread[threadId] ?? [];
    },

    findThread(threadId: string | null | undefined): ConversationDto | null {
      if (!threadId) return null;
      return this.threads.find((t) => t.id === threadId) ?? null;
    },

    upsertThread(dto: ConversationDto): void {
      const index = this.threads.findIndex((t) => t.id === dto.id);
      if (index === -1) this.threads.push(dto);
      else this.threads[index] = dto;
    },

    handleServerFrame(frame: ServerFrame): void {
      if (frame.kind === 'subscribed') {
        // Every Thread lives in the `conversation` table alongside canvas conversations
        // (data-model.md) — the snapshot's `conversations` array carries both kinds for a
        // `documentType: 'thread'` document; this store only ever cares about the thread-kind rows.
        this.threads = frame.frame.snapshot.conversations.filter(
          (c) => c.kind === 'thread-root' || c.kind === 'thread-branch',
        );
        this.lastEventSequence = frame.frame.currentSequence;
        return;
      }
      if (frame.kind !== 'event') return;
      const event = frame.frame;

      // Same per-document sequence-gap check as `conversations.ts`/`document.ts` — see their doc
      // comments for the full rationale (a dropped/out-of-order WS frame means this store's view
      // may be stale, so a full resync is safer than trusting a partial update).
      if (event.sequence !== null) {
        if (this.lastEventSequence !== null && event.sequence !== this.lastEventSequence + 1) {
          this.lastEventSequence = event.sequence;
          void this.resyncAfterGap();
          return;
        }
        this.lastEventSequence = event.sequence;
      }

      const threadId = event.conversationId;

      switch (event.type) {
        // A freshly-created root/branch Thread. Guarded on `event.data.kind` (not just "unknown
        // id") — the active document's WS stream also carries canvas-mode `conversation_started`
        // events when the two document types briefly overlap (e.g. a stale subscription during a
        // document switch); refetching via this store's thread-only endpoint for a canvas-kind id
        // would 409 (`DOCUMENT_WRONG_TYPE`), so this only ever reacts to genuine thread-kind rows.
        case 'conversation_started': {
          if (
            threadId &&
            (event.data.kind === 'thread-root' || event.data.kind === 'thread-branch') &&
            !this.threads.some((t) => t.id === threadId)
          ) {
            void this.refreshThreadMeta(threadId);
          }
          break;
        }

        case 'conversation_renamed': {
          const thread = this.findThread(threadId);
          if (thread) thread.name = event.data.name;
          break;
        }

        // FR-008/FR-009: keeps every connected client's default list and done panel live
        // without a full re-fetch (SC-003/SC-004).
        case 'conversation_done_changed': {
          const thread = this.findThread(threadId);
          if (thread) thread.doneAt = event.data.doneAt;
          break;
        }

        case 'staged_edit_created':
        case 'staged_edit_applied':
        case 'staged_edit_dropped':
        case 'staged_edit_superseded': {
          // Only ever refetched for a Thread this store already knows about — see the
          // `conversation_started` guard above for why a bare id isn't enough on its own.
          if (threadId && this.findThread(threadId)) void this.refreshThreadMeta(threadId);
          break;
        }

        case 'message_started': {
          if (!threadId || !this.findThread(threadId)) break;
          const list = ensureArray(this.messagesByThread, threadId);
          list.push({
            id: event.data.messageId,
            role: event.data.role,
            text: '',
            reasoning: null,
            isToolCallCarrier: false,
            toolCalls: [],
            streaming: true,
            createdAt: event.at,
          });
          break;
        }

        case 'text_delta': {
          if (!threadId || !this.findThread(threadId)) break;
          const list = ensureArray(this.messagesByThread, threadId);
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
              toolCalls: [],
              streaming: true,
              createdAt: event.at,
            });
          }
          break;
        }

        case 'thinking_delta': {
          if (!threadId || !this.findThread(threadId)) break;
          const list = ensureArray(this.messagesByThread, threadId);
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
              toolCalls: [],
              streaming: true,
              createdAt: event.at,
            });
          }
          break;
        }

        case 'message_completed': {
          if (!threadId || !this.findThread(threadId)) break;
          const list = ensureArray(this.messagesByThread, threadId);
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
              toolCalls: [],
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

    /** Full resync once a gap is detected — mirrors `conversations.ts`'s own `resyncAfterGap`. */
    async resyncAfterGap(): Promise<void> {
      await this.load();
      const threadIds = Object.keys(this.messagesByThread);
      await Promise.all(threadIds.map((id) => this.loadDetail(id)));
    },

    // Registered by App.vue's connectWs — see stores/document.ts's own doc comment for why every
    // store owns this.
    subscribeToFrames(wsClient: WsClient): () => void {
      return wsClient.onFrame((frame) => this.handleServerFrame(frame));
    },
  },
});
