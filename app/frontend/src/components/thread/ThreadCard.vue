<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { useThreadSegments } from '../../composables/useThreadSegments.js';
import { ApiError } from '../../transport/http-client.js';
import type { ActionDescriptor } from '../../composables/conversationActions.js';
import ConversationActionButtons from '../conversation/ConversationActionButtons.vue';
import MessageBubble from '../conversation/MessageBubble.vue';
import ThreadComposer from './ThreadComposer.vue';
import HighlightBranchMenu from './HighlightBranchMenu.vue';

/**
 * 011-linear-thread-mode: renders one Thread as one or more stacked, read-only
 * "segment" boxes (`useThreadSegments.ts`), each split at a point some other Thread branched from
 * (FR-005b). Recursive: whenever a segment has active child branches, this mounts one nested
 * `ThreadCard` per child — since there is exactly one root Thread per document (FR-003), the whole
 * document's Thread tree renders from a single top-level `ThreadModeView.vue` invocation of this
 * component. Only the final segment of a Thread (`isTipSegment`) ever mounts `ThreadComposer`
 * (FR-005c); every earlier segment offers only highlight-to-branch (`HighlightBranchMenu`).
 *
 * Layout (root template element is `.thread-node`, a flex ROW, not the bordered box itself): a
 * branch is a tree SIBLING of the segment it forked from, never a box nested inside its parent's
 * own border — so this thread's own bordered box (`.thread-card`, holding just this Thread's own
 * header + segments) and its branch children (`.thread-branches`, one column further right, one
 * `.thread-branch-group` per segment that has any, each holding one `.thread-branch-fork` — and so
 * one recursively-nested `.thread-node` — per active child) are flex-row SIBLINGS of each other,
 * connected by a `.thread-branch-fork::before`/`::after` line+arrowhead rather than one being
 * nested inside the other's padding. Recursion still grows the DOM to the right (a branch's own
 * branches render inside ITS `.thread-branches`, one more flex row deep), it just no longer grows
 * the visual border nesting.
 */
const props = withDefaults(
  defineProps<{
    threadId: string;
    depth?: number;
    /** 011-linear-thread-mode: Thread mode's own HUD cursor (`threadFocusState.ts`'s
     *  `activeThreadId`), threaded down through every recursive `ThreadCard` the same way `depth`
     *  already is, so whichever card matches gets the `.thread-card--active` highlight — see this
     *  file's own template for where. `null`/`undefined` (no active selection yet) highlights
     *  nothing. */
    activeThreadId?: string | null;
  }>(),
  { depth: 0, activeThreadId: null },
);

const store = useThreadStore();

const thread = computed(() => store.findThread(props.threadId));
const messages = computed(() => store.messagesFor(props.threadId));

onMounted(() => {
  if (!store.messagesByThread[props.threadId]) {
    void store.loadDetail(props.threadId);
  }
});

// Same shared, `localStorage`-backed expand/collapse wiring as canvas mode's own
// `ConversationView.vue`/`ConversationThreadBox.vue` — see `stores/thread.ts`'s
// `ensureMessageExpandedSeeded`/`setMessageExpanded` doc comments. Without this, `MessageBubble`
// was rendered with a hardcoded `:expanded="true"` and no `@update:expanded` listener, so its
// "Show more"/"Show less" toggle button rendered but every click emitted into the void.
const expandedByMessage = computed(() => store.expandedByMessage[props.threadId] ?? {});
watch(messages, () => store.ensureMessageExpandedSeeded(props.threadId), { immediate: true });

function setMessageExpanded(messageId: string, expanded: boolean): void {
  store.setMessageExpanded(props.threadId, messageId, expanded);
}

// Every OTHER Thread's fork anchor is what splits THIS Thread's own rendering into segments — see
// `useThreadSegments.ts`'s own doc comment. Recomputed from the whole (reactive) `store.threads`
// list, so a branch created anywhere in the document updates every affected ThreadCard's segments
// live, with no manual invalidation.
const siblingAnchors = computed(() =>
  store.threads.map((t) => ({ id: t.id, forkedFromMessageId: t.forkedFromMessageId })),
);
const segments = computed(() =>
  useThreadSegments(props.threadId, messages.value, siblingAnchors.value),
);

