<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { useListItemsStore } from '../../stores/listItems.js';
import { useThreadFocusState } from '../../composables/threadFocusState.js';
import { ApiError } from '../../transport/http-client.js';
import ThreadCard from './ThreadCard.vue';
import DoneThreadsPanel from './DoneThreadsPanel.vue';
import HudPanel, { type HudItem } from '../hud/HudPanel.vue';
import TodoParkingListsPanel from '../TodoParkingListsPanel.vue';

/**
 * 011-linear-thread-mode (FR-002/FR-003/FR-008): the top-level view App.vue mounts in
 * place of the canvas Preview/Canvas/History grid whenever the active document's
 * `documentType === 'thread'` — a single top-down, vertically-ordered list of Threads. No control
 * anywhere in this view creates a new independent top-level Thread (FR-003) — the only compose
 * affordance in the whole mode is `ThreadComposer.vue`, mounted per-Thread on that Thread's own
 * current tip segment (`ThreadCard.vue`).
 */
const store = useThreadStore();
const listItemsStore = useListItemsStore();
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
 *  (passed down to every `ThreadCard` below), no separate DOM write needed for that part.
 *
 *  `isHotkey` (default `false`, set `true` only by the template's `cycle-focus` listener below)
 *  distinguishes which of the two emits actually fired: `HudPanel.vue`'s own `cycle-focus` is
 *  ONLY ever emitted from its keyboard `cycleByOffset` (Ctrl+Alt+J/K), never a click — `toggle-focus`
 *  is the click-only emit — so this flag reliably tells `threadFocus.jumpTo`'s own `hotkey` option
 *  (see `threadFocusState.ts`) whether to center the resulting scroll or just nudge it into view. */
function onThreadHudSelect(threadId: string, isHotkey = false): void {
  threadFocus.jumpTo(threadId, { hotkey: isHotkey });
}

/** `DoneThreadsPanel.vue`'s Reopen action (User Story 3): "reopening pops it out of the Done list
 *  and re-enters the main thread list" — the thread itself already stops appearing in
 *  `DoneThreadsPanel.vue` the moment `store.reopen` flips its `doneAt` (that panel's own
 *  `doneThreads` computed re-filters live), so the only two things left to do here are close the
 *  Done overlay and land the reviewer on the newly-reopened thread in the normal list. Reuses the
 *  exact same "jump the cursor to this thread" mechanism a HUD row click/Ctrl+Alt+J/K hotkey
 *  already drives (`threadFocus.jumpTo`, `hotkey: true` so the `activeThreadId` watcher below
 *  centers + focuses its composer the same way a genuine keyboard jump does) rather than inventing
 *  a second, parallel "focus a specific thread" path. */
function onThreadReopened(threadId: string): void {
  doneOpen.value = false;
  threadFocus.jumpTo(threadId, { hotkey: true });
}

// Bug fix (parity with canvas mode): activating a thread — via a HUD row click OR either of the
// Ctrl+Alt+J/K/1..9 hotkeys, all three of which land here through `threadFocus.jumpTo`/
// `cycleByOffset`/`jumpToIndex` — used to only scroll/highlight the target `ThreadCard`, never
// move actual DOM focus into it. Canvas mode's own equivalent (`ConversationDetailPanel.vue`'s
// `useFocusTrap` + `getPreferredInitialFocus`) moves focus into the conversation's own composer by
// querying its `#composer-<id>` element and focusing it the moment that panel becomes active.
// Thread mode has no modal/focus-trap to key off (every `ThreadCard` renders inline, always — see
// `threadFocusState.ts`'s own doc comment), so this watcher does the same underlying
// lookup-by-id-and-focus directly: `ThreadComposer.vue`'s own textarea carries the matching
// `#thread-composer-<threadId>` id (same id-prefix convention `isEditingContext`'s `allowComposer`
// option already recognizes). Lands the reviewer ready to type immediately, exactly like canvas
// mode's click-a-HUD-row/hotkey behavior.
// `block`: 'center' for a genuine keyboard-driven jump (Ctrl+Alt+1..9/J/K/H/L — see
// `threadFocusState.ts`'s `wasHotkeyJump` doc comment), so the reviewer never has to hunt for where
// focus just landed; plain 'nearest' for a HUD row click, since the user just clicked something they
// could already see and a forced re-center would be a needless jolt.
watch(threadFocus.activeThreadId, (threadId) => {
  if (!threadId) return;
  const block = threadFocus.wasHotkeyJump.value ? 'center' : 'nearest';
  void nextTick(() => {
    document
      .querySelector(`.thread-card[data-thread-id="${threadId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block });
    document.querySelector<HTMLTextAreaElement>(`#thread-composer-${threadId}`)?.focus();
  });
});

// Ctrl+Alt+1..9 numbered-jump (bug fix, parity with canvas mode's own `focus-toggle-<N>`
// handling in `App.vue#onGlobalKeydown`): that binding is `'Global'` scope, so it's dispatched
// from App.vue (mounted for the app's whole lifetime), which has no direct access to this view's
// own `threadFocus` composable instance — exposing just this one narrow method (not the whole
// composable) mirrors the same "narrow accessor" convention `useConversationRename`'s `{ find,
// rename }` source already established for canvas/thread code-sharing in this codebase, and matches
// `DocumentCanvas.vue`'s own precedent of exposing specific methods/refs for `App.vue` to call
// (`documentCanvasRef.value?.scrollEl`) rather than lifting all of this view's state up.
//
// Bug fix: Ctrl+Alt+H/L/ArrowLeft/ArrowRight (`cycle-conversation-prev`/`-next` and their arrow/alt
// variants, also `'Global'` scope) were a silent no-op in Thread mode — App.vue's own handler for
// them only ever cycled `orderedFocusedConversations` (canvas mode's multi-focus overlay set, see
// `focusPanelState.ts`), which stays permanently empty for a `documentType: 'thread'` document
// (`conversationsStore` is never even loaded there). Thread mode has no equivalent "N floating
// panels" concept to cycle among (see `threadFocusState.ts`'s own doc comment) — its one and only
// focus concept is this same single `activeThreadId` cursor Ctrl+Alt+J/K already moves via
// `cycleByOffset` — so exposing that same method here lets App.vue reuse it for H/L too, exactly
// mirroring `jumpToIndex` just above rather than inventing a second, parallel focus model.
defineExpose({ jumpToIndex: threadFocus.jumpToIndex, cycleByOffset: threadFocus.cycleByOffset });

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

// ---------------------------------------------------------------------------------------------
// Export all (User Story 4/FR-013b): the whole-document counterpart of each `ThreadCard.vue`'s own
// single-thread export, exposed here as a HUD-level action alongside Expand-all/Done — it's a
// document-wide action in the same way those two are, not scoped to any single thread the way
// `ThreadCard.vue`'s own per-thread export button was (removed: per-thread export never made much
// sense standalone once the whole-document export exists). `threadStore.exportDocumentSession()`
// itself is untouched by this move — only its trigger's location changed. Opened in a new tab via a
// `Blob` object URL rather than rendered inline: the SDK designs this artifact as a standalone
// document with its own interactive branch-navigation JS, not something meant to be embedded inside
// a Vue component.
// ---------------------------------------------------------------------------------------------
const exportingDocument = ref(false);
const exportDocumentError = ref<string | null>(null);

async function onExportDocument(): Promise<void> {
  exportDocumentError.value = null;
  exportingDocument.value = true;
  try {
    const html = await store.exportDocumentSession();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
    // Revoked after a delay, not immediately: the newly opened tab reads the blob URL
    // asynchronously, so revoking synchronously here risks the tab seeing it gone before it loads.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    exportDocumentError.value =
      err instanceof ApiError && err.code === 'EMPTY_DOCUMENT_EXPORT'
        ? 'This document has no thread messages yet, so there is nothing to export.'
        : err instanceof Error
          ? err.message
          : 'Failed to export this document.';
  } finally {
    exportingDocument.value = false;
  }
}
</script>

<template>
  <div class="thread-mode-view">
    <!-- Sticky, same `EditorComponent.vue` `.editor-toolbar` pattern: `.thread-mode-view` below is
         itself the scrolling ancestor (App.vue's `.thread-mode-body` gives it the remaining
         viewport height), so this stays visible instead of scrolling away with a long thread.
         011-linear-thread-mode: this used to be a standalone `.thread-mode-toolbar` (plain title +
         buttons) — now the shared `HudPanel.vue` (the same component canvas mode's own toolbar
         mounts), so the two HUD surfaces stay visually/behaviorally identical rather than
         separately-maintained look-alikes.

         Layout, ported from `App.vue`'s own canvas-mode toolbar rather than stuffed into
         `HudPanel.vue`'s `#actions` slot (a prior version of this view did that — canvas mode's own
         usage of `HudPanel` never fills that slot, so it was never really a shared pattern): the
         shared `.hud-bar-columns`/`.hud-bar-left`/`.hud-bar-right` rules (style.css) split this bar
         into a left column holding just the HUD list and a right column holding the doc-wide
         Expand-all/Export-all/Done actions, exactly mirroring canvas's own
         "Conversations (HUD)" | "Global Actions" split — literally the same CSS, not a hand-copied
         look-alike (see that shared rule's own doc comment in style.css for why only this inner
         split is shared, not the outer bar itself).

         Two-complaint history, both from real user reports, resolved together below (see
         `.thread-mode-hud`'s own doc comment for the CSS side):
          1. Original ("the thread's header and expand/collapse all doesn't fit with the thread"):
             `.thread-mode-hud` used to paint itself as a flat, full-viewport-bleed strip with no
             border/rounding/relationship to the narrower, centered, bordered `.thread-card` tree
             beneath it.
          2. Regression, introduced by the first fix for (1): that fix made the painted HUD box
             itself shrink to the thread tree's own content-driven width — for the common
             single-Thread case (a ~640px trunk box), that reads as "the HUD shrunk" — a tiny
             floating card in an otherwise-empty full-width strip, no longer resembling a toolbar at
             all.
         Root-cause fix (both complaints, together): `.thread-mode-hud` stays a real, full-width
         PAINTED bar (background + bottom border, structurally the same role as canvas's own
         always-full-width `.toolbar` row) — its own width is NEVER coupled to its content's width,
         in either direction. Complaint 1 ("doesn't fit with the thread") is instead fixed by
         `.thread-mode-content`/`.thread-mode-list` below now being left-aligned/full-width (like
         canvas's own `.panes`) rather than centered/content-sized — the HUD bar above and the thread
         tree below now share the same left edge and the same full-width relationship to each other
         that canvas's toolbar/`.panes` pair always had, so there's no separate centering formula to
         keep in sync (and no way for it to drift back into complaint 2). -->
    <div class="thread-mode-hud">
      <div class="hud-bar-columns">
        <div class="hud-bar-left">
          <div class="hud-box">
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
              @cycle-focus="onThreadHudSelect($event, true)"
            />
          </div>
        </div>
        <div class="hud-bar-right">
          <div class="actions-group">
            <div class="actions-col actions-col-buttons">
              <button
                type="button"
                class="thread-mode-bulk-toggle"
                @click="store.toggleAllMessages()"
              >
                {{ bulkToggleLabel }}
              </button>
              <button
                type="button"
                class="thread-mode-export-all"
                title="Export the whole document's Pi session as a self-contained HTML file"
                :disabled="exportingDocument"
                @click="onExportDocument"
              >
                {{ exportingDocument ? 'Exporting…' : 'Export all' }}
              </button>
              <button type="button" class="thread-mode-done-toggle" @click="doneOpen = true">
                Done ({{ doneCount }})
              </button>
              <!-- 012-todo-parking-lists: the rail always shows — these two HUD buttons only
                   toggle each section's own visibility, per `TodoParkingListsPanel.vue`'s own doc
                   comment on `isVisible`. -->
              <button
                type="button"
                :aria-pressed="listItemsStore.todoVisible"
                :title="listItemsStore.todoVisible ? 'Hide the Todo list' : 'Show the Todo list'"
                @click="listItemsStore.toggleVisibility('todo')"
              >
                {{ listItemsStore.todoVisible ? 'Hide Todo' : 'Show Todo' }}
              </button>
              <button
                type="button"
                :aria-pressed="listItemsStore.parkingLotVisible"
                :title="
                  listItemsStore.parkingLotVisible
                    ? 'Hide the Parking Lot list'
                    : 'Show the Parking Lot list'
                "
                @click="listItemsStore.toggleVisibility('parking_lot')"
              >
                {{ listItemsStore.parkingLotVisible ? 'Hide Parking Lot' : 'Show Parking Lot' }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <p v-if="exportDocumentError" class="thread-mode-export-error" role="alert">
        {{ exportDocumentError }}
      </p>
    </div>

    <div class="thread-mode-row">
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

      <!-- 012-todo-parking-lists (US3, FR-023/FR-024): a fixed rail hugging the right edge,
           outside `.thread-mode-content` — narrows it via this row's flex layout rather than
           covering it. -->
      <!-- Unmounted entirely (not just visually collapsed) once both sections are hidden, so this
           rail's own `flex: 0 0 280px` stops reserving width and `.thread-mode-content`'s own
           `flex: 1 1 auto` reclaims it. -->
      <TodoParkingListsPanel
        v-if="listItemsStore.todoVisible || listItemsStore.parkingLotVisible"
        class="thread-mode-lists-rail"
      />
    </div>

    <Transition name="modal">
      <div
        v-if="doneOpen"
        class="modal-overlay done-threads-overlay"
        @click.self="doneOpen = false"
      >
        <DoneThreadsPanel @close="doneOpen = false" @reopened="onThreadReopened" />
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
/* 011-linear-thread-mode: the sticky, FULL-WIDTH PAINTED bar behind the shared `HudPanel.vue` —
   both the sticky positioning shell AND the visible box (see the template's own doc comment above
   for the two-complaint history this class alone resolves). `background`/`border-bottom`,
   structurally the same role as canvas mode's own `.toolbar` row (`App.vue`) — a header bar whose
   OWN width is always the full available width, never coupled to whatever content happens to be
   inside it (canvas's `.hud-box`+`.actions-group` together span its `.toolbar` row's full width
   regardless of conversation count; this bar behaves the same way regardless of thread-tree width).
   This is the one piece of the HUD that's genuinely mode-specific — Canvas's own `.toolbar` plays
   the exact same "always-full-width painted bar" role under its own name, so neither is renamed to
   match the other; only the `.hud-bar-columns`/`.hud-bar-left`/`.hud-bar-right` split nested inside
   it (style.css) is shared. `HudPanel.vue`'s own root (`.hud-panel`) stays exactly as generalized/
   shared with canvas mode — no CSS override of its internals lives here. */
.thread-mode-hud {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky, 2);
  background: var(--panel-bg, #f7f7f8);
  border-bottom: 2px solid var(--border-color, #ddd);
  width: 100%;
  padding: 0.6rem 1rem;
}
/* `.thread-mode-content`/`.thread-mode-list` used to be a centered, content-sized (`width:
   fit-content; margin: 0 auto`) column, with a `.thread-mode-hud-inner` wrapper reusing that same
   formula so the HUD's content row lined up above it — that coupling is what's fixed here instead:
   left-aligned/full-width, exactly like canvas mode's own always-full-width `.panes` grid, so the
   HUD bar above and the thread tree below now share the same left edge/full-width relationship with
   no separate centering formula to keep in sync (see the template's own doc comment above for the
   full two-complaint history this replaces). */
/* 012-todo-parking-lists: horizontal row so `.thread-mode-lists-rail` can sit alongside
   `.thread-mode-content` (narrowing it via `flex: 1 1 auto` + `min-width: 0` below) instead of
   overlapping it. A plain flex row, not `.thread-mode-view`'s own scroll container — the rail
   scrolls its own contents internally (TodoParkingListsPanel.vue's `overflow-y: auto`). */
/* `flex: 1 1 auto` + `min-height: 0` makes this row always fill exactly the space
   `.thread-mode-view` has left below the HUD (that outer height is itself already fixed to the
   viewport-minus-toolbar via the `.thread-mode-panes`/`.thread-mode-body` chain, App.vue) —
   regardless of how much/little thread content there is. `.thread-mode-content` below scrolls its
   own overflow internally instead of growing this row past that fixed height, which is what makes
   `.thread-mode-lists-rail`'s `height: 50%` a stable "50% of the viewport's available space"
   rather than 50% of whatever a short/tall thread's own content happened to need. */
.thread-mode-row {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
}
.thread-mode-content {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}
.thread-mode-lists-rail {
  flex: 0 0 280px;
  height: 50%;
  border-left: 1px solid var(--border-color, #ddd);
  background: var(--panel-bg, #f7f7f8);
}
.thread-mode-empty {
  color: var(--neutral-muted-color, #4b5563);
}
/* Plain inline text, same tone as `.load-error p` — sits directly inside `.thread-mode-hud` (so it
   stays part of the sticky HUD bar, not scrolling away with the page). */
.thread-mode-export-error {
  margin: 0.4rem 0 0;
  color: var(--danger-color, #b91c1c);
  font-size: 0.8rem;
}
/* `align-items: flex-start` + `overflow-x: auto`: each `ThreadCard.vue`'s root `.thread-node` is a
   flat, fixed `CARD_WIDTH_PX` (420px) regardless of depth (see that file's own doc comment), rather
   than stretching to fill this list's width. A tree with several branch levels/many siblings can
   end up wider than the viewport; scrolling it horizontally
   here (rather than clipping it, or forcing every ancestor to stretch to match it) is what keeps a
   plain, branch-free thread's narrow-viewport layout exactly as before while still letting a wide
   tree grow rightward without breaking the page. */
.thread-mode-list {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
  max-width: 100%;
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
