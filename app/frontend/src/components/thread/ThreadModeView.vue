<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { useThreadFocusState } from '../../composables/threadFocusState.js';
import ThreadCard from './ThreadCard.vue';
import DoneThreadsPanel from './DoneThreadsPanel.vue';
import HudPanel, { type HudItem } from '../hud/HudPanel.vue';

/**
 * 011-linear-thread-mode (FR-002/FR-003/FR-008): the top-level view App.vue mounts in
 * place of the canvas Preview/Canvas/History grid whenever the active document's
 * `documentType === 'thread'` — a single top-down, vertically-ordered list of Threads. No control
 * anywhere in this view creates a new independent top-level Thread (FR-003) — the only compose
 * affordance in the whole mode is `ThreadComposer.vue`, mounted per-Thread on that Thread's own
 * current tip segment (`ThreadCard.vue`).
 */
const store = useThreadStore();
const doneOpen = ref(false);

onMounted(() => {
  if (!store.loaded) void store.load();
});

/** The default list shows only active Threads (`doneAt === null`) — done ones are reachable
 *  only via `DoneThreadsPanel.vue` (FR-008). A Thread is rendered as its own top-level entry here
 *  only when it has no active parent to nest under — ordinarily just the single root thread
 *  (FR-003), except when a parent has been marked done: FR-011 requires its still-active
 *  descendants to keep appearing in the default list, so a done thread's active children are
 *  promoted to top-level entries of their own rather than disappearing along with it. */