/** FR-008: a done branch still causes its parent to split (the split reflects real,
 *  permanent Pi-branch structure — Edge Cases: branching from a done thread still succeeds), but a
 *  done branch itself is only ever reachable via `DoneThreadsPanel.vue`, never rendered inline
 *  here. */
function activeChildIds(childBranchIds: readonly string[]): string[] {
  return childBranchIds.filter((id) => store.findThread(id)?.doneAt === null);
}

/** Only segments with at least one active child branch render a `.thread-branch-group` at all —
 *  see the layout doc comment above: branches render in their own `.thread-branches` column,
 *  sibling to (not nested inside) `.thread-card`, one group per source segment, in the same
 *  top-to-bottom order as the segments themselves so each group still reads as roughly across from
 *  the segment it forked from. */
const branchSegments = computed(() =>
  segments.value.filter((s) => activeChildIds(s.childBranchIds).length > 0),
);

const tipMessageId = computed(() => messages.value.at(-1)?.id ?? null);

/** The branch's very first message is the auto-delivered `<branch-seed-excerpt>`-wrapped
 *  seed (`ConversationService.sendBranchSeedMessage`, `isSeed: true`) — `thread.seedExcerptText`
 *  (populated only for `kind: 'thread-branch'`) is this store's authoritative signal for exactly
 *  which message that is, so this needs no text-prefix heuristic the way canvas mode's own
 *  `ConversationView.vue` does. Reuses `MessageBubble.vue`'s existing `seed` prop (the same
 *  quote-style "Context" card canvas mode's own seed messages already render with) rather than
 *  reimplementing a banner. */
function isSeedMessage(index: number): boolean {
  return (
    index === 0 && thread.value?.kind === 'thread-branch' && thread.value?.seedExcerptText != null
  );
}

/** The id of this Thread's own seed message (`isSeedMessage(0)`'s target), or `null` for a root
 *  Thread (which has none). Highlighting a passage *within* the very excerpt that already seeded
 *  this branch to spin off another branch, or to quote it right back into this same Thread's own
 *  composer, doesn't make sense either way — both actions read on the ANCHOR passage's own prior
 *  content, and the seed message's whole content already *is* that anchor passage, just wrapped in
 *  `<branch-seed-excerpt>`. Deliberately blanket, not tip-relative: even the edge case where the
 *  seed is *also* still this Thread's current tip (no reply sent yet) must not offer "Quote from
 *  here" either, so this is checked ahead of (not folded into) the tip/earlier-message split below. */
const seedMessageId = computed(() => {
  const first = messages.value[0];
  return first && isSeedMessage(0) ? first.id : null;
});

// ---------------------------------------------------------------------------------------------
// Highlight-to-branch (FR-005/FR-005a) and "Quote from here". Both start from the same captured
// selection; which action(s) apply is decided purely by whether the selection's message is the
// Thread's actual current tip MESSAGE (`tipMessageId`, not the whole tip segment):
//  - Branch from here: only an EARLIER message — matching FR-007's literal "N-1, N-2, or any
//    earlier message are all valid" (an earlier message inside the still-open tip segment is a
//    perfectly valid anchor) and the backend's own `ANCHOR_IS_TIP` check, keyed on the exact
//    message id, not the segment.
//  - Quote from here: only the tip message itself — it seeds this same Thread's own next composer
//    message (`store.quoteHighlightIntoComposer`), so "the latest message" is the only sensible
//    scope; it never creates a branch.
// Both are further excluded outright for this Thread's own seed message (`seedMessageId` above) —
// a branch thread's first message is never a valid anchor for either action, regardless of whether
// it also happens to be the tip.
// ---------------------------------------------------------------------------------------------
interface PendingSelection {
  messageId: string;
  text: string;
  x: number;
  y: number;
}
const selection = ref<PendingSelection | null>(null);
const branching = ref(false);
const branchError = ref<string | null>(null);
const composerRef = ref<InstanceType<typeof ThreadComposer> | null>(null);

