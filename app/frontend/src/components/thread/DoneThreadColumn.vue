<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { buildAncestorChain } from '../../composables/ancestorChain.js';
import MessageBubble from '../conversation/MessageBubble.vue';

/**
 * 011-linear-thread-mode, `DoneThreadsPanel.vue`'s column-per-done-thread redesign: one done
 * Thread's full, read-only lineage — every ancestor (oldest first, via `ancestorChain.ts`'s
 * `buildAncestorChain`, walking `parentId` up to the root) sliced to just the messages that lead to
 * THIS thread, each followed by a static "forked from here" marker, then this thread's own full
 * message list. No `ThreadComposer` anywhere — this view is strictly read-only; reopening is the
 * only way out of it.
 *
 * Reopen is a REQUEST, not performed here: this component only emits `reopen` on click — the
 * actual `store.reopen` call (and the `reopened` relay once it resolves) lives in
 * `DoneThreadsPanel.vue` instead. Load-bearing, not just layering preference: `store.reopen`
 * flips `doneAt`, which immediately drops this thread out of `DoneThreadsPanel.vue`'s own
 * `doneThreads` filter — Vue then unmounts THIS component (it's the `v-for` item keyed to that
 * filtered list) as part of the very same reactive flush. Vue's `emit()` is a silent no-op once
 * `instance.isUnmounted` (`runtime-core`'s own `emit()` guard) — so awaiting the store call
 * *inside* this component and emitting `reopened` afterward loses the race almost every time (the
 * unmount's reactive flush job is already queued by the time this component's own post-`await`
 * continuation resumes). `DoneThreadsPanel.vue` is never itself removed by this mutation (only its
 * per-thread `v-for` children are), so doing the async work and the relay emit there instead is
 * race-free. `reopening`/`reopenError` are passed down as plain props for the same reason — this
 * component only ever displays that state, never owns it. */
const props = withDefaults(
  defineProps<{
    threadId: string;
    reopening?: boolean;
    reopenError?: string | null;
  }>(),
  { reopening: false, reopenError: null },
);
const emit = defineEmits<{ (e: 'reopen', threadId: string): void }>();

const store = useThreadStore();

const thread = computed(() => store.findThread(props.threadId));

const chain = computed(() =>
  buildAncestorChain(
    props.threadId,
    (id) => store.findThread(id),
    (id) => store.messagesFor(id),
  ),
);

/** Every thread id this column's chain touches (every ancestor, oldest first, plus this thread
 *  itself) — the scope both message-loading (below) and the chain-wide Expand-all/Collapse-all
 *  toggle loop over. Derived from `chain` itself (not re-walked separately) so the two can never
 *  disagree about which threads are in this lineage. */
const chainThreadIds = computed(() => [
  ...chain.value.ancestors.map((a) => a.threadId),
  props.threadId,
]);

/** A thread's own first message is its auto-delivered `<branch-seed-excerpt>` seed
 *  (`ConversationService.sendBranchSeedMessage`) only when it's a `thread-branch` with
 *  `seedExcerptText` populated — same check `ThreadCard.vue`'s own `isSeedMessage` makes. An
 *  ancestor's messages here are only ever sliced from the END (their trailing, post-fork messages),
 *  never the start, so index 0 of an ancestor's `messages` array is still that ancestor's real
 *  index 0. */
function isSeedMessage(chainThreadId: string, index: number): boolean {
  if (index !== 0) return false;
  const t = store.findThread(chainThreadId);
  return t?.kind === 'thread-branch' && t?.seedExcerptText != null;
}

function expandedFor(chainThreadId: string, messageId: string): boolean {
  return store.expandedByMessage[chainThreadId]?.[messageId] ?? false;
}

function setExpanded(chainThreadId: string, messageId: string, expanded: boolean): void {
  store.setMessageExpanded(chainThreadId, messageId, expanded);
}

const anyCollapsedInChain = computed(() =>
  chainThreadIds.value.some((id) => store.anyMessageCollapsedForThread(id)),
);
const bulkToggleLabel = computed(() => (anyCollapsedInChain.value ? 'Expand all' : 'Collapse all'));

/** Chain-wide Expand-all/Collapse-all: pure orchestration over the EXISTING per-thread bulk toggle
 *  (`toggleAllMessagesForThread`/`anyMessageCollapsedForThread`, already used by `ThreadCard.vue`
 *  and `ThreadModeView.vue`'s own document-wide equivalent) — looped over every thread id in this
 *  column's lineage. No new per-message state. */
function onToggleAll(): void {
  for (const id of chainThreadIds.value) store.toggleAllMessagesForThread(id);
}

function onReopenClick(): void {
  emit('reopen', props.threadId);
}

const rootEl = ref<HTMLElement | null>(null);

/** Loads (idempotently — `ThreadCard.vue`'s own `onMounted` `loadDetail` guard uses the same
 *  pattern) every chain thread's messages, then seeds its expand/collapse state — a done thread's
 *  ancestors are otherwise never mounted by `ThreadCard.vue` (that component never renders a done
 *  branch inline, see its own `activeChildIds` doc comment), so nothing else in the app guarantees
 *  their messages are already loaded by the time this column needs to slice/render them. */
