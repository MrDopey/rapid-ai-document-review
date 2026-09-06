<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import EditorComponent from '../editor/EditorComponent.vue';
import ConversationThreadBox from '../conversation/ConversationThreadBox.vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { computeAnchorY, type AnchorPositionSource } from './anchorY.js';
import {
  computeConversationLayout,
  resolveAnchorRoot,
  type ConversationLayoutInput,
} from './conversationLayout.js';
import {
  loadCanvasScrollPosition,
  persistCanvasScrollPosition,
  loadEditorSplit,
  persistEditorSplit,
} from '../../composables/panePersistence.js';
import { clamp, useResizeHandle } from '../../composables/useResizeHandle.js';

// 005-canvas-conversation-threads/US4 (T023's handoff, fulfilled here): `filter` is lifted state
// owned by `App.vue` (shared with `HudPanel.vue`'s "Active only"/"All" toggle) rather than local —
// filtering the array that reaches `computeConversationLayout` below is the entire integration
// point Phase 4 left for "reflow up when a conversation leaves view" to fall out for free.
// `focusedConversationIds` (App.vue's `focusedConversationIds`, multi-focus overlay) is threaded
// down so each `ConversationThreadBox` can tell whether *it* is one of the (possibly several)
// conversations currently shown in an open detail panel — its header's "Close" action only renders
// while that's true (see that component's `isFocused` prop doc comment). `maxFocusedConversations`
// (the live, viewport-aware cap) lets each box compute its own Focus-button disabled affordance.
// Bug-fix (editor-vs-canvas scope fix): `editorVisible` gates *only* `EditorComponent` below
// (`v-show`, so CodeMirror's mounted state and the scroll-sync `anchorTop` ref survive being
// hidden) — `.thread-columns` always renders regardless, since hiding the editor must never hide
// the conversation sidebar. This replaced `App.vue`'s own `v-show="canvasVisible"` on the whole
// `<DocumentCanvas>` element, which used to hide both at once. Defaulted to `true` so every
// existing test/usage that doesn't pass it (there is none left after this fix, but keeps the prop
// optional/non-breaking for any future direct mount) behaves exactly as before this prop existed.
const props = withDefaults(
  defineProps<{
    modelValue: string;
    filter: 'active' | 'all';
    focusedConversationIds: ReadonlySet<string>;
    maxFocusedConversations: number;
    editorVisible?: boolean;
  }>(),
  { editorVisible: true },
);
const emit = defineEmits<{
  (e: 'change', changes: { from: number; to: number; insert: string }[]): void;
  (
    e: 'branch-from-selection',
    range: { from: number; to: number },
    includeSeedMessage: boolean,
  ): void;
  (e: 'toggle-focus', conversationId: string): void;
  // Relays `ConversationThreadBox.vue`'s sidebar "Branch this conversation" result up to App.vue,
  // same auto-focus-on-success convention as `ConversationDetailPanel.vue`'s own `branch-created`
  // (focus-view "Branch" button) — see App.vue's consolidated `onBranchCreated` handler.
  (e: 'branch-created', conversationId: string): void;
}>();

const conversationsStore = useConversationsStore();

// `shallowRef` (not a plain `ref`) since this only ever holds a stable component-instance
// reference, never something reactive itself — `EditorComponent`'s exposed `anchorTop` is what
// actually changes meaning as the document/selection changes, not this ref itself.
const editorRef = shallowRef<AnchorPositionSource | null>(null);
// Bumped once in `EditorComponent`'s own `onMounted` (via a template ref callback, which Vue calls
// after the child mounts) purely so `layoutEntries` below — which reads `editorRef.value` — has
// something reactive to depend on for its very first recompute; `editorRef` itself is a plain
// object reference Vue's reactivity system won't otherwise notice becoming non-null on its own.
const editorReady = ref(false);
function onEditorRef(instance: unknown): void {
  editorRef.value = instance as AnchorPositionSource | null;
  if (instance) editorReady.value = true;
}