function onMessageMouseUp(messageId: string): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  // A selection inside this Thread's own seed message never has anything to offer (neither
  // action ever applies — see `seedMessageId`'s own doc comment) — skip showing the popover at
  // all rather than mounting `HighlightBranchMenu` just for it to render zero buttons.
  if (!text || sel!.rangeCount === 0 || messageId === seedMessageId.value) {
    selection.value = null;
    return;
  }
  const rect = sel!.getRangeAt(0).getBoundingClientRect();
  selection.value = { messageId, text, x: rect.left + rect.width / 2, y: rect.top };
}

const canBranchFromSelection = computed(
  () =>
    selection.value != null &&
    selection.value.messageId !== tipMessageId.value &&
    selection.value.messageId !== seedMessageId.value,
);
const canQuoteFromSelection = computed(
  () =>
    selection.value != null &&
    selection.value.messageId === tipMessageId.value &&
    selection.value.messageId !== seedMessageId.value,
);

function dismissSelection(): void {
  selection.value = null;
}

async function onBranchFromSelection(): Promise<void> {
  if (!selection.value || !canBranchFromSelection.value || thread.value?.status === 'closed') {
    return;
  }
  branching.value = true;
  branchError.value = null;
  try {
    const created = await store.branch(props.threadId, {
      anchorMessageId: selection.value.messageId,
      highlightedText: selection.value.text,
    });
    selection.value = null;
    window.getSelection()?.removeAllRanges();
    await store.loadDetail(created.id);
  } catch (err) {
    branchError.value = err instanceof ApiError ? err.message : 'Failed to create branch.';
  } finally {
    branching.value = false;
  }
}

/** Synchronous, purely local — no request round-trip, so no `pending`/error state to manage the
 *  way `onBranchFromSelection` needs. Guarded on `doneAt` (not `status === 'closed'`, which a
 *  Thread never actually reaches) since that's the real signal `ThreadComposer.vue` already
 *  disables itself on. */
function onQuoteFromSelection(): void {
  if (!selection.value || !canQuoteFromSelection.value || thread.value?.doneAt !== null) return;
  store.quoteHighlightIntoComposer(props.threadId, selection.value.text);
  selection.value = null;
  window.getSelection()?.removeAllRanges();
  void nextTick(() => composerRef.value?.focus());
}

// ---------------------------------------------------------------------------------------------
// Mark done / reopen (FR-008/FR-009/FR-010). `PENDING_EDITS_BLOCK_DONE` is surfaced inline
// the same way canvas mode's `ConversationView.vue` surfaces its own `PENDING_EDITS_BLOCK_CLOSE`.
// ---------------------------------------------------------------------------------------------
const doneBusy = ref(false);
const doneError = ref<string | null>(null);

async function onMarkDone(): Promise<void> {
  doneError.value = null;
  doneBusy.value = true;
  try {
    await store.markDone(props.threadId);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PENDING_EDITS_BLOCK_DONE') {
      const ids = err.details?.pendingEditIds;
      doneError.value = Array.isArray(ids)
        ? `Cannot mark done: ${ids.length} pending proposal${ids.length === 1 ? '' : 's'} must be resolved first.`
        : err.message;
    } else {
      doneError.value = err instanceof Error ? err.message : 'Failed to mark thread done.';
    }
  } finally {
    doneBusy.value = false;
  }
}

async function onReopen(): Promise<void> {
  doneError.value = null;
  await store.reopen(props.threadId);
}

// Same `ActionDescriptor` + `ConversationActionButtons.vue` renderer canvas mode's own
// `ConversationThreadBox.vue`/`ConversationView.vue` header actions already use (its own doc
// comment: "consolidated from the near-identical `.thread-action-button` rule ... in both" prior
// hosts) — Mark done/Reopen is this Thread header's exact equivalent of that row's own Close
// action, so it gets the same real button styling (min 24x24px hit area, danger/hover treatment)
// for free instead of a third hand-rolled copy of that CSS.
const doneActions = computed<ActionDescriptor[]>(() => {
  if (thread.value?.doneAt === null) {
    return [
      {
        key: 'mark-done',
        label: 'Mark done',
        disabled: doneBusy.value,
        onClick: () => void onMarkDone(),
      },
    ];
  }
  return [{ key: 'reopen', label: 'Reopen', onClick: () => void onReopen() }];
});

