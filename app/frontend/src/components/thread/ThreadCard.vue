<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
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
 * 011-linear-thread-mode (column-packing redesign): renders one Thread as one or more stacked,
 * read-only "run" boxes (`runs` below, built from `useThreadSegments.ts`'s segments, split at
 * every point some other Thread branched from). Recursive, but no longer "recurse once per Thread
 * and lay its whole run-chain + branch column out in one go" — this component now recurses once
 * PER RUN: each mounted `ThreadCard` renders exactly `runs[runStartIndex]` (one bordered box) and,
 * if that run forks, (a) a `.thread-branch-row` directly beneath it — one nested `ThreadCard` per
 * active branch child, at `depth + 1` — and, strictly AFTER that entire branch row (never beside
 * it), (b) this SAME thread's own continuation, self-mounted one `runStartIndex` deeper at the
 * SAME `depth`.
 *
 * Why "after", not "beside": the previous design rendered a Thread's entire run-chain in one
 * `.thread-trunk` flex column beside a wholly separate `.thread-branches` flex column, then used
 * `syncBranchAlignment` — `getBoundingClientRect()` measurements feeding a JS-computed `margin-top`
 * nudge on a `ResizeObserver` — to fake the two columns staying level with each other. The FIRST
 * self-recursing redesign replaced that with putting a fork's continuation and its branch(es) as
 * flex-ROW siblings sharing one shared width negotiation — but that reintroduced the same coupling
 * one level down: a continuation that itself forks further needs more horizontal room than a
 * single run-card, and a flex row has no way to grant it that without either clipping it (the
 * original overlap bug) or pushing its OWN row-sibling (the branch row) sideways to make room (the
 * bug this doc comment is now fixed against — a later, unrelated fork's branch row no longer lines
 * up with an earlier one at the same depth). Sequential BLOCKS side-steps both: the branch row's
 * own `margin-left` (`branchRowStyle`, a fixed per-depth constant, script below) never depends on
 * anything rendered elsewhere, and normal block stacking guarantees the continuation — however deep
 * its own subtree gets — can never overlap the branch row above it, since it can only start once
 * that whole row has finished.
 *
 * This also gives column reuse for free: two forks that are NOT ancestor/descendant of each other
 * (e.g. one thread's own fork, then later — after that fork's whole subtree has finished rendering —
 * a second, unrelated fork off this same thread's continuation) each measure their own
 * `.thread-branch-row`'s indent from the same fixed per-depth constant, landing at the exact same
 * horizontal offset without anything having to track which "column" is free — normal DOM flow does
 * it, exactly like a git-log graph's lanes.
 */
const props = withDefaults(
  defineProps<{
    threadId: string;
    depth?: number;
    /** Which run of THIS thread this instance renders (`runs[runStartIndex]`) — 0 for the thread's
     *  own first-mounted instance (the only one that renders the header/name-edit/done/error-banner
     *  chrome, all thread-wide rather than per-run), incrementing by 1 each time a fork's own
     *  continuation self-mounts one run deeper. See this file's own top doc comment. */
    runStartIndex?: number;
    /** 011-linear-thread-mode: Thread mode's own HUD cursor (`threadFocusState.ts`'s
     *  `activeThreadId`), threaded down through every recursive `ThreadCard` the same way `depth`
     *  already is, so whichever card matches gets the `.thread-card--active` highlight — see this
     *  file's own template for where. `null`/`undefined` (no active selection yet) highlights
     *  nothing. */
    activeThreadId?: string | null;
  }>(),
  { depth: 0, runStartIndex: 0, activeThreadId: null },
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
// Every recursive per-run instance of the same thread re-seeds/reads the exact same
// `store.expandedByMessage[threadId]` map — harmless (idempotent) duplication across instances,
// same as the `onMounted` `loadDetail` guard above.
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

/** Y-split fork design: the trunk visually disconnects at every point it has an active branch,
 *  rather than rendering as one continuous box the whole branch column merely sits beside. A "run"
 *  is a maximal consecutive slice of `segments` ending either at the first segment with an active
 *  child (a fork point) or at the thread's actual tip segment, whichever comes first — each run
 *  renders as its own bordered `.thread-card` box (see template below), so a fork produces sibling
 *  boxes (this run's own continuation, plus every active branch off it) instead of the trunk simply
 *  continuing through unbroken. A done branch never ends a run early (reuses the same
 *  `activeChildIds` filter as the fork check below), so a done branch keeps reading as an ordinary
 *  mid-run dashed segment break, not a fork — and a run can legitimately contain more than one
 *  `ThreadSegment` when an intermediate segment's only child was later marked done. */
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

/** This instance's own single run — `null` only in the defensive case of a stale recursive mount
 *  outliving a `runs` recompute that shrank the array (e.g. a sibling branch going `doneAt` merged
 *  two runs back together mid-render); Vue re-renders this instance away on the same tick regardless. */
const currentRun = computed<ThreadSegment[] | null>(() => runs.value[props.runStartIndex] ?? null);
const currentRunLastSegment = computed(() => {
  const run = currentRun.value;
  return run && run.length > 0 ? run[run.length - 1]! : null;
});
const currentRunChildren = computed<string[]>(() =>
  currentRunLastSegment.value ? activeChildIds(currentRunLastSegment.value.childBranchIds) : [],
);
/** Exactly one active child keeps the simpler single-line `.thread-branch-fork` connector; 2+
 *  active children off this exact same fork point get the horizontal-row/fan-bar treatment
 *  (`.thread-branch-row`/`.thread-branch-column` below). */
const isFan = computed(() => currentRunChildren.value.length > 1);
/** Whether this thread has any more runs after this one — when true, this run's own fork row
 *  reserves a continuation lane that self-mounts `ThreadCard` one `runStartIndex` deeper. A run can
 *  fork (`currentRunChildren.length > 0`) with no continuation at all when the fork anchor is also
 *  the thread's actual tip message — nothing follows it either way. */
const hasContinuation = computed(() => props.runStartIndex + 1 < runs.value.length);

/** Width-cap (Variant A locked-in decision): 2+ active branches off one fork point lay out as a
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
 *  `cardStyle` below for the per-depth width lookup this mirrors, so the cap below budgets for the
 *  REAL column width instead of guessing. */
const branchColumnWidthPx = computed(
  () => CARD_MAX_WIDTH_PX[props.depth + 1] ?? DEEPER_CARD_MAX_WIDTH_PX,
);
/** `.thread-branch-row`'s own `margin-left` indent — a FIXED value from `depth` (the same per-depth
 *  budget `cardStyle` below uses for THIS run-card's own width), not anything measured or dependent
 *  on a sibling's rendered size. This is what keeps every branch row at the same depth landing at
 *  the SAME horizontal offset regardless of what else this thread's own continuation later needs —
 *  see this file's own top doc comment: the continuation renders as a separate, later block (plain
 *  block flow, below this whole branch row), never a flex-row sibling sharing width negotiation
 *  with it, so a continuation that itself forks arbitrarily wide can never push this row sideways. */
const branchRowStyle = computed(() => {
  const capPx =
    MAX_VISIBLE_BRANCH_COLUMNS * branchColumnWidthPx.value +
    (MAX_VISIBLE_BRANCH_COLUMNS - 1) * BRANCH_COLUMN_GAP_PX;
  const indentPx = CARD_MAX_WIDTH_PX[props.depth] ?? DEEPER_CARD_MAX_WIDTH_PX;
  return {
    marginLeft: `min(${indentPx}px, calc(100vw - 2.5rem))`,
    maxWidth: `min(${capPx}px, calc(100vw - 2.5rem))`,
    '--thread-branch-fan-gap': `${BRANCH_COLUMN_GAP_PX}px`,
  };
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
//
// Scoped per per-run instance (not hoisted to `runStartIndex === 0`): a selection can only ever
// originate from a message rendered by THIS instance's own `currentRun`, and `HighlightBranchMenu`
// positions itself from the captured selection's own viewport rect, so it reads correctly
// regardless of which recursive instance happens to own the state that triggered it.
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
// Thread-wide (header-only) concerns — only ever rendered by the `runStartIndex === 0` instance.
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
// (`.error-banner*`, hoisted into style.css) rather than inventing a second one.
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
 *  short, focused side-exchange, not a full transcript. Also the fixed per-depth budget
 *  `branchRowStyle` above reuses for its own `margin-left` indent. */
const CARD_MAX_WIDTH_PX: Record<number, number> = { 0: 640, 1: 420 };
const DEEPER_CARD_MAX_WIDTH_PX = 300;
const cardStyle = computed(() => ({
  width: `min(${CARD_MAX_WIDTH_PX[props.depth] ?? DEEPER_CARD_MAX_WIDTH_PX}px, calc(100vw - 2.5rem))`,
}));
</script>

<template>
  <div v-if="thread" class="thread-node">
    <!-- Header containment fix: the Y-split redesign (`fa163d9`) pulled this header out of the
         single continuous `.thread-card` it used to be the first child of — needed so it can stay
         sticky across the WHOLE run-chain (every run-card, not just the first) rather than
         scrolling away with whichever run-card happened to contain it — but left it a bare,
         unbordered flex sibling floating disconnected above the box chain instead of reading as
         part of it (bug report: "the title and expand buttons render outside the threaded
         conversation"). Fixed by giving the header its own top-rounded, bottom-borderless border
         (`.thread-card-header`'s own CSS, below) and squaring off the top corners of whichever run
         is THIS thread's own first (`.thread-card--flush-header`, applied whenever
         `runStartIndex === 0`, regardless of which run/self-recursion depth this instance actually
         renders) — together they read as one continuous bordered box, header lid included.
         Header/name-edit/done/error-banner chrome is thread-wide, so only the thread's own first
         (`runStartIndex === 0`) instance ever renders it — every deeper self-recursion (a fork's
         own continuation) renders only its own run-card plus whatever forks further from it. -->
    <template v-if="runStartIndex === 0">
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
    </template>

    <!-- `useThreadSegments` returns no segments at all for a Thread with zero messages yet (a
         freshly created root — thread-branches always get an auto-seeded first message) — without
         this, a brand-new Thread could never render a composer to send its own first message. Only
         ever reachable at `runStartIndex === 0` (a zero-message thread has no forks, so no deeper
         self-recursion is ever mounted). -->
    <article
      v-if="messages.length === 0"
      class="thread-card"
      :class="{
        'thread-card--active': threadId === activeThreadId,
        'thread-card--flush-header': runStartIndex === 0,
      }"
      :style="cardStyle"
      :data-thread-id="threadId"
      :data-thread-kind="thread.kind"
    >
      <ThreadComposer ref="composerRef" :thread-id="threadId" :disabled="thread.doneAt !== null" />
    </article>

    <!-- Y-split fork design (see `runs`' own doc comment, script above): every run gets its own
         bordered box, so a fork visually disconnects the trunk here rather than continuing through
         it unbroken. -->
    <article
      v-else-if="currentRun"
      class="thread-card"
      :class="{
        'thread-card--active': threadId === activeThreadId,
        'thread-card--flush-header': runStartIndex === 0,
      }"
      :style="cardStyle"
      :data-thread-id="threadId"
      :data-thread-kind="thread.kind"
    >
      <div
        v-for="segment in currentRun"
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
    </article>

    <span v-if="branchError" class="thread-error" role="alert">{{ branchError }}</span>

    <!-- Every active branch off this run: a SEPARATE block (never a flex-row sibling of the
         continuation below — see this file's own top doc comment) so its own `margin-left` indent
         (`branchRowStyle`, a FIXED per-depth value) never depends on how wide this thread's own
         later continuation ends up needing. Exactly one active child: the simple single-line
         connector (`.thread-branch-fork`'s own `::before`/`::after`, CSS below). Two or more active
         children off this exact same fork point (an N-way fork, N > 1): a horizontal ROW of columns
         (`.thread-branch-column`, one per child), each with its own downward drop + arrowhead.
         `.thread-branch-row`'s own width is capped so `MAX_VISIBLE_BRANCH_COLUMNS` siblings fit
         before it falls back to `overflow-x: auto` (script/CSS) — columns never wrap. -->
    <div v-if="currentRunChildren.length > 0" class="thread-branch-row" :style="branchRowStyle">
      <div
        v-for="(childId, ci) in currentRunChildren"
        :key="childId"
        :class="
          isFan
            ? [
                'thread-branch-column',
                { 'thread-branch-column--last': ci === currentRunChildren.length - 1 },
              ]
            : 'thread-branch-fork'
        "
      >
        <span v-if="isFan" class="thread-branch-fan-arrow" aria-hidden="true"></span>
        <ThreadCard :thread-id="childId" :depth="depth + 1" :active-thread-id="activeThreadId" />
      </div>
    </div>

    <!-- This run's own continuation: this SAME thread, self-mounted one run deeper at the SAME
         `depth`, rendered strictly AFTER the branch row above (plain block flow, same column,
         `depth` unchanged) — never beside it. This is what gives column alignment for free: two
         forks that aren't ancestor/descendant of each other (this fork's own branch row, then
         later — once its ENTIRE subtree has finished rendering — this thread's continuation
         forking again) each measure their own `margin-left` from the same fixed per-depth
         constant, with nothing carried over from what the earlier fork's subtree needed. -->
    <template v-if="hasContinuation">
      <div class="thread-fork-connector" aria-hidden="true"></div>
      <ThreadCard
        :thread-id="threadId"
        :run-start-index="runStartIndex + 1"
        :depth="depth"
        :active-thread-id="activeThreadId"
      />
    </template>

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
/* The recursive unit: a flex COLUMN stacking, in order, this instance's own single run-card (or
   the zero-message composer card) — plus, at `runStartIndex === 0` only, the header/name-edit/
   done/error-banner chrome above it — then (if this run forks) a `.thread-branch-row`, then (if
   this run has a continuation) that continuation's own `.thread-node`, self-mounted one level
   "into" this same flex column. Sequential BLOCKS, not a nested flex row pairing branches with the
   continuation — see this file's own top doc comment for why that distinction is load-bearing (it's
   what keeps a later, unrelated fork's own branch row from being pushed sideways by an earlier
   fork's continuation). `align-items: flex-start` (not the flex default `stretch`) is load-bearing
   too: it lets `.thread-node` size itself to its own content's natural width instead of stretching
   to fill whatever width its own parent (`ThreadModeView.vue`'s `.thread-mode-list`, or a
   `.thread-branch-row` column) happens to have — which is what lets a deep/wide tree grow rightward
   past that ancestor's own box and get picked up by `.thread-mode-list`'s `overflow-x: auto`
   instead of stretching every ancestor's assigned width to match. */
.thread-node {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  min-width: 0;
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
     can't express. */
  flex: 0 0 auto;
}
.thread-card.thread-card--active {
  border-color: var(--accent-color, #2563eb);
  box-shadow: 0 0 0 2px var(--accent-color, #2563eb);
}
/* The thread's own first-rendered box (`runStartIndex === 0`, whichever run that happens to be)
   squares off its top corners to sit flush against the header immediately above it — see the
   header's own doc comment (template) for the containment regression this fixes. Every OTHER run
   (a fork's own continuation, self-mounted deeper) keeps full rounding, since nothing sits directly
   above it. */
.thread-card.thread-card--flush-header {
  border-radius: 0 0 8px 8px;
}
/* The exact flush (zero-gap) seam between the header and that same first box — scoped to real DOM
   adjacency (not just the `--flush-header` class alone) so an optional `renameError`/`doneError`/
   `error-banner` rendered between them, when present, still gets its own normal gap on both sides
   instead of being squeezed flush against the header too (the box still keeps its squared corners
   either way, from the rule above). */
.thread-card-header + .thread-card.thread-card--flush-header {
  margin-top: -0.4rem;
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
     can't show through underneath). Bordered, rounded on top only, with no bottom border
     (`.thread-card--flush-header`'s own squared-off top corners are this rule's exact counterpart)
     — together the two read as one continuous box, header lid included. Horizontal padding matches
     `.thread-card`'s own 0.75rem so the title lines up with message content below it. */
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
/* The continuation's own straight-down connector — a normal block-level element (NOT positioned
   relative to anything shared with the branch row above; see this file's own top doc comment for
   why continuation and branches are sequential blocks, not flex-row siblings), sitting directly
   between the branch row (or run-card, if this run didn't fork) and the continuation's own nested
   `.thread-node` immediately below. Plain vertical line + downward arrowhead. */
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
.thread-fork-connector::after {
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
/* FR-005b: the branch row for one fork point — a SEPARATE block below the run-card (never a
   flex-row sibling of the continuation; see this file's own top doc comment), indented via its own
   `margin-left` (`branchRowStyle`, script — a FIXED per-depth constant, not anything measured or
   dependent on a sibling). `flex-wrap` is deliberately omitted on the row itself — the locked-in
   width-cap decision is horizontal SCROLL past `MAX_VISIBLE_BRANCH_COLUMNS` siblings (script),
   never a second row. `max-width`/the `--thread-branch-fan-gap` custom property both come from the
   inline `branchRowStyle` rather than a static rule here, since the cap depends on this row's own
   child depth (`depth + 1`, which varies per `ThreadCard` instance) the way `cardStyle`'s per-depth
   width already does. `padding-top` reserves the "fan zone" every child's own connector
   (`.thread-branch-fork`/`.thread-branch-column` below) draws its downward drop into. */
.thread-branch-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--thread-branch-fan-gap, 2rem);
  overflow-x: auto;
  padding-top: 1.25rem;
  padding-bottom: 2px;
}
/* Exactly one active child at this fork point: the simple single-line connector (a plain
   horizontal line + arrowhead, mockup's "───▶"). `padding-left` reserves the room the
   line/arrowhead draw into. `top: -1.25rem` reaches up into `.thread-branch-row`'s own
   `padding-top` fan zone, landing this line exactly level with the row's own top edge. */
.thread-branch-fork {
  position: relative;
  padding-left: 1.75rem;
  flex: 0 0 auto;
}
.thread-branch-fork::before {
  content: '';
  position: absolute;
  top: -1.25rem;
  left: 0;
  width: 1.75rem;
  height: 0;
  border-top: 2px solid var(--neutral-muted-color, #4b5563);
}
.thread-branch-fork::after {
  content: '';
  position: absolute;
  top: calc(-1.25rem - 5px);
  left: 1.75rem;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-left-color: var(--neutral-muted-color, #4b5563);
  border-right-width: 0;
  transform: translateX(-1px);
}
/* Two or more active children at this fork point: a fan-bar column instead of the single-branch
   `.thread-branch-fork` above. `flex: 0 0 auto` so a column never shrinks below its own nested
   `ThreadCard`'s fixed inline width (`cardStyle`) — the whole point of the width-cap/scroll decision
   is that columns keep their real width and the ROW scrolls, rather than columns silently squashing
   to fit. */
.thread-branch-column {
  position: relative;
  flex: 0 0 auto;
}
/* The horizontal bar segment: spans this column's own full width PLUS the row's own `gap` past its
   right edge, landing exactly on the NEXT column's own left edge (where that column's identical
   drop-tick — `::after` below — starts) — so each non-last column's segment, chained end-to-end,
   draws one continuous bar across the row. The LAST column has nothing further right to bridge to,
   so it alone skips this segment. */
.thread-branch-column:not(.thread-branch-column--last)::before {
  content: '';
  position: absolute;
  top: -1.25rem;
  left: 0;
  right: calc(-1 * var(--thread-branch-fan-gap, 2rem));
  height: 0;
  border-top: 2px solid var(--neutral-muted-color, #4b5563);
}
/* Every column's own downward drop from the shared fan-bar level down into its own box's top edge
   — the vertical half of the connector, paired with `.thread-branch-fan-arrow` (template) for the
   actual arrowhead. */
.thread-branch-column::after {
  content: '';
  position: absolute;
  top: -1.25rem;
  left: 0;
  width: 0;
  height: 1.25rem;
  border-left: 2px solid var(--neutral-muted-color, #4b5563);
}
/* A real templated element (not a 3rd pseudo-element — `::before`/`::after` above are already
   spoken for by the bridging bar and the drop line) marking this column's own real destination. */
.thread-branch-fan-arrow {
  position: absolute;
  top: -5px;
  left: -5px;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-top-color: var(--neutral-muted-color, #4b5563);
  border-bottom-width: 0;
}
</style>