// US2 (T022): sibling-collision stacking needs each box's *actual* rendered height (message count
// varies per conversation), not a fixed assumption — tracked via one shared `ResizeObserver`
// rather than a `ResizeObserver` per box, since this is a small-N problem (plan.md's Performance
// Goals: bounded by `maxConversationDepth`, default 3) where the extra bookkeeping of a per-box
// observer buys nothing a shared one doesn't already give for free.
const ESTIMATED_BOX_HEIGHT_PX = 160; // before a box has ever reported its own measured height
// ConversationThreadBox is a fixed 320px wide (see that component's own `.conversation-thread-box`
// CSS) plus a visible inter-column gap — this constant is that box width *plus* the gap, since it
// doubles as the horizontal pitch used for each `.thread-column`'s `left` offset below. The gap
// portion was 340 - 320 = 20px; bumped here to 20 * 1.5 = 30px (340 -> 350) per an explicit request
// to widen the horizontal gap *between depth columns* by 1.5x. Distinct from `MIN_STACK_GAP_PX`
// below, which (per `conversationLayout.ts`'s own JSDoc) only governs the *vertical* gap between
// boxes stacked within one column — that constant is untouched by this change.
const COLUMN_WIDTH_PX = 350;
const MIN_STACK_GAP_PX = 24; // 1.5x the previous 16px, for clearer visual separation between stacked boxes

const boxHeights = ref(new Map<string, number>());
const observedEls = new Map<string, HTMLElement>();
let resizeObserver: ResizeObserver | null = null;

// Each box independently reporting its own real height as its content mounts/loads produces a
// *burst* of separate `ResizeObserver` callback invocations rather than one single batch,
// especially at realistic conversation counts. Writing every one of those invocations straight
// into the reactive `boxHeights` ref would force its own full `layoutEntries` recompute per box
// (and, before the anchorY cache below, its own full re-measurement of *every* conversation's
// CodeMirror anchor). Buffering pending height changes in a plain (non-reactive) map and flushing
// them into `boxHeights` at most once per animation frame collapses a burst of N separate resize
// notifications into far fewer reactive updates — the `layoutEntries` computed still sees every
// real height change, just coalesced, so the final stacked layout is identical, only computed less
// often.
const pendingBoxHeights = new Map<string, number>();
let boxHeightsFlushHandle: number | null = null;
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 0) as unknown as number;
const cancelScheduledFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (handle) => clearTimeout(handle);

function flushBoxHeights(): void {
  boxHeightsFlushHandle = null;
  if (pendingBoxHeights.size === 0) return;
  const next = new Map(boxHeights.value);
  for (const [conversationId, height] of pendingBoxHeights) next.set(conversationId, height);
  pendingBoxHeights.clear();
  boxHeights.value = next;
}

function registerBoxEl(conversationId: string, instance: { el: HTMLElement | null } | null): void {
  const el = instance?.el ?? null;
  const previous = observedEls.get(conversationId);
  if (previous === el) return;
  if (previous && resizeObserver) resizeObserver.unobserve(previous);
  if (el) {
    observedEls.set(conversationId, el);
    resizeObserver?.observe(el);
  } else {
    observedEls.delete(conversationId);
    pendingBoxHeights.delete(conversationId);
    boxHeights.value.delete(conversationId);
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const conversationId = (entry.target as HTMLElement).dataset.conversationId;
      if (!conversationId) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (boxHeights.value.get(conversationId) !== height) {
        pendingBoxHeights.set(conversationId, height);
        changed = true;
      }
    }
    if (changed && boxHeightsFlushHandle === null)
      boxHeightsFlushHandle = scheduleFrame(flushBoxHeights);
  });
  for (const el of observedEls.values()) resizeObserver.observe(el);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (boxHeightsFlushHandle !== null) cancelScheduledFrame(boxHeightsFlushHandle);
  if (scrollFlushTimer) clearTimeout(scrollFlushTimer);
});