/** This Thread's own "Expand all"/"Collapse all" — the per-branch complement of
 *  `ThreadModeView.vue`'s document-wide toolbar button, scoped to just THIS Thread's own messages
 *  via `stores/thread.ts`'s `anyMessageCollapsedForThread`/`toggleAllMessagesForThread` (built on
 *  the same shared `expandableMessages.ts` primitives the document-wide pair already uses). Kept as
 *  its own `ActionDescriptor` — folded into this header's existing `ConversationActionButtons` row
 *  alongside Mark done/Reopen rather than a separate hand-rolled `<button>` — so it gets the exact
 *  same real-button styling for free, matching every other header action in this row. */
const threadBulkToggleLabel = computed(() =>
  store.anyMessageCollapsedForThread(props.threadId) ? 'Expand all' : 'Collapse all',
);
function onToggleThreadMessages(): void {
  store.toggleAllMessagesForThread(props.threadId);
}
const headerActions = computed<ActionDescriptor[]>(() => [
  {
    key: 'bulk-toggle',
    label: threadBulkToggleLabel.value,
    ariaLabel: `${threadBulkToggleLabel.value} messages in this thread`,
    onClick: onToggleThreadMessages,
  },
  ...doneActions.value,
]);

/** FR-005b's "branch boxes don't need full reading width" (Thread mode layout redesign): every box
 *  at depth 0 (the trunk of whichever tree this is) keeps the original full comfortable reading
 *  width, but a branch box's own width cap shrinks the deeper it nests — a branch is typically a
 *  short, focused side-exchange, not a full transcript, and a tree with 2+ branch levels otherwise
 *  blows well past a typical laptop viewport at a *uniform* 640px per box (the previous behavior,
 *  which left horizontal scrolling as the only mitigation). Concretely (see this component's own
 *  `<style>` doc comment on `.thread-branches`'/`.thread-branch-fork`'s widths for the full budget):
 *  a single depth-1 branch (or several depth-1 siblings, which stack vertically in one column
 *  rather than each costing their own width) adds trunk(640) + connector(28) + branch(420) = 1088px
 *  — comfortably under a 1280–1440px viewport even before `ThreadModeView.vue`'s own container-width
 *  fix. A depth-2 branch-of-a-branch adds another connector(28) + 300px, for 1416px total — still
 *  under ~1440px, though it can start to press a 1280px-wide window; deeper/wider trees than that
 *  fall back to `.thread-mode-list`'s own `overflow-x: auto`, exactly as intended (scroll as a last
 *  resort for genuinely wide/deep trees, not as the routine experience for 1–2 levels). */
const CARD_MAX_WIDTH_PX: Record<number, number> = { 0: 640, 1: 420 };
const DEEPER_CARD_MAX_WIDTH_PX = 300;
const cardStyle = computed(() => ({
  width: `min(${CARD_MAX_WIDTH_PX[props.depth] ?? DEEPER_CARD_MAX_WIDTH_PX}px, calc(100vw - 2.5rem))`,
}));
</script>

