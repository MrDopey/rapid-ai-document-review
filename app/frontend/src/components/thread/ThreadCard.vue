<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { useThreadSegments, type ThreadSegment } from '../../composables/useThreadSegments.js';
import { useAgentErrorBanner } from '../../composables/agentErrorBanner.js';
import { useConversationRename } from '../../composables/conversationRename.js';
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
 * Layout (root template element is `.thread-node`, a flex ROW, not a bordered box itself): a Y-split
 * fork design — a branch is a tree SIBLING of the run it forked from, and so is that run's own
 * CONTINUATION (drawn as if symmetric with a real branch, even though it's the same conversation),
 * never one nested inside the other's border. This Thread's own trunk column (`.thread-trunk`, this
 * Thread's sticky header plus a top-to-bottom chain of bordered `.thread-card` "run" boxes — see
 * `runs`' own doc comment below for exactly where a run starts/ends) sits beside its branch children
 * (`.thread-branches`, one column further right, one `.thread-branch-group` per run that forks) as
 * flex-row SIBLINGS. Every fork point (a run with 1+ active children) draws N diverging lines from
 * that run's own bottom edge: one straight down (`.thread-fork-connector`) into this run's own
 * continuation, if any messages follow, plus one fanning out toward its active branch(es).
 *
 * Horizontal-column redesign (Variant A): TWO DIFFERENT AXES both now read left-to-right, but they
 * are visually distinct. (1) SIBLING branches off the exact same fork point lay out as a horizontal
 * ROW of columns (`.thread-branch-row`, one `.thread-branch-column` — or, when there's only one
 * active child, the simpler single-connector `.thread-branch-fork` — per active child), side by
 * side, rather than stacking vertically. A single incoming line from the run-card
 * (`.thread-branch-group--fan::before`) fans out into a horizontal bar that bridges each pair of
 * adjacent columns (`.thread-branch-column::before`, bridging across the row's own `gap`) with a
 * downward drop + arrowhead into each column's own box (`.thread-branch-column::after` +
 * `.thread-branch-fan-arrow`) — this bar is the direct replacement for the old vertical
 * `.thread-branch-spine` that used to chain 2+ *vertically stacked* siblings; a spine bridged top-to-
 * bottom, this bar bridges left-to-right. (2) DEPTH (a branch's own further branches) still grows
 * rightward exactly as before: each column mounts its own recursively-nested `.thread-node`, whose
 * OWN `.thread-branches` sits one flex-row further right than THAT column's own `.thread-trunk` —
 * i.e. depth keeps growing right from wherever a given sibling column itself sits, independent of
 * how many sibling columns share its own fork point. `.thread-branch-row` caps its own rendered
 * width so `MAX_VISIBLE_BRANCH_COLUMNS` siblings fit before `overflow-x: auto` kicks in (script,
 * below) — columns never wrap to a second row.
 *
 * Because `.thread-trunk` and `.thread-branches` are two independently-stacking flex columns, this
 * component also has to keep a `.thread-branch-group` visually level with the run-card it forked
 * from itself — see `syncBranchAlignment` below (bug fix: the connector used to only look aligned by
 * coincidence). That alignment axis (the GROUP's own vertical top vs. the run-card's bottom edge) is
 * orthogonal to the row/column redesign above — a group's internal horizontal layout doesn't move
 * its own top edge, so `syncBranchAlignment` itself needed no changes for this redesign.
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

// Parity fix (011-linear-thread-mode follow-up): the same click-to-edit title affordance canvas
// mode's `ConversationThreadBox.vue`/`ConversationView.vue` already share via
// `useConversationRename` — generalized to accept a narrow `{ find, rename }` source (rather than
// hardcoding `useConversationsStore()`) so this Thread-mode usage can drive `useThreadStore()`
// instead without a second, forked copy of the composable.
const nameInputEl = ref<HTMLInputElement | null>(null);
const {
  isEditingName,
  nameDraft,
  renameError,
  renameSaving,
  startEditingName,
  cancelEditingName,
  saveName,
} = useConversationRename(nameInputEl, {
  find: () => store.findThread(props.threadId),
  rename: (id, name) => store.rename(id, name),
});

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

/** Horizontal-column redesign: precomputes each forking segment's own active-children list ONCE
 *  (rather than the template repeatedly re-deriving it via `activeChildIds` for every class binding
 *  that needs to know "is this a 2+ way fork") plus whether it's a fan (2+ active children — the
 *  only case that gets the horizontal-row/fan-bar treatment; exactly one active child keeps the
 *  simpler single-line `.thread-branch-fork` connector unchanged from before this redesign). See the
 *  template below for `.thread-branch-row`/`.thread-branch-column`/`.thread-branch-fork`. */
const branchGroups = computed(() =>
  branchSegments.value.map((segment) => {
    const children = activeChildIds(segment.childBranchIds);
    return { segment, isFan: children.length > 1, children };
  }),
);

/** Width-cap (Variant A locked-in decision): 2+ active branches off one fork point now lay out as a
 *  horizontal row of columns (`.thread-branch-row`) instead of stacking vertically — this caps that
 *  row's own rendered width so at least this many sibling columns fit before horizontal scrolling
 *  kicks in (`.thread-branch-row`'s own `overflow-x: auto`, CSS below); columns never wrap to a
 *  second row no matter how many siblings share one fork point. Named constant (not a magic number
 *  inline) precisely so this "4" has exactly one place to change. */
const MAX_VISIBLE_BRANCH_COLUMNS = 4;
/** The row's own CSS `gap` between sibling columns, kept as one JS constant (rather than a literal
 *  hand-copied into both this width-cap arithmetic below AND the stylesheet) — threaded into the CSS
 *  via the `--thread-branch-fan-gap` custom property `branchRowStyle` sets inline, which
 *  `.thread-branch-row`'s own `gap` and `.thread-branch-column`'s own fan-bar-bridging `::before`
 *  both read (CSS below). */
const BRANCH_COLUMN_GAP_PX = 32;

/** Every sibling column in one fork point's row renders at the exact same depth (`depth + 1`) — see
 *  `cardStyle` above for the per-depth width lookup this mirrors, so the cap below budgets for the
 *  REAL column width instead of guessing. */
const branchColumnWidthPx = computed(
  () => CARD_MAX_WIDTH_PX[props.depth + 1] ?? DEEPER_CARD_MAX_WIDTH_PX,
);
const branchRowStyle = computed(() => {
  const capPx =
    MAX_VISIBLE_BRANCH_COLUMNS * branchColumnWidthPx.value +
    (MAX_VISIBLE_BRANCH_COLUMNS - 1) * BRANCH_COLUMN_GAP_PX;
  return {
    maxWidth: `min(${capPx}px, calc(100vw - 2.5rem))`,
    '--thread-branch-fan-gap': `${BRANCH_COLUMN_GAP_PX}px`,
  };
});

/** Y-split fork redesign: the trunk visually disconnects at every point it has an active branch,
 *  rather than rendering as one continuous box the whole branch column merely sits beside (the
 *  earlier design this replaces — see the doc comment above `syncBranchAlignment` for the bug that
 *  motivated it). A "run" is a maximal consecutive slice of `segments` ending either at the first
 *  segment with an active child (a fork point) or at the thread's actual tip segment, whichever
 *  comes first — each run renders as its own bordered `.thread-card` box in the template below, so
 *  a fork produces sibling boxes (this run's own continuation, the next run in this array, plus
 *  every active branch off it) instead of the trunk simply continuing through unbroken. No changes
 *  needed to `useThreadSegments.ts` itself for this: a segment whose only child(ren) are done never
 *  ends a run early (this reuses the exact same `activeChildIds` filter as `branchSegments` above),
 *  so a done branch keeps reading as an ordinary mid-run dashed segment break, not a fork — and a
 *  run can legitimately contain more than one `ThreadSegment` when an intermediate segment's only
 *  child was later marked done. */
const runs = computed<ThreadSegment[][]>(() => {
  const result: ThreadSegment[][] = [];
  let current: ThreadSegment[] = [];
  for (const segment of segments.value) {
    current.push(segment);
    if (activeChildIds(segment.childBranchIds).length > 0 || segment.isTipSegment) {
      result.push(current);
      current = [];
    }
  }
  return result;
});

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

// ---------------------------------------------------------------------------------------------
// Parity fix (011-linear-thread-mode follow-up): a Thread's underlying agent turn can fail exactly
// the same way a canvas conversation's can (`thread.status === 'errored'`, now actually reflected
// by `stores/thread.ts`'s `handleServerFrame` — see its own doc comment on the WS events this used
// to silently ignore). Reuses `ConversationView.vue`'s exact Retry/Dismiss banner shape/CSS
// (`agentErrorBanner.ts`, `.error-banner*` hoisted into style.css) rather than inventing a second
// one.
// ---------------------------------------------------------------------------------------------
const { errorDismissed, dismissError } = useAgentErrorBanner(() => thread.value?.status);

async function onRetry(): Promise<void> {
  await store.retry(props.threadId);
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
 *  a single depth-1 branch adds trunk(640) + connector(28) + branch(420) = 1088px — comfortably
 *  under a 1280–1440px viewport even before `ThreadModeView.vue`'s own container-width fix. A
 *  depth-2 branch-of-a-branch adds another connector(28) + 300px, for 1416px total — still under
 *  ~1440px, though it can start to press a 1280px-wide window; deeper/wider trees than that fall back
 *  to `.thread-mode-list`'s own `overflow-x: auto`, exactly as intended (scroll as a last resort for
 *  genuinely wide/deep trees, not as the routine experience for 1–2 levels). 2+ SIBLING branches off
 *  one fork point no longer share this budget for free the way they did when they stacked vertically
 *  — each sibling now costs its own column width in the row (`branchRowStyle`, `.thread-branch-row`
 *  below) — so `MAX_VISIBLE_BRANCH_COLUMNS` (below) is what keeps a wide fan from blowing the layout
 *  budget above, falling back to that same `.thread-branch-row`-local `overflow-x: auto` (not
 *  `.thread-mode-list`'s page-level one) once a fork point has more siblings than fit. */
const CARD_MAX_WIDTH_PX: Record<number, number> = { 0: 640, 1: 420 };
const DEEPER_CARD_MAX_WIDTH_PX = 300;
const cardStyle = computed(() => ({
  width: `min(${CARD_MAX_WIDTH_PX[props.depth] ?? DEEPER_CARD_MAX_WIDTH_PX}px, calc(100vw - 2.5rem))`,
}));

// ---------------------------------------------------------------------------------------------
// Connector alignment (bug fix, then Y-split redesign): `.thread-trunk` (the run-card chain below —
// see `runs` above) and `.thread-branches` (a wholly SEPARATE flex column, sibling to it — see this
// file's top doc comment) have no CSS relationship tying a `.thread-branch-group`'s vertical
// position to the run-card it forked from. Each column simply stacks its own children from the top,
// so a group's natural position depends only on the height of the branch groups *above it in that
// same column* — never on the (unrelated) height of the run-cards above the one it actually points
// at. The two columns' stacking only ever agreed by coincidence (e.g. every earlier segment/group
// happening to be about the same height).
//
// Fixed the same way `DocumentCanvas.vue`'s own `computeConversationLayout` already solves the
// analogous canvas-mode problem (siblings stacking near a target position without overlapping) —
// measure the real boxes and nudge into place — rather than reaching for CSS Grid `subgrid`. This is
// the flow-layout equivalent: a `margin-top` nudge on the group in place of an absolute `top`.
//
// Originally (before the Y-split redesign) this measured a `.thread-segment` div's own bottom edge,
// since every segment shared one continuous `.thread-card` box and only the specific forking
// segment's edge (not the whole card's) was the real target. Now every forking segment gets its OWN
// dedicated run-card (see `runs`/template below), so that run-card's own bottom border edge — the
// real, visible edge a branch's connector should touch — IS the target directly; `runCardEls` below
// tracks that element per forking segment instead of the segment `<div>` itself.
// ---------------------------------------------------------------------------------------------
const trunkRef = ref<HTMLElement | null>(null);
const branchesRef = ref<HTMLElement | null>(null);
const runCardEls = new Map<string, HTMLElement>();
const branchGroupEls = new Map<string, HTMLElement>();
// The nudge (in px) this component itself last applied to each group's `margin-top`, keyed the same
// way as `branchGroupEls` — see `syncBranchAlignment`'s own doc comment for why this is tracked here
// in JS rather than read back off the DOM (`getComputedStyle`) on every pass.
const appliedMargins = new Map<string, number>();

// Bug fix (initial-load animation): a freshly mounted/refreshed page fires the exact same
// `syncBranchAlignment` correction machinery as a live interaction — `onMounted` schedules a pass,
// then messages arriving from `store.loadDetail()` (this card's own or a recursively-mounted
// child's), fonts/images settling, etc. each re-trigger the `ResizeObserver` below — but none of
// that is a "live user-triggered layout change" (an expand/collapse toggle, a new branch appearing
// from a highlight-to-branch action) the way `.thread-branch-group`'s own `transition: margin-top`
// was designed for. Confirmed via Playwright against a real seeded multi-branch document: WITHOUT
// this suppression, initial mount alone produces a visible ~1s cascade of margin-top corrections —
// worse, each one plays out over the transition's own duration, so each corrective write triggers
// another `ResizeObserver` firing mid-transition, re-scheduling yet another correction, which is
// exactly the same restart-the-transition feedback shape `4e30ac0`'s jiggle-loop fix already
// diagnosed (see `syncBranchAlignment`'s own doc comment) — initial mount just has far more genuine
// correction passes to chain through (asynchronous data arriving) than a single settled interaction
// ever does, which is what stretches it out to ~1-2s instead of one quick nudge.
//
// Fixed the same way `App.vue`'s `previewSplitDragging`/`DocumentCanvas.vue`'s
// `editorSplitDragging` already suppress THEIR OWN transitions for a different "not a real user-
// facing animation" span (a live pointer drag, which must track 1:1 with the pointer, never lag
// behind an easing curve): a boolean ref driving the transition inline (`branchGroupStyle` below)
// rather than a static CSS rule, `none` until this component's own alignment activity has gone
// quiet for `ALIGN_SETTLE_QUIET_MS`. Every call to `scheduleAlignSync()` (mount, the segment/expand
// watcher, and the `ResizeObserver`) counts as "activity" and resets the quiet timer — so as long as
// corrections keep genuinely arriving (the initial settle cascade), the transition stays suppressed
// and every write lands instantly with no visible motion; once nothing has requested a new pass for
// `ALIGN_SETTLE_QUIET_MS`, `alignTransitionsReady` flips true PERMANENTLY (never reset back to
// false — this is a one-way "has this card finished its first settle" latch, not a per-interaction
// toggle), so every later live interaction (expand/collapse, a new branch appearing, a window
// resize) gets the real, smooth transition exactly as before. Scoped per `ThreadCard` instance
// (not shared/global) since each recursively-mounted branch mounts — and so settles — on its own
// schedule, independent of its parent/siblings.
const alignTransitionsReady = ref(false);
const ALIGN_SETTLE_QUIET_MS = 200;
let alignSettleTimer: ReturnType<typeof setTimeout> | null = null;
function markAlignActivity(): void {
  // One-way latch: once settled, later activity (a genuine live interaction) must never re-arm
  // suppression — that would silently swallow the very animations this fix is required to preserve.
  if (alignTransitionsReady.value) return;
  if (alignSettleTimer !== null) clearTimeout(alignSettleTimer);
  alignSettleTimer = setTimeout(() => {
    alignSettleTimer = null;
    alignTransitionsReady.value = true;
  }, ALIGN_SETTLE_QUIET_MS);
}
/** Bound onto `.thread-branch-group` (template) in place of a static CSS `transition` rule — see
 *  `alignTransitionsReady`'s own doc comment above for why this needs to be a JS-computed value
 *  rather than a permanent CSS declaration. */
const branchGroupStyle = computed(() => ({
  transition: alignTransitionsReady.value ? 'margin-top 0.1s ease' : 'none',
}));

function segmentKey(segment: Pick<ThreadSegment, 'startIndex' | 'endIndex'>): string {
  return `${segment.startIndex}-${segment.endIndex}`;
}

// jsdom (this component's own test environment — `ThreadCard.spec.ts`) has no
// `requestAnimationFrame` at all, unlike a real browser — same fallback `DocumentCanvas.vue`'s own
// `scheduleFrame`/`cancelScheduledFrame` already uses for the exact same reason.
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 0) as unknown as number;
const cancelScheduledFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (handle) => clearTimeout(handle);

let alignFrame: number | null = null;
function scheduleAlignSync(): void {
  // Every distinct request to realign — mount, the segment/expand watcher, or the `ResizeObserver`
  // — counts as activity, even one that arrives while a frame is already pending (still genuine
  // ongoing churn) — see `markAlignActivity`'s own doc comment above.
  markAlignActivity();
  if (alignFrame !== null) return;
  alignFrame = scheduleFrame(() => {
    alignFrame = null;
    syncBranchAlignment();
  });
}

/** Keyed by the run's own LAST segment (the only one that can be a fork point — see `runs`'
 *  doc comment) so lookups in `syncBranchAlignment` share the exact same key `branchGroupEls`/
 *  `branchSegments` already use. Called once per rendered run-card, regardless of whether that run
 *  actually forks — harmless for a non-forking run (its entry is simply never read, since
 *  `syncBranchAlignment` only ever iterates `branchSegments`). */
function setRunCardEl(run: ThreadSegment[], el: Element | null): void {
  const last = run[run.length - 1];
  if (!last) return;
  const key = segmentKey(last);
  if (el) runCardEls.set(key, el as HTMLElement);
  else runCardEls.delete(key);
  scheduleAlignSync();
}

function setBranchGroupEl(segment: ThreadSegment, el: Element | null): void {
  const key = segmentKey(segment);
  if (el) {
    branchGroupEls.set(key, el as HTMLElement);
  } else {
    branchGroupEls.delete(key);
    // A freshly (re)mounted group (e.g. this segment's last branch went `doneAt`, then a new one
    // was created off it later) starts from a clean, un-nudged `margin-top` — any earlier nudge
    // this component applied belonged to a DOM node that's already gone.
    appliedMargins.delete(key);
  }
  scheduleAlignSync();
}

/** A `.thread-segment` ENDS right at its fork anchor message (`useThreadSegments.ts`), so that
 *  segment's own BOTTOM edge — not its top — is the actual point in the trunk a branch group's
 *  connector should read as pointing at. Walks `branchSegments` top-to-bottom (their real render
 *  order in both columns) nudging each group's `margin-top` by however much farther down its target
 *  sits than where it would otherwise land purely from the height of branch groups above it — never
 *  negative, so a group is never pulled up past its own column's normal flow (and so never overlaps
 *  the group above it): the existing `.thread-branches`/`.thread-branch-group` CSS `gap` already
 *  guarantees that floor for free, exactly like `computeConversationLayout`'s own
 *  `Math.max(base, cursorBottom + minGap)`. */
// Bug fix (jiggle regression from the initial `syncBranchAlignment` above): this used to reset a
// group's `margin-top` to `0px`, measure, then write the real nudge back — three DOM writes per
// pass. Any one of those writes is a genuine change to `.thread-branch-group`'s `margin-top`, which
// (since a flex container's auto height includes its children's margins) changes `.thread-branches`'
// own rendered height — exactly what the `ResizeObserver` below watches for. Worse, `.thread-branch-
// group` has `transition: margin-top`, so writing a *different* value than what's currently applied
// (0px, when a real nudge was already in place) restarts that transition from scratch, which then
// keeps changing `.thread-branches`' height on every single animation frame until the transition
// would otherwise finish — re-firing the `ResizeObserver` every frame, which re-scheduled this exact
// function, which reset-and-restarted the transition again, forever. That perpetual restart-and-
// never-finish is what actually read as a visual jiggle, independent of whether the computed nudge
// itself was even changing.
//
// Fixed by never writing an intermediate value: this recovers the same natural, un-nudged position
// the old reset-to-0 step was after by subtracting the nudge back out arithmetically instead —
// `appliedMargins` (declared above, next to `branchGroupEls`) is this component's own record of
// whatever `margin-top` IT last wrote to each group, so `renderedTop - lastAppliedMargin` is exactly
// that group's natural top, with zero extra DOM writes to get there. (Deliberately tracked in JS,
// not read back via `getComputedStyle` on the element itself: besides the general fragility of
// treating a style read as authoritative — subject to whatever else touches this element, and to
// `getComputedStyle` support/behavior quirks the value written here doesn't depend on — a
// mid-`transition` computed read would reflect the CURRENT animated frame, not the settled target
// this function itself last asked for, which is the number this math actually needs.) The final
// write is then skipped entirely (via an epsilon, to absorb sub-pixel measurement noise) whenever it
// would just reassert the value already in place — setting a CSS property to the value it already
// holds is a no-op in every browser (no transition restart, no layout change, no `ResizeObserver`
// re-fire), which is what actually breaks the loop: a genuine change still nudges and transitions
// smoothly exactly once, then reliably converges and goes quiet.
function syncBranchAlignment(): void {
  const trunkEl = trunkRef.value;
  if (!trunkEl || branchSegments.value.length === 0) return;
  const trunkTop = trunkEl.getBoundingClientRect().top;

  for (const segment of branchSegments.value) {
    const key = segmentKey(segment);
    const groupEl = branchGroupEls.get(key);
    const runCardEl = runCardEls.get(key);
    if (!groupEl || !runCardEl) continue;

    const currentMargin = appliedMargins.get(key) ?? 0;
    const naturalTop = groupEl.getBoundingClientRect().top - trunkTop - currentMargin;
    const targetTop = runCardEl.getBoundingClientRect().bottom - trunkTop;
    const delta = Math.max(0, targetTop - naturalTop);

    // Sub-pixel-tolerant no-op guard: without this, two passes over an otherwise-unchanged layout
    // could still disagree by a fraction of a pixel (measurement noise) and write a "new" value
    // forever. 0.5px is well below anything visibly distinguishable.
    if (Math.abs(delta - currentMargin) < 0.5) continue;
    appliedMargins.set(key, delta);
    groupEl.style.marginTop = delta > 0 ? `${delta}px` : '';
  }
}

// Recomputed whenever this Thread's own segment/branch structure or any message's expand/collapse
// state changes — covers the trunk message a branch anchors to, the branch's own messages (a
// nested `ThreadCard`'s height change bubbles up as a resize of `branchesRef` below), and multiple
// sibling branches sharing one segment (all still stacked correctly, see `syncBranchAlignment`'s own
// doc comment). `flush: 'post'` so refs/DOM already reflect the new state before measuring.
watch([branchSegments, expandedByMessage], () => void nextTick(scheduleAlignSync), {
  deep: true,
  flush: 'post',
});

// Catches everything the watcher above can't: text reflow from a viewport/column-width change, a
// deeply-nested descendant's own async content growth, fonts loading, etc. — anything that changes
// a segment's or a branch group's real rendered height without this Thread's own reactive state
// changing. Two targets, not one per segment/group: `trunkEl`'s own border-box height already
// changes whenever any run-card inside it does, and likewise for `branchesEl` and its branch groups
// — one observer per column captures every interior resize that matters here without the
// bookkeeping of one observer per segment/group.
let resizeObserver: ResizeObserver | null = null;
function ensureResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;
  if (!resizeObserver) resizeObserver = new ResizeObserver(() => scheduleAlignSync());
  return resizeObserver;
}
// `branchesRef` (unlike `trunkRef`) only exists while `branchSegments.length > 0` (the
// `v-if` above `.thread-branches`) — so its element can appear/disappear well after this component
// already mounted (the first branch off a previously-childless segment, or the last one going
// `doneAt`), not just once at mount time, hence a `watch` on each ref rather than a one-time
// `observe` call in `onMounted`.
watch(trunkRef, (el, prev) => {
  const ro = ensureResizeObserver();
  if (!ro) return;
  if (prev) ro.unobserve(prev);
  if (el) ro.observe(el);
});
watch(branchesRef, (el, prev) => {
  const ro = ensureResizeObserver();
  if (!ro) return;
  if (prev) ro.unobserve(prev);
  if (el) ro.observe(el);
});
onMounted(() => scheduleAlignSync());
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (alignFrame !== null) cancelScheduledFrame(alignFrame);
  if (alignSettleTimer !== null) clearTimeout(alignSettleTimer);
});
</script>

