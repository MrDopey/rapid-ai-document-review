<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { useThreadFocusState } from '../../composables/threadFocusState.js';
import { ApiError } from '../../transport/http-client.js';
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
         separately-maintained look-alikes. Its own doc-wide Expand-all/Export-all/Done actions
         (unrelated to any single thread — unlike `ThreadCard.vue`'s own per-thread bulk-toggle) move
         into `HudPanel.vue`'s `#actions` slot — the same right-hand header cluster canvas mode's own
         usage of this component reserves for its Active/All filter toggle — rather than a second,
         adjacent toolbar strip.

         Visual-fit bug fix (user report: "the thread's header and expand/collapse all doesn't fit
         with the thread"): `.thread-mode-hud` below is deliberately just a full-width STICKY
         POSITIONING SHELL now, not the painted box itself (same "sticky positions the margin edge,
         not the painted box" split `ThreadCard.vue`'s own `.thread-card-header` doc comment already
         uses) — the actual bordered/rounded card lives on the new `.thread-mode-hud-card` wrapper
         just inside it. Root cause: `HudPanel.vue` genuinely IS the same shared component canvas
         mode uses (no divergent/forked implementation crept back in), but this view used to paint
         `.thread-mode-hud` itself as a flat, full-viewport-bleed strip (background + a bottom border
         only, no side borders, no rounding) with no relationship to the width of the actual content
         beneath it — for the common case of a single un-branched Thread (a narrow, centered,
         properly-boxed ~640px `.thread-card`), that produced a full-width flat gray bar sitting above
         a small floating box, looking obviously disconnected from "the thread" it's the header for
         (confirmed visually via Playwright). `.thread-mode-hud-card` instead reuses the exact same
         `width: fit-content; max-width: calc(100vw - 2.5rem); margin: 0 auto;` sizing formula
         `.thread-mode-content` below already uses for the SAME reason (a lone thread stays a
         modest, centered card; a wide/deep tree grows the header to match, right up to the same
         viewport cap) — this is what actually makes the header "reuse"/track the thread's own width
         rather than merely copying canvas mode's unrelated 80/20 toolbar-column proportions, which
         only coincidentally happened to span similar total width there. It also picks up the same
         bordered, rounded-card treatment every other box in this app already uses (canvas's own
         `.hud-box`, and this very page's `.thread-card`/`.thread-card-header`), rather than being the
         one unboxed, flat exception. -->
    <div class="thread-mode-hud">
      <div class="thread-mode-hud-card">
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
          </template>
        </HudPanel>
        <p v-if="exportDocumentError" class="thread-mode-export-error" role="alert">
          {{ exportDocumentError }}
        </p>
      </div>
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
   `width: 100%` with no `max-width` — this shell itself always spans this view's full available
   width so the sticky positioning math/click target covers the whole header row, exactly like
   `ThreadCard.vue`'s own `.thread-card-header` doc comment's "sticky positions the margin edge, not
   the painted box" split. It carries NO visible box styling of its own (no border/background/
   radius) — see `.thread-mode-hud-card` just below for why, and for the actual box. A previous
   version of this rule capped it at `max-width: 900px` (matching `.thread-mode-content`'s own
   pre-tree-layout-redesign width), later removed entirely so it could span full width like canvas
   mode's own toolbar row — but that made this shell itself the visible, borderless, edge-to-edge
   painted strip (bug report: "the thread's header and expand/collapse all doesn't fit with the
   thread"): for a single, un-branched Thread (a narrow, centered, properly-boxed ~640px
   `.thread-card`), a full-viewport-wide flat gray bar sitting above one small floating box reads as
   obviously disconnected from the very thread it's the header for. Splitting the sticky shell (this
   rule) from the painted card (`.thread-mode-hud-card` below) keeps the earlier full-width-shell fix
   intact while letting the actual visible box track the tree's own width instead. */
.thread-mode-hud {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky, 2);
  width: 100%;
  padding: 0.6rem 1rem;
}
/* The actual painted HUD card — reuses `.thread-mode-content` below's exact
   `width: fit-content; max-width: calc(100vw - 2.5rem); margin: 0 auto;` sizing formula (see that
   rule's own doc comment for why: a lone thread stays a modest, centered box; a wide/deep tree
   grows the header to match, right up to the same per-viewport cap `ThreadCard.vue`'s own boxes
   use) so the header's own width actually tracks "the thread" beneath it, plus the same bordered/
   rounded-card treatment every other box in this app already carries (canvas mode's own `.hud-box`,
   this very page's own `.thread-card`/`.thread-card-header`) instead of being the one unboxed, flat
   exception. `HudPanel.vue`'s own root (`.hud-panel`) stays exactly as generalized/shared with
   canvas mode — no CSS override of its internals lives here, only this wrapper around it. */
.thread-mode-hud-card {
  width: fit-content;
  max-width: calc(100vw - 2.5rem);
  margin: 0 auto;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--panel-bg, #f7f7f8);
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
/* Plain inline text, same tone as `.load-error p` — sits inside `.thread-mode-hud-card` (so it
   scrolls with, and wraps to, the same centered/width-capped card as the rest of the sticky HUD row,
   not scrolling away with the page). */
.thread-mode-export-error {
  margin: 0.4rem 0 0;
  color: var(--danger-color, #b91c1c);
  font-size: 0.8rem;
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