<template>
  <div v-if="thread" class="thread-node">
    <article
      class="thread-card"
      :class="{ 'thread-card--active': threadId === activeThreadId }"
      :style="cardStyle"
      :data-thread-id="threadId"
      :data-thread-kind="thread.kind"
    >
      <header class="thread-card-header">
        <span class="thread-card-title text-wrap-safe">{{ thread.name }}</span>
        <span v-if="thread.kind === 'thread-root'" class="thread-root-badge">Root</span>
        <span class="thread-card-actions">
          <ConversationActionButtons :actions="headerActions" />
        </span>
      </header>
      <span v-if="doneError" class="thread-error" role="alert">{{ doneError }}</span>

      <!-- `useThreadSegments` returns no segments at all for a Thread with zero messages yet (a
           freshly created root — thread-branches always get an auto-seeded first message) —
           without this, a brand-new Thread could never render a composer to send its own first
           message. -->
      <ThreadComposer
        v-if="messages.length === 0"
        ref="composerRef"
        :thread-id="threadId"
        :disabled="thread.doneAt !== null"
      />

      <div
        v-for="segment in segments"
        :key="`${segment.startIndex}-${segment.endIndex}`"
        class="thread-segment"
        :class="{ 'is-tip-segment': segment.isTipSegment }"
      >
        <div
          v-for="(message, offset) in messages.slice(segment.startIndex, segment.endIndex + 1)"
          :key="message.id"
          class="thread-segment-message"
          @mouseup="onMessageMouseUp(message.id)"
        >
          <MessageBubble
            :message="message"
            :seed="isSeedMessage(segment.startIndex + offset)"
            :expanded="expandedByMessage[message.id] ?? false"
            @update:expanded="(value) => setMessageExpanded(message.id, value)"
          />
        </div>

        <ThreadComposer
          v-if="segment.isTipSegment"
          ref="composerRef"
          :thread-id="threadId"
          :disabled="thread.doneAt !== null"
        />
      </div>

      <span v-if="branchError" class="thread-error" role="alert">{{ branchError }}</span>
    </article>

    <!-- Branches render as their own sibling column, connected by a line to the segment they
         forked from — never nested inside `.thread-card`'s own border. See the layout doc comment
         at the top of this file. -->
    <div v-if="branchSegments.length > 0" class="thread-branches">
      <div
        v-for="segment in branchSegments"
        :key="`branches-${segment.startIndex}-${segment.endIndex}`"
        class="thread-branch-group"
      >
        <div
          v-for="childId in activeChildIds(segment.childBranchIds)"
          :key="childId"
          class="thread-branch-fork"
        >
          <ThreadCard :thread-id="childId" :depth="depth + 1" :active-thread-id="activeThreadId" />
        </div>
      </div>
    </div>

    <HighlightBranchMenu
      v-if="selection"
      :x="selection.x"
      :y="selection.y"
      :highlighted-text="selection.text"
      :pending="branching"
      :can-branch="canBranchFromSelection"
      :can-quote="canQuoteFromSelection"
      @branch="onBranchFromSelection"
      @quote="onQuoteFromSelection"
      @dismiss="dismissSelection"
    />
  </div>
</template>

<style scoped>
/* The recursive unit: a flex ROW pairing this Thread's own bordered box (`.thread-card`, the
   "trunk") with a further-right column of its branch children (`.thread-branches`), as tree
   siblings rather than one nested inside the other's border — see this file's top-of-script doc
   comment. `align-items: flex-start` (not the flex default `stretch`) is load-bearing: it lets
   `.thread-node` size itself to its own content's natural width (trunk width, plus branch width
   only when branches exist) instead of stretching to fill whatever width its own parent flex
   column (`ThreadModeView.vue`'s `.thread-mode-list`, or a shallower `.thread-branches`) happens to
   have — which is what lets a deep/wide tree grow rightward past that ancestor's own box and get
   picked up by `.thread-mode-list`'s `overflow-x: auto` instead of stretching every ancestor's
   assigned width to match. */
