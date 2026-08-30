<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import EditorComponent from '../editor/EditorComponent.vue';
import ConversationThreadBox from '../conversation/ConversationThreadBox.vue';
import { useConversationsStore } from '../../stores/conversations.js';
import type { AnchorPositionSource } from './anchorY.js';
import { computeConversationLayout, resolveBaseAnchorY, type ConversationLayoutInput } from './conversationLayout.js';
import { loadCanvasScrollPosition, persistCanvasScrollPosition } from '../../composables/panePersistence.js';

// 005-canvas-conversation-threads/US4 (T023's handoff, fulfilled here): `filter` is lifted state
// owned by `App.vue` (shared with `HudPanel.vue`'s "Active only"/"All" toggle) rather than local —
// filtering the array that reaches `computeConversationLayout` below is the entire integration
// point Phase 4 left for "reflow up when a conversation leaves view" to fall out for free.
// `focusedConversationIds` (App.vue's `focusedConversationIds`, multi-focus overlay) is threaded
// down so each `ConversationThreadBox` can tell whether *it* is one of the (possibly several)
// conversations currently shown in an open detail panel — its header's "Close" action only renders
// while that's true (see that component's `isFocused` prop doc comment). `maxFocusedConversations`
// (the live, viewport-aware cap) lets each box compute its own Focus-button disabled affordance.
const props = defineProps<{
  modelValue: string;
  filter: 'active' | 'all';
  focusedConversationIds: ReadonlySet<string>;
  maxFocusedConversations: number;
}>();
const emit = defineEmits<{
  (e: 'change', changes: { from: number; to: number; insert: string }[]): void;
  (e: 'branch-from-selection', range: { from: number; to: number }, includeSeedMessage: boolean): void;
  (e: 'toggle-focus', conversationId: string): void;
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
const COLUMN_WIDTH_PX = 340; // ConversationThreadBox is ~320px wide + a visible inter-column gap
const MIN_STACK_GAP_PX = 16; // consistent with the app's existing 1rem-ish spacing scale

const boxHeights = ref(new Map<string, number>());
const observedEls = new Map<string, HTMLElement>();
let resizeObserver: ResizeObserver | null = null;

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
    boxHeights.value.delete(conversationId);
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver((entries) => {
    const next = new Map(boxHeights.value);
    let changed = false;
    for (const entry of entries) {
      const conversationId = (entry.target as HTMLElement).dataset.conversationId;
      if (!conversationId) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (next.get(conversationId) !== height) {
        next.set(conversationId, height);
        changed = true;
      }
    }
    if (changed) boxHeights.value = next;
  });
  for (const el of observedEls.values()) resizeObserver.observe(el);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
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
    persistCanvasScrollPosition({ scrollLeft: canvasEl.value.scrollLeft, scrollTop: canvasEl.value.scrollTop });
  }, SCROLL_PERSIST_DEBOUNCE_MS);
}

function heightOf(conversationId: string): number {
  return boxHeights.value.get(conversationId) ?? ESTIMATED_BOX_HEIGHT_PX;
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
  return computeConversationLayout(conversations, {
    anchorYOf: (c) => resolveBaseAnchorY(c, byId, editorRef.value),
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

// Coordinator follow-up (parent/child branch lineage): a lightweight visual connector between a
// branch and the conversation it was branched from, drawn on the canvas alongside the existing
// column layout — nothing here changes `computeConversationLayout`'s own math, this only reads its
// output (`layoutEntries`) plus each conversation's already-loaded `parentId`.
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
      result.push({ id: entry.id, d: `M ${parentRightX} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${childLeftX} ${y2}` });
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
</script>

<template>
  <div class="document-canvas" tabindex="0" :ref="onCanvasRootRef" @scroll="onCanvasScroll">
    <div class="canvas-content">
      <EditorComponent
        :ref="onEditorRef"
        :model-value="modelValue"
        @change="emit('change', $event)"
        @branch-from-selection="(range, includeSeedMessage) => emit('branch-from-selection', range, includeSeedMessage)"
      />
      <div class="thread-columns" :style="{ width: `${threadColumnsWidth}px`, minWidth: `${threadColumnsWidth}px` }">
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
          <path v-for="connector in connectors" :key="connector.id" :d="connector.d" class="branch-connector-path" />
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
            :ref="(instance) => registerBoxEl(entry.id, instance as { el: HTMLElement | null } | null)"
            :conversation-id="entry.id"
            :is-focused="focusedConversationIds.has(entry.id)"
            :focus-disabled="!focusedConversationIds.has(entry.id) && focusedConversationIds.size >= maxFocusedConversations"
            :max-focused="maxFocusedConversations"
            :style="{ top: `${entry.top}px` }"
            @toggle-focus="emit('toggle-focus', $event)"
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
  width: 340px;
  padding: 0 12px;
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
