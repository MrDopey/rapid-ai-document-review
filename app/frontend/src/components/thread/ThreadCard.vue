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
 * (`.thread-branches`, one column further right, one `.thread-branch-group` per run that forks, each
 * holding one `.thread-branch-fork` — and so one recursively-nested `.thread-node` — per active
 * child) as flex-row SIBLINGS. Every fork point (a run with 1+ active children) draws N diverging
 * lines from that run's own bottom edge: one straight down (`.thread-fork-connector`) into this
 * run's own continuation, if any messages follow, plus one per active branch
 * (`.thread-branch-fork::before`/`::after`, chained by `.thread-branch-spine` when 2+ branches share
 * one fork point) fanning out sideways — rather than either being nested inside the other's padding,
 * and rather than the trunk silently continuing through the fork unbroken the way it used to.
 * Recursion still grows the DOM to the right (a branch's own branches render inside ITS
 * `.thread-branches`, one more flex row deep, getting this exact same Y-split treatment at
 * depth + 1), it just no longer grows the visual border nesting.
 *
 * Because `.thread-trunk` and `.thread-branches` are two independently-stacking flex columns, this
 * component also has to keep a `.thread-branch-group` visually level with the run-card it forked
 * from itself — see `syncBranchAlignment` below (bug fix: the connector used to only look aligned by
 * coincidence).
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
         at the top of this file. -->
    <div v-if="branchSegments.length > 0" ref="branchesRef" class="thread-branches">
      <div
        v-for="segment in branchSegments"
        :key="`branches-${segment.startIndex}-${segment.endIndex}`"
        :ref="(el) => setBranchGroupEl(segment, el as Element | null)"
        class="thread-branch-group"
      >
        <template v-for="(childId, ci) in activeChildIds(segment.childBranchIds)" :key="childId">
          <!-- Two or more active branches off the exact same segment (an N-way fork, N > 2):
               a spine link between each pair of stacked sibling forks so the whole stack still
               reads as diverging from one shared point (this group's own top, aligned to the
               fork run-card's bottom edge above) rather than each sibling past the first floating
               a disconnected line from nothing. -->
          <div v-if="ci > 0" class="thread-branch-spine" aria-hidden="true"></div>
          <div class="thread-branch-fork">
            <ThreadCard
              :thread-id="childId"
              :depth="depth + 1"
              :active-thread-id="activeThreadId"
            />
          </div>
        </template>
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
/* Multiple sibling branches forked from the very same segment (FR-005b's "these are siblings of
   each other, not nested") stack vertically within one group, each getting its own connector via
   `.thread-branch-fork` below. No `gap` here (unlike before the Y-split redesign): the vertical
   space between stacked siblings is now an explicit `.thread-branch-spine` element (template,
   above) rather than a plain flex gap, so a 3rd+ sibling's connector still reads as one continuous
   line down from the shared fork point instead of a disconnected stub floating from nothing (see
   `.thread-branch-spine` below). `transition: margin-top` smooths `syncBranchAlignment`'s own
   JS-computed nudges (script, above) the same way `MessageBubble.vue`'s own `transition: max-height`
   smooths the toggle that typically causes them, rather than snapping straight to the new position. */
.thread-branch-group {
  display: flex;
  flex-direction: column;
  transition: margin-top 0.1s ease;
}
/* Fills the same vertical space the old flex `gap` used to (0.75rem) between two stacked sibling
   `.thread-branch-fork`s off the same fork point, drawing a plain continuation of the vertical line
   each fork's own `::before` already draws from its own top (below) — together, one unbroken line
   runs from the shared fork point (this group's own top, JS-aligned to the run-card's bottom edge —
   see `syncBranchAlignment`) down past every sibling's own horizontal tick. */
.thread-branch-spine {
  height: 0.75rem;
  width: 0;
  border-left: 2px solid var(--neutral-muted-color, #4b5563);
}
/* Each branch box's own connector line + arrowhead back to the run-card it forked from
   (mockup's "───▶"). `padding-left` reserves the room the line/arrowhead draw into, so this
   completely owns its own spacing from `.thread-card`'s right edge — `.thread-node`'s row has no
   extra `gap` of its own (see below), meaning it's this padding alone, not a shared gap, that keeps
   the whole tree's per-branch connector self-contained no matter how many groups/forks stack up.
   `top: 0` (touching this fork's own top edge exactly, not some offset into it) is load-bearing: the
   FIRST fork in a group sits exactly level with the run-card's bottom edge (`syncBranchAlignment`'s
   own alignment target), so a line drawn any lower than that floats disconnected from the trunk
   entirely — the bug an earlier fixed `1.15rem` offset here actually had, confirmed visually (the
   line landed inside this box's own header text, never touching the trunk boundary at all). */
.thread-branch-fork {
  position: relative;
  padding-left: 1.75rem;
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