<template>
  <div v-if="thread" class="thread-node">
    <div ref="trunkRef" class="thread-trunk">
      <!-- Header containment fix: the Y-split redesign (`fa163d9`) pulled this header out of the
           single continuous `.thread-card` it used to be the first child of — needed so it can stay
           sticky across the WHOLE trunk (every run-card, not just the first) rather than scrolling
           away with whichever run-card happened to contain it — but left it a bare, unbordered flex
           sibling of `.thread-run-chain` below, floating disconnected above the box chain instead of
           reading as part of it (bug report: "the title and expand buttons render outside the
           threaded conversation"). Fixed by giving the header its own top-rounded, bottom-borderless
           border (`.thread-card-header`'s own CSS, below) and flushing it directly against
           `.thread-run-chain`'s first box (`.thread-run-chain`'s own CSS zeroes exactly that one
           seam) — together they read as one continuous bordered box again, header lid included, with
           no change to the sticky scope that motivated pulling it out in the first place. This also
           fixes a second symptom of the same regression: a branch's own connector arrow targets the
           TOP of its nested `ThreadCard` (`.thread-branch-fork`'s `top: 0`), which — while the header
           floated above the box, unbordered — was the header's own top, landing the arrowhead in the
           middle of the title text instead of on a box edge; reattaching the header as this box's lid
           makes that same top edge a real bordered corner again. -->
      <header
        class="thread-card-header"
        :class="{ 'thread-card-header--active': threadId === activeThreadId }"
      >
        <!-- Parity fix (011-linear-thread-mode follow-up): same click-to-edit title affordance as
             canvas mode's `ConversationThreadBox.vue`/`ConversationView.vue`, via the same shared
             `useConversationRename` composable — see this file's own script doc comment. -->
        <div class="thread-card-title-group">
          <input
            v-if="isEditingName"
            ref="nameInputEl"
            v-model="nameDraft"
            type="text"
            class="thread-title-input"
            aria-label="Thread name"
            :disabled="renameSaving"
            @keydown.enter.prevent="saveName"
            @keydown.escape.prevent="cancelEditingName"
            @blur="saveName"
          />
          <template v-else>
            <span class="thread-card-title text-wrap-safe">{{ thread.name }}</span>
            <button
              type="button"
              class="thread-rename-button"
              aria-label="Rename thread"
              title="Rename thread"
              @click="startEditingName"
            >
              ✎
            </button>
          </template>
        </div>
        <span v-if="thread.kind === 'thread-root'" class="thread-root-badge">Root</span>
        <span class="thread-card-actions">
          <ConversationActionButtons :actions="headerActions" />
        </span>
      </header>
      <span v-if="renameError" class="rename-error" role="alert">{{ renameError }}</span>
      <span v-if="doneError" class="thread-error" role="alert">{{ doneError }}</span>

      <!-- Parity fix (011-linear-thread-mode follow-up): a Thread's own agent-turn-errored banner —
           same shape/CSS as `ConversationView.vue`'s (`.error-banner*`, hoisted into style.css) and
           the same dismiss semantics (`agentErrorBanner.ts`). Without this, a failed turn here had
           no visible signal at all and no way to retry it. -->
      <div v-if="thread.status === 'errored' && !errorDismissed" class="error-banner" role="alert">
        <span class="error-banner-message text-wrap-safe">{{
          thread.errorMessage ?? 'The agent hit an error.'
        }}</span>
        <span class="error-banner-actions">
          <button type="button" @click="onRetry">Retry</button>
          <button type="button" aria-label="Dismiss error" @click="dismissError">Dismiss</button>
        </span>
      </div>

      <!-- Groups every bordered box this Thread's own trunk renders (the zero-message composer-only
           card, or the run-card chain below) so exactly one of them — always the first — can be
           singled out (`.thread-run-chain > .thread-card:first-child`, CSS below) to square off its
           own top corners and sit flush against the header immediately above, forming one visual box
           together with it. See the header's own doc comment above for the bug this fixes. -->
      <div class="thread-run-chain">
        <!-- `useThreadSegments` returns no segments at all for a Thread with zero messages yet (a
             freshly created root — thread-branches always get an auto-seeded first message) —
             without this, a brand-new Thread could never render a composer to send its own first
             message. -->
        <article
          v-if="messages.length === 0"
          class="thread-card"
          :class="{ 'thread-card--active': threadId === activeThreadId }"
          :style="cardStyle"
          :data-thread-id="threadId"
          :data-thread-kind="thread.kind"
        >
          <ThreadComposer
            ref="composerRef"
            :thread-id="threadId"
            :disabled="thread.doneAt !== null"
          />
        </article>

        <!-- Y-split fork redesign (see `runs`' own doc comment, script above): every run gets its own
             bordered box, so a fork visually disconnects the trunk here rather than continuing through
             it unbroken — a `.thread-fork-connector` marks that break, dropping straight down into
             this run's own continuation (the next run below), exactly the same shape a branch's own
             connector already fans out sideways with (see `.thread-branches` below). -->
        <template
          v-for="(run, ri) in runs"
          :key="`run-${run[0]!.startIndex}-${run[run.length - 1]!.endIndex}`"
        >
          <article
            :ref="(el) => setRunCardEl(run, el as Element | null)"
            class="thread-card"
            :class="{ 'thread-card--active': threadId === activeThreadId }"
            :style="cardStyle"
            :data-thread-id="threadId"
            :data-thread-kind="thread.kind"
          >
            <div
              v-for="segment in run"
              :key="`${segment.startIndex}-${segment.endIndex}`"
              class="thread-segment"
              :class="{ 'is-tip-segment': segment.isTipSegment }"
            >
              <div
                v-for="(message, offset) in messages.slice(
                  segment.startIndex,
                  segment.endIndex + 1,
                )"
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
          </article>

          <div
            v-if="ri < runs.length - 1"
            class="thread-fork-connector is-terminal"
            aria-hidden="true"
          ></div>
        </template>
      </div>

      <span v-if="branchError" class="thread-error" role="alert">{{ branchError }}</span>
    </div>

    <!-- Branches render as their own sibling column, connected by a line to the run-card they
         forked from — never nested inside a `.thread-card`'s own border. See the layout doc comment
         at the top of this file. Independent fork points (distinct `branchGroups` entries) still
         stack top-to-bottom here, one `.thread-branch-group` per source segment — the horizontal-
         column redesign only rotates the axis WITHIN one group (`.thread-branch-row` below), for
         siblings sharing that exact same fork point. -->
    <div v-if="branchGroups.length > 0" ref="branchesRef" class="thread-branches">
      <div
        v-for="group in branchGroups"
        :key="`branches-${group.segment.startIndex}-${group.segment.endIndex}`"
        :ref="(el) => setBranchGroupEl(group.segment, el as Element | null)"
        class="thread-branch-group"
        :class="{ 'thread-branch-group--fan': group.isFan }"
        :style="branchGroupStyle"
      >
        <!-- Exactly one active child: the simple single-line connector, unchanged from before this
             redesign (`.thread-branch-fork`'s own `::before`/`::after`, CSS below). Two or more
             active children off this exact same fork point (an N-way fork, N > 1): a horizontal ROW
             of columns (`.thread-branch-column`, one per child) fed by a single incoming line
             (`.thread-branch-group--fan::before`) that fans out into a horizontal bar bridging each
             pair of adjacent columns (`.thread-branch-column::before`) with its own downward drop +
             arrowhead into each column's own box — this bar is the row-layout replacement for the
             old vertical `.thread-branch-spine`, which used to chain 2+ *stacked* siblings instead.
             `.thread-branch-row`'s own width is capped so `MAX_VISIBLE_BRANCH_COLUMNS` siblings fit
             before it falls back to `overflow-x: auto` (script/CSS) — columns never wrap. -->
        <div class="thread-branch-row" :style="branchRowStyle">
          <div
            v-for="(childId, ci) in group.children"
            :key="childId"
            :class="
              group.isFan
                ? [
                    'thread-branch-column',
                    { 'thread-branch-column--last': ci === group.children.length - 1 },
                  ]
                : 'thread-branch-fork'
            "
          >
            <span v-if="group.isFan" class="thread-branch-fan-arrow" aria-hidden="true"></span>
            <ThreadCard
              :thread-id="childId"
              :depth="depth + 1"
              :active-thread-id="activeThreadId"
            />
          </div>
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
/* The recursive unit: a flex ROW pairing this Thread's own trunk column (`.thread-trunk` — this
   Thread's sticky header plus a chain of one or more bordered `.thread-card` run-boxes, split at
   every fork point; see `runs`' doc comment in the script) with a further-right column of its
   branch children (`.thread-branches`), as tree siblings rather than one nested inside the other's
   border — see this file's top-of-script doc comment. `align-items: flex-start` (not the flex
   default `stretch`) is load-bearing: it lets `.thread-node` size itself to its own content's
   natural width (trunk width, plus branch width only when branches exist) instead of stretching to
   fill whatever width its own parent flex column (`ThreadModeView.vue`'s `.thread-mode-list`, or a
   shallower `.thread-branches`) happens to have — which is what lets a deep/wide tree grow rightward
   past that ancestor's own box and get picked up by `.thread-mode-list`'s `overflow-x: auto` instead
   of stretching every ancestor's assigned width to match. */
.thread-node {
  display: flex;
  align-items: flex-start;
}
/* The trunk column: this Thread's own sticky header (once, not per run-card) followed by its chain
   of `.thread-card` run-boxes and `.thread-fork-connector`s — see `runs`' doc comment. `flex: 0 0
   auto` for the same fit-content, don't-stretch-or-shrink reason `.thread-card` below already
   needed when it was itself this row's only trunk element. */
.thread-trunk {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  flex: 0 0 auto;
  min-width: 0;
}
/* Groups the trunk's own bordered boxes (the run-card chain, or the zero-message composer-only
   card) so the header immediately above (template) can flush directly against the first one — see
   the header's own doc comment for the containment regression this, together with
   `.thread-card-header + .thread-run-chain` below, fixes. Its own internal `gap` is the same 0.4rem
   `.thread-trunk` already used for card-to-card/connector spacing before this wrapper existed. */
.thread-run-chain {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
/* Cancels `.thread-trunk`'s own `gap` for just the header-to-first-box seam — the adjacent-sibling
   combinator only matches when the header is directly followed by the run-chain in the DOM, so an
   optional `doneError` banner (a `.thread-error` span) sitting between them, when present, still
   gets its own normal gap on both sides instead of being squeezed flush against the header too. */
.thread-card-header + .thread-run-chain {
  margin-top: -0.4rem;
}
/* The run-chain's own first box is the one the header sits directly on top of (previous rule) — its
   top corners square off to meet the header's own rounded-top border exactly, rather than each
   drawing its own independent rounded corner where they touch. Every other run-card down the chain
   (a later fork's continuation) is a fully independent box, full rounding intact. */
.thread-run-chain > .thread-card:first-child {
  border-radius: 0 0 8px 8px;
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
     branches sitting beside their trunk (a row of siblings) rather than only stacked below it.
     Bordered, rounded on top only, with no bottom border (`.thread-run-chain > .thread-card:first-
     child`'s own squared-off top corners are this rule's exact counterpart) — together the two read
     as one continuous box, header lid included, rather than the header floating disconnected above
     it (bug report: "the title and expand buttons render outside the threaded conversation").
     Horizontal padding now matches `.thread-card`'s own 0.75rem so the title lines up with message
     content below it instead of touching this new border with no inset of its own. */
  margin: 0;
  padding: 0.15rem 0.75rem;
  border: 1px solid var(--border-color, #ccc);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  position: sticky;
  top: 0;
  z-index: var(--z-raised, 1);
  background: var(--panel-bg, #f7f7f8);
}
/* This header's own equivalent of `.thread-card.thread-card--active` (same tokens, same ring
   treatment) — now that it visually reads as this box's own lid rather than a disconnected label
   above it, leaving it unhighlighted while the box below carries the HUD cursor ring would make that
   ring look like it started partway down a single box instead of wrapping the whole thing. */
.thread-card-header.thread-card-header--active {
  border-color: var(--accent-color, #2563eb);
  box-shadow: 0 0 0 2px var(--accent-color, #2563eb);
}
/* Parity fix (011-linear-thread-mode follow-up): groups the title/rename-button pair (or the
   rename `<input>`) so the pair together — not just the plain-text span — takes over the flex slot
   `.thread-card-title` alone used to occupy directly in the header row. Same shape as
   `ConversationThreadBox.vue`'s own `.thread-title-group`. */
.thread-card-title-group {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 1 1 auto;
  min-width: 0;
}
.thread-card-title {
  font-weight: 600;
  min-width: 0;
}
/* `.thread-rename-button`/`.rename-error`'s shared shape lives in style.css (identical to
   `ConversationThreadBox.vue`'s/`ConversationView.vue`'s own copies). `.thread-title-input`'s
   shared shape (flex/border/padding) also lives there — this override layers just the three
   properties that differ, matching this card's own title styling. */
.thread-title-input {
  font-weight: 600;
  font-size: inherit;
  background: var(--panel-bg, #f7f7f8);
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
   any active children, stacked top-to-bottom in the same order as the segments themselves;
   `align-items: flex-start` for the same fit-content-not-stretch reason as `.thread-node` above.
   Plain top-to-bottom flex stacking alone does NOT keep a group "across from" the segment it forked
   from (this column's stacking depends only on branch-group heights, never on trunk-segment
   heights) — the script's own `syncBranchAlignment` nudges each group's `margin-top` to actually
   land it there; see that function's doc comment for why this couldn't be expressed in CSS alone. */
.thread-branches {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1.25rem;
  padding-top: 0.25rem;
}
/* Horizontal-column redesign (Variant A): this now wraps a SINGLE child (`.thread-branch-row`,
   below) rather than laying out multiple stacked `.thread-branch-fork`/`.thread-branch-spine`
   children directly — the sibling-branch axis rotated from vertical stacking to a horizontal row
   lives entirely in `.thread-branch-row`'s own CSS now. This element's one remaining job is the
   exact one `syncBranchAlignment` (script) still depends on: being the DOM node whose OWN top edge
   that function nudges (`margin-top`) to align with the run-card it forked from — see that
   function's doc comment, UNCHANGED by this redesign, since the vertical alignment axis it operates
   on is orthogonal to the row's internal horizontal layout (neither the plain single-fork case nor
   the fan case below shifts this element's own top edge away from its row's top edge). The
   `margin-top` transition that smooths `syncBranchAlignment`'s own JS-computed nudges (the same way
   `MessageBubble.vue`'s own `transition: max-height` smooths the toggle that typically causes them,
   rather than snapping straight to the new position) is deliberately NOT a static rule here — it's
   the inline `branchGroupStyle` computed in the script above, `none` until this card's own initial
   alignment settles and permanently the real transition after that, so a freshly loaded/refreshed
   page snaps directly into its final position instead of visibly animating every corrective pass a
   fresh mount's asynchronous data/content settling triggers (bug report: "~2 seconds of animations"
   on refresh) — see `alignTransitionsReady`'s own doc comment for the full rationale. */
.thread-branch-group {
  display: block;
}
/* Two or more active branches off the exact same fork point (an N-way fork, N > 1) reserve room for
   the single incoming line from the run-card (`syncBranchAlignment`'s own alignment target, this
   group's own top edge) to fan out sideways into `.thread-branch-row`'s own horizontal bar below —
   `position: relative` so this `::before` can anchor to this group's own top-left corner exactly the
   way `.thread-branch-fork`'s single-branch connector already anchors to ITS own top-left below
   (same 1.75rem budget, now spent once per GROUP instead of once per fork, since every sibling in
   the row shares this one fan-in point rather than each drawing its own). */
.thread-branch-group--fan {
  position: relative;
  padding-left: 1.75rem;
}
.thread-branch-group--fan::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 1.75rem;
  height: 0;
  border-top: 2px solid var(--neutral-muted-color, #4b5563);
}
/* FR-005b: the sibling ROW of branch columns for one fork point (rotated from the old vertical
   stack — see this file's top doc comment). `align-items: flex-start` keeps every column's own top
   edge level with the row's own top (load-bearing for the fan-bar math below: every column's
   `::before`/`::after` connector assumes `top: 0` IS the shared fan-in level). `flex-wrap` is
   deliberately omitted — the locked-in width-cap decision is horizontal SCROLL past
   `MAX_VISIBLE_BRANCH_COLUMNS` siblings (script), never a second row. `max-width`/the
   `--thread-branch-fan-gap` custom property both come from the inline `branchRowStyle` (script)
   rather than a static rule here, since the cap depends on this row's own child depth (`depth + 1`,
   which varies per `ThreadCard` instance) the way `cardStyle`'s per-depth width already does. */
.thread-branch-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--thread-branch-fan-gap, 2rem);
  overflow-x: auto;
  padding-bottom: 2px;
}
/* Exactly one active child at this fork point: the simple single-line connector, UNCHANGED from
   before this redesign (a plain horizontal line + arrowhead, mockup's "───▶") — there is nothing to
   fan out when there's only one destination, so this keeps the exact pixel-identical look a
   single-branch fork point already had. `padding-left` reserves the room the line/arrowhead draw
   into, so this completely owns its own spacing from `.thread-card`'s right edge. `top: 0` (touching
   this fork's own top edge exactly, not some offset into it) is load-bearing: this fork sits exactly
   level with the run-card's bottom edge (`syncBranchAlignment`'s own alignment target), so a line
   drawn any lower than that floats disconnected from the trunk entirely — the bug an earlier fixed
   `1.15rem` offset here actually had, confirmed visually (the line landed inside this box's own
   header text, never touching the trunk boundary at all). */
.thread-branch-fork {
  position: relative;
  padding-left: 1.75rem;
  flex: 0 0 auto;
}
.thread-branch-fork::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 1.75rem;
  height: 0;
  border-top: 2px solid var(--neutral-muted-color, #4b5563);
}
.thread-branch-fork::after {
  content: '';
  position: absolute;
  top: -5px;
  left: 1.75rem;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-left-color: var(--neutral-muted-color, #4b5563);
  border-right-width: 0;
  transform: translateX(-1px);
}
/* Two or more active children at this fork point: a fan-bar column instead of the single-branch
   `.thread-branch-fork` above — the horizontal-row replacement for the old vertical
   `.thread-branch-spine` (which used to chain 2+ *stacked* siblings top-to-bottom; this bridges them
   left-to-right instead). `flex: 0 0 auto` so a column never shrinks below its own nested
   `ThreadCard`'s fixed inline width (`cardStyle`) — the whole point of the width-cap/scroll decision
   is that columns keep their real width and the ROW scrolls, rather than columns silently squashing
   to fit. `padding-top` reserves the vertical "fan zone" above each box (same 1.25rem height
   `.thread-fork-connector` already uses for its own vertical connector, for visual consistency) that
   the bridging bar (`::before`) and the drop-tick (`::after`) below draw into. */
.thread-branch-column {
  position: relative;
  padding-top: 1.25rem;
  flex: 0 0 auto;
}
/* The horizontal bar segment: spans this column's own full width PLUS the row's own `gap` past its
   right edge, landing exactly on the NEXT column's own left edge (where that column's identical
   drop-tick — `::after` below — starts) — so each non-last column's segment, chained end-to-end,
   draws one continuous bar from the first column's own top-left (where the incoming line from
   `.thread-branch-group--fan::before` lands) through to the last column's own top-left. The LAST
   column has nothing further right to bridge to, so it alone skips this segment. */
.thread-branch-column:not(.thread-branch-column--last)::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: calc(-1 * var(--thread-branch-fan-gap, 2rem));
  height: 0;
  border-top: 2px solid var(--neutral-muted-color, #4b5563);
}
/* Every column's own downward drop from the shared fan-bar level (`top: 0`, this column's own
   top-left corner) down into its own box's top edge — the vertical half of the rotated connector,
   paired with `.thread-branch-fan-arrow` (template) for the actual arrowhead, the same way
   `.thread-fork-connector`'s own vertical line pairs with its `is-terminal::after` arrowhead. */
.thread-branch-column::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 1.25rem;
  border-left: 2px solid var(--neutral-muted-color, #4b5563);
}
/* A real templated element (not a 3rd pseudo-element — `::before`/`::after` above are already
   spoken for by the bridging bar and the drop line) marking this column's own real destination —
   the downward-pointing counterpart of `.thread-fork-connector.is-terminal::after`/the old
   `.thread-branch-fork::after`'s rightward-pointing one, rotated 90° to match the drop-tick it caps. */
.thread-branch-fan-arrow {
  position: absolute;
  top: calc(1.25rem - 5px);
  left: -5px;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-top-color: var(--neutral-muted-color, #4b5563);
  border-bottom-width: 0;
}
/* The trunk's own equivalent of `.thread-branch-fork`'s connector — marks a run-card's own fork
   point continuing straight down into its next run (this run's continuation), the sibling-below
   counterpart to branches fanning out sideways from that exact same point. `is-terminal` (always set
   where this renders — see template) draws a downward arrowhead: unlike a `.thread-branch-fork`, the
   box below has no arrowhead of its own marking it as a real destination, so this connector needs
   its own. */
.thread-fork-connector {
  position: relative;
  height: 1.25rem;
  width: 100%;
}
.thread-fork-connector::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 1.5rem;
  width: 0;
  border-left: 2px solid var(--neutral-muted-color, #4b5563);
}
.thread-fork-connector.is-terminal::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: calc(1.5rem - 5px);
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-top-color: var(--neutral-muted-color, #4b5563);
  border-bottom-width: 0;
}
</style>