.thread-node {
  display: flex;
  align-items: flex-start;
}
.thread-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 8px;
  background: var(--panel-bg, #f7f7f8);
  /* Thread mode's HUD cursor highlight (011-linear-thread-mode): the active `ThreadCard`, set by
     `ThreadModeView.vue` from `threadFocusState.ts`'s `activeThreadId` (Ctrl+Alt+J/K cycling, or a
     HUD row click). Reuses `--accent-color`, the same token `HudPanel.vue`'s own `.is-focused`
     bottom-border and `.selected` border already key off, so a "this is the current
     selection" cue reads consistently across both HUD surfaces. `box-shadow` (an outer ring, not a
     border swap) so it layers over this card's own `border`/`background` without shifting layout
     or fighting `[data-thread-kind]`-based styling elsewhere. */
  transition: box-shadow 0.15s ease;
  /* Width itself is set inline (`cardStyle`, script above) rather than here — it depends on this
     card's own `depth` prop (trunk vs. branch vs. branch-of-a-branch), which a static class rule
     can't express. A percentage/`100%` cap here would also be indeterminate the same way the old
     comment on this rule explained: `.thread-node`'s own width, and so any percentage ancestor, is
     itself content-driven, not fixed. */
  flex: 0 0 auto;
}
.thread-card.thread-card--active {
  border-color: var(--accent-color, #2563eb);
  box-shadow: 0 0 0 2px var(--accent-color, #2563eb);
}
.thread-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  /* Sticks to the top of this Thread's own scroll context (`ThreadModeView.vue`'s `.thread-mode-view`,
     the page's real scrolling ancestor — see that file's own `.thread-mode-toolbar` doc comment) as
     the reviewer scrolls through THIS card's own messages, exactly the same `position: sticky`
     pattern canvas mode's `ConversationThreadBox.vue` already uses for its own per-conversation
     `.thread-header` (see that rule's doc comment for the full "sticky positions the margin edge,
     not the painted box" rationale this copies: `margin: 0` + padding instead of margin for
     breathing room, `background` matching this card's own `--panel-bg` so scrolling message content
     can't show through underneath). Each `ThreadCard` (root and every branch alike) gets its own
     independent sticky header this way — as one scrolls past a shorter card, the next card's own
     header takes over the sticky slot, the same "stacking sticky headers" behavior a plain vertical
     list of `ConversationThreadBox`es already exhibits, which continues to hold with this layout's
     branches sitting beside their trunk (a row of siblings) rather than only stacked below it. */
  margin: 0;
  padding: 0.15rem 0;
  position: sticky;
  top: 0;
  z-index: var(--z-raised, 1);
  background: var(--panel-bg, #f7f7f8);
}
.thread-card-title {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
}
.thread-root-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: var(--panel-bg-alt, #eef0f3);
  color: var(--neutral-muted-color, #4b5563);
}
.thread-card-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 0.35rem;
}
.thread-error {
  color: var(--danger-color, #b91c1c);
  font-size: 0.75rem;
}
/* FR-005b: a continuation segment stays flush with the segment it continues — no per-segment
   indent here. Only a segment's own child BRANCH forks (`.thread-branch-fork` below) indent. */
.thread-segment {
  display: flex;
  flex-direction: column;
  border-top: 1px dashed var(--border-color, #ccc);
  padding-top: 0.4rem;
}
.thread-segment:first-child {
  border-top: none;
  padding-top: 0;
}
/* FR-005b: the sibling column of branch boxes to the right of `.thread-card` (never nested inside
   it — see this file's top doc comment). One `.thread-branch-group` per source segment that has
   any active children, stacked top-to-bottom in the same order as the segments themselves so a
   group still reads as roughly across from the segment it forked from; `align-items: flex-start`
   for the same fit-content-not-stretch reason as `.thread-node` above. */
.thread-branches {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1.25rem;
  padding-top: 0.25rem;
}
/* Multiple sibling branches forked from the very same segment (FR-005b's "these are siblings of
   each other, not nested") stack vertically within one group, each getting its own connector via
   `.thread-branch-fork` below rather than one shared border wrapping all of them. */
.thread-branch-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
/* Each branch box's own connector line + arrowhead back to the segment it forked from
   (mockup's "───▶"). `padding-left` reserves the room the line/arrowhead draw into, so this
   completely owns its own spacing from `.thread-card`'s right edge — `.thread-node`'s row has no
   extra `gap` of its own (see below), meaning it's this padding alone, not a shared gap, that keeps
   the whole tree's per-branch connector self-contained no matter how many groups/forks stack up.
   Deliberately never needs recalculating when a message's expand/collapse toggle changes some
   box's height: `top`/`left` below are fixed offsets purely relative to THIS `.thread-branch-fork`'s
   own (`position: relative`) box, never a measured coordinate on the trunk or a sibling fork, so
   ordinary reflow already carries this connector to the right place for free — there is no
   JS-computed position to go stale. The one thing standing between a toggle and *smooth* (not
   instant-snap) motion was the toggled box's own height change having no transition —
   `MessageBubble.vue`'s `.message-text`/`.tool-call-body` `transition: max-height` now covers
   that; see its own doc comment. */
.thread-branch-fork {
  position: relative;
  padding-left: 1.75rem;
}
.thread-branch-fork::before {
  content: '';
  position: absolute;
  top: 1.15rem;
  left: 0;
  width: 1.75rem;
  height: 0;
  border-top: 2px solid var(--neutral-muted-color, #4b5563);
}
.thread-branch-fork::after {
  content: '';
  position: absolute;
  top: calc(1.15rem - 5px);
  left: 1.75rem;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-left-color: var(--neutral-muted-color, #4b5563);
  border-right-width: 0;
  transform: translateX(-1px);
}
</style>