// T034 (data-model.md's `CanvasScrollPosition`, research.md §8): restore the canvas's own native
// scroll offsets on mount, and persist them on scroll — debounced the same way
// `EditorComponent.vue` debounces its own high-frequency `change` events (`CLIENT_BATCH_DEBOUNCE_MS`),
// so a full scroll gesture doesn't write to `localStorage` on every tick.
const SCROLL_PERSIST_DEBOUNCE_MS = 250;
const canvasEl = ref<HTMLElement | null>(null);
let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null;

function onCanvasRootRef(el: unknown): void {
  canvasEl.value = el as HTMLElement | null;
  if (!canvasEl.value) return;
  const saved = loadCanvasScrollPosition();
  if (saved) {
    canvasEl.value.scrollLeft = saved.scrollLeft;
    canvasEl.value.scrollTop = saved.scrollTop;
  }
}

function onCanvasScroll(): void {
  if (scrollFlushTimer) clearTimeout(scrollFlushTimer);
  scrollFlushTimer = setTimeout(() => {
    if (!canvasEl.value) return;
    persistCanvasScrollPosition({
      scrollLeft: canvasEl.value.scrollLeft,
      scrollTop: canvasEl.value.scrollTop,
    });
  }, SCROLL_PERSIST_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------------------------
// Second, independent drag-to-resize splitter (Editor | Conversation sidebar), one level down
// from App.vue's own Preview|Canvas splitter (`editorPreviewResize` there) — mirrors that one's
// naming/clamp/persistence conventions (a fraction of the container's own measured width,
// drag-clamped to `MIN_PANE_FRACTION`, persisted per-viewer via panePersistence.ts) but is
// entirely local to this component: its own ref, its own localStorage key
// (`loadEditorSplit`/`persistEditorSplit`), and its own `useResizeHandle` instance — dragging this
// handle never touches `previewFr`/`canvasFr` (App.vue's `.panes` grid) and vice versa. Just this
// one clamp constant is duplicated locally rather than shared/extracted — `useResizeHandle`
// already factors out the actual drag/keyboard mechanics both splitters reuse, and a single
// `const` isn't worth a shared composable on its own.
//
// Unlike Preview|Canvas (a CSS Grid `fr` split, computed natively by the grid algorithm),
// `.editor-pane`/`.thread-columns` are flex children — `editorFraction` here is rendered as an
// explicit CSS `width` percentage of `.canvas-content`'s own box (see the template), with
// `.thread-columns` keeping its pre-existing `min-width: threadColumnsWidth` floor (FR-006: the
// scroll extent needed to reach the deepest branch column) untouched, so this splitter can never
// crush it below whatever that already-required minimum is — the browser enforces `min-width` as
// an absolute floor over a smaller `width` regardless of this splitter's own clamp.
const MIN_PANE_FRACTION = 0.3; // mirrors App.vue's own Preview|Canvas splitter clamp
const DEFAULT_EDITOR_FRACTION = 0.6;
const EDITOR_THREAD_HANDLE_SPACE_PX = 6; // one 6px handle between the editor and the sidebar

const editorFraction = ref(loadEditorSplit(DEFAULT_EDITOR_FRACTION));

function persistCurrentEditorSplit(): void {
  persistEditorSplit(editorFraction.value);
}

// Slide-transition support (Editor visibility toggle — see the `<Transition name="editor-slide">`
// wrapping `<EditorComponent>` and `.thread-columns`' own inline `transition` below): tracks
// whether the Editor|sidebar splitter itself is being dragged, so `.thread-columns`' width
// transition can be suppressed for the drag's own live, pointer-1:1 width changes — only an
// `editorVisible` toggle should ever animate. (`.editor-pane`'s own width transition doesn't need
// this guard: it's scoped to the Vue `<Transition>`'s enter/leave-active classes below, which only
// ever apply while `editorVisible` itself is changing — a drag never touches that prop, so it
// never enters/leaves the Transition in the first place.)
const editorSplitDragging = ref(false);

// `containerEl: canvasEl` — `.document-canvas`, not `.canvas-content` — deliberately: it's the
// actual scrolling *viewport* (a stable width even while `.thread-columns` pushes `.canvas-content`
// wider than it, per FR-006's horizontal-pan case), exactly the same "measure the visible
// container, not the content" choice App.vue's `editorPreviewResize` makes against `.panes`.
const editorThreadResize = useResizeHandle({
  axis: 'horizontal',
  containerEl: canvasEl,
  beginGesture: (containerRect) => {
    // Same approximation App.vue's own `editorPreviewResize` makes: `MIN_PANE_FRACTION` is a
    // fraction of the container's *total* width (handle included) per the spec, while the editor's
    // own px math is computed over `remainingPx` (handle excluded) — the two are close enough (the
    // handle is `EDITOR_THREAD_HANDLE_SPACE_PX`, a few px) that this distinction rarely matters.
    const remainingPx = containerRect.width - EDITOR_THREAD_HANDLE_SPACE_PX;
    const startEditorPx = remainingPx * editorFraction.value;
    const minPx = containerRect.width * MIN_PANE_FRACTION;
    return (deltaPx) => {
      const nextEditorPx = clamp(
        startEditorPx + deltaPx,
        minPx,
        Math.max(minPx, remainingPx - minPx),
      );
      editorFraction.value = nextEditorPx / remainingPx;
    };
  },
  onSettle: () => {
    persistCurrentEditorSplit();
    editorSplitDragging.value = false;
  },
});

/** Wraps `editorThreadResize.startDrag` only to flag the drag's own duration
 *  (`editorSplitDragging`, reset by `onSettle` above) so `.thread-columns`' width transition never
 *  applies to this splitter's live pointer-driven width changes — see that ref's own doc comment. */
function onEditorHandlePointerDown(event: PointerEvent): void {
  editorSplitDragging.value = true;
  editorThreadResize.startDrag(event);
}

function heightOf(conversationId: string): number {
  return boxHeights.value.get(conversationId) ?? ESTIMATED_BOX_HEIGHT_PX;
}

// Resolving each conversation's anchored *root* and, if that root has a `seedSelection`, calling
// into CodeMirror (`EditorComponent.vue`'s `anchorTop`: `view.coordsAtPos` +
// `paneRef.getBoundingClientRect()`) both force a synchronous browser layout. `layoutEntries` below
// necessarily depends on `boxHeights.value` (the sibling-collision stacking math needs real box
// heights), so without caching, *any single* conversation's box resizing — which happens
// independently, per box, as each one's content mounts/loads — would invalidate the whole computed
// and rerun this CodeMirror measurement for *every* conversation, not just the one whose height
// actually changed. At N conversations with boxes reporting real heights in a staggered burst (the
// normal case), that's O(N) full-sweep re-measurements, each itself O(N).
//
// anchorY only actually depends on the resolved root's identity/seedSelection and the editor
// instance — never on any box's height — so it's safe (and produces byte-identical positions) to
// memoize per conversation id and only redo the expensive CodeMirror measurement when one of those
// actually-relevant inputs has changed. The store replaces a conversation's own object only on a
// genuine conversation-level update (branch created, status change, etc. — never on a
// message/box-height change, which lives in a separate `messagesByConversation` map), so this
// cache stays valid across boxHeights churn while still picking up any real anchor-affecting change
// immediately.
const anchorYCache = new Map<
  string,
  { root: ConversationLayoutInput; editor: AnchorPositionSource | null; y: number }
>();

function cachedAnchorYOf(
  conversation: ConversationLayoutInput,
  byId: ReadonlyMap<string, ConversationLayoutInput>,
  editor: AnchorPositionSource | null,
): number {
  const root = resolveAnchorRoot(conversation, byId);
  const cached = anchorYCache.get(conversation.id);
  if (cached && cached.root === root && cached.editor === editor) return cached.y;
  const y = computeAnchorY(root.seedSelection, editor);
  anchorYCache.set(conversation.id, { root, editor, y });
  return y;
}

// US2/T023: only conversations present in this array get laid out — a closed-and-filtered-out or
// hidden conversation (Phase 6/US4's `HudPanel` "Active only" filter, not yet reintroduced) simply
// isn't in the array on a later recompute, and `computeConversationLayout` naturally closes the gap
// it would have left. No separate "removed" event or reflow trigger is needed — see
// `conversationLayout.ts`'s own doc comment for the full reasoning. Filtering by visibility is the
// entire integration point a future phase needs.
const layoutEntries = computed(() => {
  void editorReady.value; // see onEditorRef above
  void boxHeights.value; // recompute whenever any box's measured height changes
  const conversations: ConversationLayoutInput[] =
    props.filter === 'active'
      ? conversationsStore.conversations.filter((c) => c.status !== 'closed')
      : conversationsStore.conversations;
  // `byId` must still resolve ancestors outside the filtered set (a highlight-anchored root that
  // itself got filtered out shouldn't strand its still-visible branches with no anchor to inherit
  // from), so it's built from the *full* store list, not the filtered `conversations` above.
  const byId = new Map(conversationsStore.conversations.map((c) => [c.id, c]));
  // Housekeeping only (no effect on the numbers computed below): drop cache entries for
  // conversations no longer in the store at all, so a long session that creates/closes many
  // conversations over time doesn't leak one `anchorYCache` entry per conversation ever seen.
  for (const id of anchorYCache.keys()) if (!byId.has(id)) anchorYCache.delete(id);
  return computeConversationLayout(conversations, {
    anchorYOf: (c) => cachedAnchorYOf(c, byId, editorRef.value),
    heightOf,
    minGap: MIN_STACK_GAP_PX,
  });
});

const columns = computed(() => {
  const byColumn = new Map<number, typeof layoutEntries.value>();
  for (const entry of layoutEntries.value) {
    const list = byColumn.get(entry.column);
    if (list) list.push(entry);
    else byColumn.set(entry.column, [entry]);
  }
  return [...byColumn.entries()].sort(([a], [b]) => a - b);
});

// `.thread-column` is `position: absolute` (so a box can sit anywhere vertically within it without
// disturbing its siblings' layout), which means its children contribute nothing to
// `.thread-columns`' own intrinsic width — so that width has to be computed explicitly from the
// deepest column actually present, or the canvas would never grow its horizontal scroll extent to
// reach a further-out branch column (FR-006, quickstart.md Scenario 6's horizontal-pan case).
const threadColumnsWidth = computed(() => {
  const maxColumn = columns.value.reduce((max, [column]) => Math.max(max, column), 0);
  return (maxColumn + 1) * COLUMN_WIDTH_PX;
});
// Bug-fix (editor-vs-canvas scope fix): the template only uses this exact `${threadColumnsWidth}px`
// value while `editorVisible` is true (`.editor-pane`, `flex: 1 1 0`, is still in the flex row and
// competing for space) — once the editor is hidden, `v-show`'s `display: none` drops it out of
// `.canvas-content`'s flex layout entirely (same rule as a grid item — see `panesStyle`'s doc
// comment in App.vue), so `.thread-columns` becomes the row's only flex item and is given
// `width: 100%` instead, letting it (and its `.canvas-content` row) expand to fill the space the
// editor used to occupy rather than leaving it as dead space. `min-width` stays pinned to this
// computed value either way, so the horizontal scroll extent needed to reach the deepest branch
// column (FR-006) is never lost.

// A lightweight visual connector between a branch and the conversation it was branched from, drawn
// on the canvas alongside the existing column layout — nothing here changes
// `computeConversationLayout`'s own math, this only reads its output (`layoutEntries`) plus each
// conversation's already-loaded `parentId`.
//
// Scope note (checked against conversation-service.ts/`app/shared/src/domain/index.ts` before
// implementing): this domain model has no message-level fork-point field. `ConversationDto.parentId`
// links two *conversations*; the only anchor a branch can carry at all is `seedSelection`
// (`{ from, to, text }`), a **document character range**, never a specific transcript message id —
// and "Branch this conversation" (`ConversationThreadBox.vue`'s Branch button) creates a branch
// with no selection whatsoever. So this connector's two endpoints are each conversation's *box*
// (there is no finer-grained "which message did this fork at" to draw toward), not a specific
// `MessageBubble`.
const BOX_WIDTH_PX = 320; // ConversationThreadBox's own fixed width
const COLUMN_PADDING_PX = 12; // `.thread-column`'s `padding: 0 12px`

interface BranchConnector {
  id: string;
  d: string;
}

const connectors = computed<BranchConnector[]>(() => {
  const entryById = new Map(layoutEntries.value.map((e) => [e.id, e]));
  const conversationById = new Map(conversationsStore.conversations.map((c) => [c.id, c]));
  const result: BranchConnector[] = [];
  for (const entry of layoutEntries.value) {
    const parentId = conversationById.get(entry.id)?.parentId ?? null;
    if (!parentId) continue;
    const parentEntry = entryById.get(parentId);
    // Parent may be filtered out (e.g. "Active only") or not yet laid out — nothing to draw toward.
    if (!parentEntry) continue;

    const childLeftX = entry.column * COLUMN_WIDTH_PX + COLUMN_PADDING_PX;
    const parentLeftX = parentEntry.column * COLUMN_WIDTH_PX + COLUMN_PADDING_PX;

    if (entry.column === parentEntry.column) {
      // Main and a direct highlight-anchored branch of Main share one column (columnOf's own doc
      // comment) — draw a straight vertical "trunk" line from the parent box's bottom edge down to
      // the child box's top edge instead of a left/right connector that would have nowhere to go.
      const x = parentLeftX + BOX_WIDTH_PX / 2;
      const y1 = parentEntry.top + heightOf(parentEntry.id);
      const y2 = Math.max(entry.top, y1);
      result.push({ id: entry.id, d: `M ${x} ${y1} L ${x} ${y2}` });
    } else {
      // One column further out (the common case): a smooth elbow from the parent's right edge to
      // the child's left edge, each at their own box's vertical center.
      const parentRightX = parentLeftX + BOX_WIDTH_PX;
      const y1 = parentEntry.top + heightOf(parentEntry.id) / 2;
      const y2 = entry.top + heightOf(entry.id) / 2;
      const midX = (parentRightX + childLeftX) / 2;
      result.push({
        id: entry.id,
        d: `M ${parentRightX} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${childLeftX} ${y2}`,
      });
    }
  }
  return result;
});

// `.thread-columns` only ever sets an explicit *width* (see `threadColumnsWidth` above — absolutely
// positioned children contribute nothing to a parent's intrinsic size); the connector SVG below
// needs an explicit height for the same reason, sized to the deepest stacked box actually present.
const threadColumnsHeight = computed(() =>
  layoutEntries.value.reduce((max, e) => Math.max(max, e.top + heightOf(e.id)), 0),
);

// Synchronized scrolling (App.vue's "Sync scroll" toggle, composables/scrollSync.ts): App.vue
// wires this canvas's own native scroll container (`canvasEl` — the same element T034's
// scroll-position persistence above already reads/writes) together with PreviewComponent.vue's,
// via `attachScrollSync`. Exposed as a getter so every read returns the live element, including
// across this component's own mount/unmount (`canvasEl` starts null until `onCanvasRootRef` runs).
defineExpose({
  get scrollEl(): HTMLElement | null {
    return canvasEl.value;
  },
});
</script>

<template>
  <div :ref="onCanvasRootRef" class="document-canvas" tabindex="0" @scroll="onCanvasScroll">
    <div class="canvas-content">
      <!-- Slide transition (hide/show toggle only — see the `:deep(.editor-slide-*)` rules in
           <style> below): wrapping the `v-show`-toggled `EditorComponent` in a Vue `<Transition>`
           defers `display: none` until the leave animation finishes (and restores `display` up
           front, before the reverse transition starts, on enter), so this reads as `.editor-pane`
           sliding its width to/from zero rather than instantly vanishing/popping in. -->
      <Transition name="editor-slide">
        <EditorComponent
          v-show="editorVisible"
          :ref="onEditorRef"
          :model-value="modelValue"
          :focused-conversation-ids="focusedConversationIds"
          :max-focused-conversations="maxFocusedConversations"
          :style="{ flex: '0 0 auto', width: `${editorFraction * 100}%` }"
          @change="emit('change', $event)"
          @branch-from-selection="
            (range, includeSeedMessage) => emit('branch-from-selection', range, includeSeedMessage)
          "
        />
      </Transition>
      <!-- Editor|Conversation-sidebar resize handle: independent of App.vue's own Preview|Canvas
           handle (different container, different persisted fraction — see `editorThreadResize`
           above). Only rendered while the editor is actually visible — with nothing on its left to
           resize against once `editorVisible` is false, there's nothing for it to do (`.thread-
           columns` already expands to fill the freed width on its own, unconditionally). -->
      <div
        v-if="editorVisible"
        class="resize-handle resize-handle--horizontal editor-thread-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Editor and conversation sidebar panes"
        :aria-valuenow="Math.round(editorFraction * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
        tabindex="0"
        @pointerdown="onEditorHandlePointerDown($event)"
        @keydown="editorThreadResize.onKeydown($event)"
      />
      <div
        class="thread-columns"
        :style="{
          width: editorVisible ? `${(1 - editorFraction) * 100}%` : '100%',
          minWidth: `${threadColumnsWidth}px`,
          // Slide transition (Editor hide/show toggle, kept in sync with `.editor-pane`'s own
          // Transition above): a plain inline `transition: width` rather than a Vue `<Transition>`
          // — `.thread-columns` never toggles v-show/v-if, it just reactively resizes — suppressed
          // to `none` while the Editor|sidebar splitter itself is being dragged
          // (`editorSplitDragging`), same reasoning as App.vue's own
          // `previewSplitDragging`/`panesStyle`. `prefers-reduced-motion: reduce` is handled in
          // <style> below (a `!important` media-query override, since it must win over this inline
          // value).
          transition: editorSplitDragging ? 'none' : 'width 220ms ease',
        }"
      >
        <!-- Branch-lineage connectors: drawn once, behind every `.thread-column` (source order,
             no z-index needed), spanning the full laid-out canvas area so a connector can run
             between any two columns regardless of which one is on top. -->
        <svg
          v-if="connectors.length"
          class="branch-connectors"
          aria-hidden="true"
          :width="threadColumnsWidth"
          :height="threadColumnsHeight"
        >
          <path
            v-for="connector in connectors"
            :key="connector.id"
            :d="connector.d"
            class="branch-connector-path"
          />
        </svg>
        <div
          v-for="[column, entries] in columns"
          :key="column"
          class="thread-column"
          :data-column="column"
          :style="{ left: `${column * COLUMN_WIDTH_PX}px` }"
        >
          <ConversationThreadBox
            v-for="entry in entries"
            :key="entry.id"
            :ref="
              (instance) => registerBoxEl(entry.id, instance as { el: HTMLElement | null } | null)
            "
            :conversation-id="entry.id"
            :is-focused="focusedConversationIds.has(entry.id)"
            :focus-disabled="
              !focusedConversationIds.has(entry.id) &&
              focusedConversationIds.size >= maxFocusedConversations
            "
            :at-focus-cap="focusedConversationIds.size >= maxFocusedConversations"
            :max-focused="maxFocusedConversations"
            :style="{ top: `${entry.top}px` }"
            @toggle-focus="emit('toggle-focus', $event)"
            @branch-created="emit('branch-created', $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* research.md §1: plain native scroll, no custom viewport/zoom composable — a focusable
   scrollable container gets keyboard panning (arrow keys/Page Up/Down) for free. */
.document-canvas {
  height: 100%;
  min-height: 0;
  overflow: auto;
  /* Defense-in-depth: reserves the scrollbar's width up front so its appearance/disappearance
     (e.g. vertical scroll extent changing as CodeMirror mounts/unmounts virtualized lines) can't
     itself shift `.canvas-content`'s available width. A cheap guard alongside `.editor-pane`'s own
     flex-basis handling (EditorComponent.vue) — not confirmed as necessary on its own. */
  scrollbar-gutter: stable;
  background: var(--panel-bg-alt, #eef0f3);
}
.canvas-content {
  position: relative;
  display: flex;
  align-items: flex-start;
  min-height: 100%;
  background: var(--panel-bg, #f7f7f8);
}
/* US2: one absolutely-positioned column per branch depth actually in use (T021), offset
   horizontally by `column * COLUMN_WIDTH_PX` via each column's own `left`. `.thread-columns`' own
   width is set explicitly (inline style, see `threadColumnsWidth`) from the deepest column actually
   present, since absolutely-positioned children contribute nothing to a parent's intrinsic width —
   without that, the canvas would never grow its horizontal scroll extent to reach a further-out
   branch column (FR-006, quickstart.md Scenario 6). */
.thread-columns {
  position: relative;
  flex: 0 0 auto;
  min-height: 100%;
}
.thread-column {
  position: absolute;
  top: 0;
  width: 350px; /* mirrors COLUMN_WIDTH_PX in the script (the horizontal column pitch/gap) */
  padding: 0 12px;
}
/* Editor|Conversation-sidebar resize handle: same look/feel/cursor convention as App.vue's own
   Preview|Canvas `.resize-handle`/`.resize-handle--horizontal` (duplicated here since `<style
   scoped>` doesn't cross component boundaries) — a vertical dividing line dragged left/right.
   `.editor-thread-handle` adds this component's own layout specifics: a fixed 6px flex-basis
   (`EDITOR_THREAD_HANDLE_SPACE_PX` in the script) and `align-self: stretch` so it spans the full
   height of whichever sibling pane (`.editor-pane`/`.thread-columns`) is currently tallest, rather
   than collapsing to zero height (its own default flex-start alignment) since it has no content of
   its own. */
.resize-handle {
  position: relative;
  touch-action: none;
  background: transparent;
}
.resize-handle--horizontal {
  cursor: col-resize;
}
.resize-handle--horizontal::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--border-color, #ccc);
}
.resize-handle--horizontal:hover::after,
.resize-handle--horizontal:focus-visible::after {
  background: var(--accent-color, #2563eb);
  width: 4px;
}
.resize-handle:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: -2px;
}
.editor-thread-handle {
  flex: 0 0 6px; /* mirrors EDITOR_THREAD_HANDLE_SPACE_PX in the script */
  align-self: stretch;
}
/* Slide transition (Editor hide/show toggle — see `<Transition name="editor-slide">` wrapping
   `EditorComponent` in the template above): scoped to the Vue-generated `-active`/`-from`/`-to`
   phase classes only — never a permanent `transition`/forced `width` on `.editor-pane` itself
   (EditorComponent.vue's own root) — so this can never fire for an ordinary reactive width change,
   in particular the Editor|sidebar splitter drag, which stays 1:1 with pointer movement and never
   touches `editorVisible` in the first place (so it never enters/leaves this Transition at all).
   `:deep()` is required since these Vue-generated classes land on `EditorComponent`'s own root
   element, a different component's scoped context. `overflow: hidden` is scoped the same way, only
   clipping the pane's content while it's actually animating past its normal bounds. The forced
   `width: 0% !important` on `-from`/`-to` is needed to win over `.editor-pane`'s own
   higher-specificity inline `width` (its current split fraction, unchanged by this transition). */
:deep(.editor-slide-enter-active),
:deep(.editor-slide-leave-active) {
  transition: width 220ms ease;
  overflow: hidden;
}
:deep(.editor-slide-enter-from),
:deep(.editor-slide-leave-to) {
  width: 0% !important;
}
@media (prefers-reduced-motion: reduce) {
  :deep(.editor-slide-enter-active),
  :deep(.editor-slide-leave-active) {
    transition: none !important;
  }
  .thread-columns {
    transition: none !important;
  }
}
/* Branch-lineage connectors (coordinator follow-up): decorative only — never intercepts clicks —
   and rendered before every `.thread-column` in source order so it always paints behind the boxes
   themselves without needing an explicit z-index. */
.branch-connectors {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  overflow: visible;
}
.branch-connector-path {
  fill: none;
  stroke: var(--neutral-muted-color, #9ca3af);
  stroke-width: 1.5px;
  stroke-dasharray: 4 3;
}
</style>