function ensureLoaded(id: string): void {
  if (store.messagesByThread[id]) {
    store.ensureMessageExpandedSeeded(id);
    return;
  }
  void store.loadDetail(id).then(() => store.ensureMessageExpandedSeeded(id));
}

onMounted(() => {
  for (const id of chainThreadIds.value) ensureLoaded(id);

  // Auto-scroll to the LAST marker in the chain (bordering this thread's own unique content) —
  // same `scrollIntoView` idiom as `App.vue`'s `scrollComposerIntoView`/`ThreadModeView.vue`'s
  // hotkey-jump watcher. Scoped to this column's own root (not a global `document.querySelector`)
  // since several columns can render a `[data-fork-marker-tip]` node at once. No-op when this
  // thread has no ancestors at all (a done root thread) — there is no marker to scroll to.
  void nextTick(() => {
    rootEl.value
      ?.querySelector('[data-fork-marker-tip="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});
</script>

<template>
  <section v-if="thread" ref="rootEl" class="done-thread-column" :data-thread-id="threadId">
    <header class="done-thread-column-header">
      <span class="done-thread-column-name text-wrap-safe">{{ thread.name }}</span>
      <span class="done-thread-column-actions">
        <button type="button" class="done-thread-bulk-toggle" @click="onToggleAll">
          {{ bulkToggleLabel }}
        </button>
        <button type="button" :disabled="reopening" @click="onReopenClick">Reopen</button>
      </span>
    </header>
    <p v-if="reopenError" class="done-thread-reopen-error" role="alert">{{ reopenError }}</p>

    <div class="done-thread-column-body">
      <template v-for="(ancestor, ancestorIndex) in chain.ancestors" :key="ancestor.threadId">
        <p class="done-thread-ancestor-label">── {{ ancestor.threadName }} ──</p>
        <div
          v-for="(message, index) in ancestor.messages"
          :key="message.id"
          class="done-thread-message"
        >
          <MessageBubble
            :message="message"
            :seed="isSeedMessage(ancestor.threadId, index)"
            :expanded="expandedFor(ancestor.threadId, message.id)"
            @update:expanded="(value) => setExpanded(ancestor.threadId, message.id, value)"
          />
        </div>
        <!-- Static, non-interactive marker — no click handler. `data-fork-marker-tip` only on the
             LAST ancestor's own marker (the one directly bordering this thread's own content
             below), so the mount-time scroll above lands on exactly that one. -->
        <p
          class="done-thread-fork-marker"
          :data-fork-marker-tip="ancestorIndex === chain.ancestors.length - 1 ? 'true' : undefined"
        >
          <span class="done-thread-fork-marker-glyph" aria-hidden="true">⑂</span>
          forked from "{{ ancestor.threadName }}" here — from here, this is a unique conversation
        </p>
      </template>

      <div
        v-for="(message, index) in chain.ownMessages"
        :key="message.id"
        class="done-thread-message"
      >
        <MessageBubble
          :message="message"
          :seed="isSeedMessage(threadId, index)"
          :expanded="expandedFor(threadId, message.id)"
          @update:expanded="(value) => setExpanded(threadId, message.id, value)"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Fixed width, independently vertically scrollable — `ThreadModeView.vue`'s own `.thread-mode-list`
   is the model for this same "flat width, page/row-level horizontal scroll" convention
   (`ThreadCard.vue`'s `.thread-node`, 420px) applied here at the row level instead
   (`.done-threads-columns` in `DoneThreadsPanel.vue` provides the horizontal `overflow-x: auto`). */
.done-thread-column {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  width: 420px;
  flex: 0 0 auto;
  max-height: 100%;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 8px;
  background: var(--panel-bg, #f7f7f8);
  overflow: hidden;
}
.done-thread-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border-color, #ccc);
}
.done-thread-column-name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.done-thread-column-actions {
  display: flex;
  gap: 0.35rem;
  flex: 0 0 auto;
}
.done-thread-reopen-error {
  margin: 0 0.6rem;
  color: var(--danger-color, #b91c1c);
  font-size: 0.8rem;
}
.done-thread-column-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 0.6rem 0.75rem;
}
.done-thread-ancestor-label {
  margin: 0.5rem 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--neutral-muted-color, #4b5563);
  text-align: center;
}
.done-thread-column-body > .done-thread-ancestor-label:first-child {
  margin-top: 0;
}
.done-thread-fork-marker {
  margin: 0.6rem -0.6rem 0.85rem;
  padding: 0.5rem 0.75rem;
  border-left: 4px solid var(--info-border, #bfdbfe);
  background: var(--info-bg, #eff6ff);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--info-color, #1e3a8a);
  text-align: center;
}
.done-thread-fork-marker-glyph {
  margin-right: 0.35rem;
  font-size: 1.15rem;
  font-weight: 700;
}
</style>