const activeThreads = computed(() => store.threads.filter((t) => t.doneAt === null));
const topLevelThreadIds = computed(() => {
  const activeIds = new Set(activeThreads.value.map((t) => t.id));
  return activeThreads.value
    .filter((t) => !t.parentId || !activeIds.has(t.parentId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => t.id);
});

const doneCount = computed(() => store.threads.filter((t) => t.doneAt !== null).length);

// ---------------------------------------------------------------------------------------------
// 011-linear-thread-mode: Thread mode's own HUD, the shared `HudPanel.vue` component (generalized
// from the canvas-only HUD it used to be exclusively — see that file's own top doc comment)
// replacing this view's former standalone `.thread-mode-toolbar` title bar. Every Thread/branch is
// already rendered inline, always (no reveal-on-focus concept the way canvas mode's detail panels
// have), so "focus" here is a single cursor position (`threadFocusState.ts`) rather than a real
// multi-focus set:
//  - `focusedIds` is always empty and `focusCap` effectively unlimited — there is nothing to
//    toggle membership in, so both are passed through as inert, always-satisfied values rather
//    than distorting `HudPanel.vue`'s own shared contract to fit a mode that doesn't need it.
//  - `toggle-focus` (a HUD row click) and `cycle-focus` (Ctrl+Alt+J/K) are both wired to the exact
//    same handler: clicking a row jumps/scrolls to that thread, identical to cycling to it.
// ---------------------------------------------------------------------------------------------
const threadFocus = useThreadFocusState();
const EMPTY_FOCUSED_IDS: ReadonlySet<string> = new Set();

const hudItems = computed<HudItem[]>(() =>
  threadFocus.orderedEntries.value.map(({ id, depth }) => {
    const thread = store.findThread(id);
    return { id, name: thread?.name ?? id, depth };
  }),
);

/** Both `HudPanel.vue`'s `toggle-focus` (row click) and `cycle-focus` (Ctrl+Alt+J/K) emits land
 *  here — see the doc comment above for why Thread mode collapses the two into one "jump the
 *  cursor to this thread" action. Scrolls the matching `ThreadCard` into view; the
 *  `.thread-card--active` highlight itself follows reactively from `threadFocus.activeThreadId`
 *  (passed down to every `ThreadCard` below), no separate DOM write needed for that part. */
function onThreadHudSelect(threadId: string): void {
  threadFocus.jumpTo(threadId);
}

watch(threadFocus.activeThreadId, (threadId) => {
  if (!threadId) return;
  void nextTick(() => {
    document
      .querySelector(`.thread-card[data-thread-id="${threadId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});

/** Document-wide "Expand all"/"Collapse all" (`stores/thread.ts`'s own doc comment explains why
 *  this is document-wide rather than per-Thread, unlike canvas mode's `useBulkToggleAction`).
 *  Deliberately kept alongside `ThreadCard.vue`'s own newer per-Thread "Expand all"/"Collapse all"
 *  (its sticky header's own bulk-toggle action, scoped to just that one Thread's messages via
 *  `anyMessageCollapsedForThread`/`toggleAllMessagesForThread`) rather than replaced by it — this
 *  one's "collapse everything, everywhere, in one click" convenience and the per-branch one's fine-
 *  grained control over a single Thread are complementary, not redundant. */
const bulkToggleLabel = computed(() =>
  store.anyMessageCollapsed() ? 'Expand all' : 'Collapse all',
);
</script>

<template>
  <div class="thread-mode-view">
    <!-- Sticky, same `EditorComponent.vue` `.editor-toolbar` pattern: `.thread-mode-view` below is
         itself the scrolling ancestor (App.vue's `.thread-mode-body` gives it the remaining
         viewport height), so this stays visible instead of scrolling away with a long thread.
         011-linear-thread-mode: this used to be a standalone `.thread-mode-toolbar` (plain title +
         buttons) — now the shared `HudPanel.vue` (the same component canvas mode's own toolbar
         mounts), so the two HUD surfaces stay visually/behaviorally identical rather than
         separately-maintained look-alikes. Its own doc-wide Expand-all/Done actions (unrelated to
         any single thread — unlike `ThreadCard.vue`'s own per-thread bulk-toggle) move into
         `HudPanel.vue`'s `#actions` slot rather than a second, adjacent toolbar strip. "Export all"
         used to live here too, but moved to `App.vue`'s title bar (next to History) since both are
         document-level actions, not scoped to this tree view the way Expand-all/Done are. -->
    <div class="thread-mode-hud">
      <HudPanel
        label="Threads"
        :items="hudItems"
        :active-id="threadFocus.activeThreadId.value"
        :focused-ids="EMPTY_FOCUSED_IDS"
        :focus-cap="Infinity"
        filter="all"
        :show-filter="false"
        hotkey-scope="Thread list"
        @toggle-focus="onThreadHudSelect"
        @cycle-focus="onThreadHudSelect"
      >
        <template #actions>
          <button type="button" class="thread-mode-bulk-toggle" @click="store.toggleAllMessages()">
            {{ bulkToggleLabel }}
          </button>
          <button type="button" class="thread-mode-done-toggle" @click="doneOpen = true">
            Done ({{ doneCount }})
          </button>
        </template>
      </HudPanel>
    </div>

    <div class="thread-mode-content">
      <p v-if="store.loaded && topLevelThreadIds.length === 0" class="thread-mode-empty">
        No active threads.
      </p>

      <div class="thread-mode-list">
        <ThreadCard
          v-for="id in topLevelThreadIds"
          :key="id"
          :thread-id="id"
          :active-thread-id="threadFocus.activeThreadId.value"
        />
      </div>
    </div>

    <Transition name="modal">
      <div
        v-if="doneOpen"
        class="modal-overlay done-threads-overlay"
        @click.self="doneOpen = false"
      >
        <DoneThreadsPanel @close="doneOpen = false" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.thread-mode-view {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
/* 011-linear-thread-mode: the sticky positioning shell around the shared `HudPanel.vue` — the
   panel itself (`.hud-panel`, `HudPanel.vue`'s own scoped style) stays non-sticky/unstyled-for-
   position so canvas mode's own (non-sticky) usage in `App.vue`'s toolbar is unaffected; this
   wrapper is Thread-mode-specific positioning only, same pattern `App.vue`'s own `.hud-box` uses to
   wrap its canvas-mode `HudPanel` without baking sticky behavior into the shared component.
   Deliberately a sibling of (not nested inside) `.thread-mode-content` below, and deliberately
   `width: 100%` with no `max-width`, so it always spans this view's full available width — the
   same way canvas mode's own `.hud-box` spans its (unconstrained) `.toolbar-left` column — instead
   of tracking `.thread-mode-content`'s own content-driven `fit-content` width. A previous version
   of this rule capped it at `max-width: 900px` (matching `.thread-mode-content`'s own pre-tree-
   layout-redesign width); that cap was never removed when `.thread-mode-content` was widened to
   `fit-content`/`calc(100vw - 2.5rem)` below, which is why the HUD stayed narrow while the tree
   below it grew to fill the viewport. */
.thread-mode-hud {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky, 2);
  background: var(--panel-bg, #f7f7f8);
  border-bottom: 2px solid var(--border-color, #ddd);
  width: 100%;
  padding: 0.6rem 1rem;
}
/* `width: fit-content` (not `width: 100%`) + `margin: 0 auto`: this box shrinks to whatever its
   actual content needs (a lone, branch-free thread's ~640px trunk box, or a wider tree once
   branches are involved) and centers that on the page, rather than always claiming a fixed 900px
   reading column regardless of content. That fixed-900px version of this rule is what used to force
   horizontal scrolling immediately for even a single branch: `ThreadCard.vue`'s trunk box alone is
   640px, so trunk + one branch (see that file's own `CARD_MAX_WIDTH_PX`/connector-width doc comment)
   already exceeds 900px on its own, before the tree gets anywhere near an actual 1280–1440px laptop
   viewport's real available width. `max-width: calc(100vw - 2.5rem)` — the same per-viewport cap
   `ThreadCard.vue`'s own boxes already use — is this view's own outer safety net for genuinely wide/
   deep trees, so they still cap out at a sane width instead of growing edge-to-edge; `.thread-mode-
   list`'s own `overflow-x: auto` below is what actually lets a tree past that cap scroll instead of
   clipping. Unlike `.thread-mode-hud` above, this box's width is intentionally content-driven, not
   viewport-spanning — only the HUD needs to match canvas mode's full-width toolbar; the thread tree
   itself should stay a centered, content-sized column (scrolling sideways only once it outgrows the
   viewport) exactly as before this fix. */
.thread-mode-content {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: fit-content;
  max-width: calc(100vw - 2.5rem);
  margin: 0 auto;
  padding: 1rem;
}
.thread-mode-empty {
  color: var(--neutral-muted-color, #4b5563);
}
/* `align-items: flex-start` + `overflow-x: auto`: each `ThreadCard.vue`'s root `.thread-node` sizes
   itself to its own content width (trunk box, plus a further-right column per branch depth — see
   that file's own doc comment), rather than stretching to fill this list's width. A tree with
   several branch levels/many siblings can end up wider than `.thread-mode-content`'s own
   `max-width` above; scrolling it horizontally here (rather than clipping it, or forcing every
   ancestor to stretch to match it) is what keeps a plain, branch-free thread's narrow-viewport
   layout exactly as before while still letting a wide tree grow rightward without breaking the
   page — a last resort for genuinely wide/deep trees, not the routine experience for the common
   1–2 branch-level cases `.thread-mode-content`'s own sizing above and `ThreadCard.vue`'s per-depth
   width shrinking are meant to keep out of scrolling range in the first place. */
.thread-mode-list {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}
/* `.modal-overlay`'s shared base rule (see its own comment in style.css) deliberately leaves
   z-index to each caller, since overlays nest. `.done-threads-overlay` needs an explicit z-index
   here for the same reason `HistoryPanel.vue`'s `.diff-overlay` does: at `z-index: auto`, this
   `position: fixed` overlay wouldn't establish its own stacking context and would paint in plain
   tree order within the page's root stacking context — where both `.thread-mode-toolbar` above
   (`--z-sticky`) and every `ThreadCard.vue`'s own per-branch sticky header (`--z-raised`) DO
   establish one and paint above any unstyled (auto) content in that same root context, regardless
   of DOM order. `--z-overlay-blocking`, matching `.diff-overlay`'s own precedent: this is an
   independent, page-level "simple" modal with no nesting relationship to any other overlay in this
   mode, so it must always render above every sticky header/toolbar/popover tier below
   `--z-indicator`, no exceptions. */
.done-threads-overlay {
  z-index: var(--z-overlay-blocking, 70);
}
</style>
