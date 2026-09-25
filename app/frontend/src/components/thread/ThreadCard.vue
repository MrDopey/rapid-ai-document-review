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
// Watches `messages.value.length`, not `messages` itself — canvas mode's WS-driven equivalent
// (`ConversationThreadBox.vue`/`ConversationView.vue`) has the exact same fix, for the exact same
// reason: `stores/thread.ts`'s WS handlers append to the same array via `.push()` rather than
// reassigning it, so a plain `watch(messages, ...)` never re-fires for a live-streamed message
// (the computed only tracks the outer `messagesByThread[threadId]` lookup, not the array's own
// contents) — leaving it unseeded and silently defaulting to the template's own `?? false`
// (collapsed) fallback below, instead of the role-aware default this seeding is supposed to apply.
const expandedByMessage = computed(() => store.expandedByMessage[props.threadId] ?? {});
watch(
  () => messages.value.length,
  () => store.ensureMessageExpandedSeeded(props.threadId),
  { immediate: true },
);

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
/** Exactly one active child renders as the simpler `.thread-branch-fork` column; 2+ active children
 *  off this exact same fork point get the horizontal-row treatment (`.thread-branch-row`/
 *  `.thread-branch-column` below). */
const isFan = computed(() => currentRunChildren.value.length > 1);
/** Whether this thread has any more runs after this one — when true, this run's own fork row
 *  reserves a continuation lane that self-mounts `ThreadCard` one `runStartIndex` deeper. A run can
 *  fork (`currentRunChildren.length > 0`) with no continuation at all when the fork anchor is also
 *  the thread's actual tip message — nothing follows it either way. */
const hasContinuation = computed(() => props.runStartIndex + 1 < runs.value.length);

/** The row's own CSS `gap` between sibling columns, kept as one JS constant (rather than a literal
 *  hand-copied into both this file's script AND the stylesheet) — threaded into the CSS via the
 *  `--thread-branch-fan-gap` custom property `branchRowStyle` sets inline, which
 *  `.thread-branch-row`'s own `gap` reads (CSS below). */
const BRANCH_COLUMN_GAP_PX = 32;

/** `.thread-branch-row`'s own `margin-left` indent is just `CARD_WIDTH_PX` — every `.thread-node`
 *  (this run's own card, and every branch column off it) renders at the same flat width regardless
 *  of depth (CSS below), so there's no per-depth lookup to mirror here. Not anything measured or
 *  dependent on a sibling's rendered size — this is what keeps every branch row landing at the SAME
 *  horizontal offset regardless of what else this thread's own continuation later needs — see this
 *  file's own top doc comment: the continuation renders as a separate, later block (plain block flow,
 *  below this whole branch row), never a flex-row sibling sharing width negotiation with it, so a
 *  continuation that itself forks arbitrarily wide can never push this row sideways.
 *  No `max-width` cap here (and no `overflow-x` on `.thread-branch-row` itself, CSS below) per
 *  explicit request — the row grows to fit however many sibling columns this fork has; if that's
 *  wider than the viewport, `ThreadModeView.vue`'s own `.thread-mode-list` already provides
 *  page-level `overflow-x: auto`, so content scrolls into view there rather than being clipped or
 *  hidden behind a row-local scrollbar. */
const branchRowStyle = computed(() => ({
  marginLeft: `min(${CARD_WIDTH_PX}px, calc(100vw - 2.5rem))`,
  '--thread-branch-fan-gap': `${BRANCH_COLUMN_GAP_PX}px`,
}));

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

/** Flat width every `.thread-node` renders at, regardless of depth (CSS below) — the per-depth
 *  width table (640px trunk / 420px depth-1 / 300px deeper) this used to hold was simplified away
 *  per explicit request; one number now, so `branchRowStyle` above's own `margin-left` indent
 *  arithmetic and the `.thread-node` CSS rule below share a single source of truth instead of two
 *  numbers that could drift out of sync. */
const CARD_WIDTH_PX = 420;
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
         later continuation ends up needing. Exactly one active child: a single `.thread-branch-fork`
         column. Two or more active children off this exact same fork point (an N-way fork, N > 1): a
         horizontal ROW of columns (`.thread-branch-column`, one per child). No connector line is
         drawn between this run and its child branch/branches (removed per explicit request — the
         flat card width and unconstrained row width already make the parent/child relationship
         visually obvious). `.thread-branch-row` has no width cap and no `overflow-x` of its own — it
         grows to fit however many sibling columns this fork has; columns never wrap, and if the row
         ends up wider than the viewport, `ThreadModeView.vue`'s own `.thread-mode-list` page-level
         `overflow-x: auto` picks up the scroll instead. -->
    <!-- `.thread-branch-group` is just a `position: relative` positioning root for the connector
         below when BOTH a branch row and a continuation exist off this same run (a run that forks
         at a non-tip segment always has a continuation — see `runs`' own doc comment above: a run
         only ends early, without also being the tip, when it hits a fork). Its own box has no
         explicit width, so it shrink-wraps to the branch row's real rendered footprint exactly the
         way `.thread-branch-row` did on its own before — this wrapper changes positioning context
         only, not layout/sizing. -->
    <div v-if="currentRunChildren.length > 0" class="thread-branch-group">
      <div class="thread-branch-row" :style="branchRowStyle">
        <div
          v-for="childId in currentRunChildren"
          :key="childId"
          :class="isFan ? 'thread-branch-column' : 'thread-branch-fork'"
        >
          <ThreadCard :thread-id="childId" :depth="depth + 1" :active-thread-id="activeThreadId" />
        </div>
      </div>
      <!-- Bug fix: when this run BOTH forks (branch row above) AND continues, the connector must
           visually join THIS run's own card to THIS run's own continuation — the full distance,
           past the branch row's height, not just the near flex-gap edge adjacent to the branch row
           (bug report: the line "only joins the gap created by the forked conversation from the
           parent" instead of running from the run card all the way down). `position: absolute`
           (via `.thread-fork-connector--spanning`, CSS below) takes it out of flex flow entirely
           and stretches it to exactly cover `.thread-branch-group`'s own box — i.e. running the
           full height of the branch row, whatever that happens to be, with zero JS measurement —
           and its existing `::before`/`::after` pseudo-elements (unchanged, shared with the
           non-spanning connector below) then extend that same 0.4rem past the group's own top/
           bottom edges into the flex gaps on both sides, reaching this run's own card border above
           and the continuation's card border below exactly as they already do in the no-branch-row
           case. -->
      <div
        v-if="hasContinuation"
        class="thread-fork-connector thread-fork-connector--spanning"
        aria-hidden="true"
      ></div>
    </div>

    <!-- This run's own continuation: this SAME thread, self-mounted one run deeper at the SAME
         `depth`, rendered strictly AFTER the branch row above (plain block flow, same column,
         `depth` unchanged) — never beside it. This is what gives column alignment for free: two
         forks that aren't ancestor/descendant of each other (this fork's own branch row, then
         later — once its ENTIRE subtree has finished rendering — this thread's continuation
         forking again) each measure their own `margin-left` from the same fixed per-depth
         constant, with nothing carried over from what the earlier fork's subtree needed. -->
    <template v-if="hasContinuation">
      <!-- No branch row above this run: the simple, original in-flow connector (contributes its
           own 1.25rem of reserved flex height, unlike the spanning variant above which is
           absolutely positioned and reserves none of its own). -->
      <div
        v-if="currentRunChildren.length === 0"
        class="thread-fork-connector"
        aria-hidden="true"
      ></div>
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
   too: it keeps `.thread-node` left-aligned within (never horizontally stretched by) whatever width
   its own parent (`ThreadModeView.vue`'s `.thread-mode-list`, or a `.thread-branch-row` column)
   happens to have. A wide/deep subtree — e.g. this run's own `.thread-branch-row`, which can be
   wider than this node's own fixed width below — still overflows rightward past this box (default
   `overflow: visible`) rather than being clipped, and gets picked up by `.thread-mode-list`'s own
   `overflow-x: auto` the same as before.
   `width` here (moved from `.thread-card`, and off an inline `cardStyle` computed/`:style` binding —
   see this file's own git history, commit 505ab5d) is pure CSS, and flat: every `.thread-node`
   renders at the same fixed width regardless of depth (an earlier per-depth attribute-selector
   lookup, keyed off a `data-depth` attribute, was simplified away per explicit request — one width,
   no JS math, no per-depth table). `.thread-card` (and `.thread-card-header`, its own "lid") fill
   this node's own width at `width: 100%` below, so the node — not the card — is the one true source
   of this run's rendered width; that's also what `.thread-branch-row`'s own `margin-left` indent
   arithmetic (script) relies on lining up with. */
.thread-node {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  min-width: 0;
  width: 420px;
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
  /* Fills its own `.thread-node` parent's fixed width (set above) — `.thread-node` itself is now
     the one place this run's rendered width is decided; without this, `align-items: flex-start` on
     `.thread-node` would let this card shrink-wrap to its own message content instead of matching
     the node's (and the header's, below) fixed width. */
  width: 100%;
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
     `.thread-card`'s own 0.75rem so the title lines up with message content below it. `width: 100%`
     matches `.thread-card`'s own (both fill their shared `.thread-node` parent, CSS above) — without
     it, `.thread-node`'s `align-items: flex-start` would let this header shrink-wrap to just its own
     title/button content instead of reading as the run-card's own full-width lid. */
  margin: 0;
  /* Vertical padding matches canvas mode's `.thread-header` exactly (0.55rem top / 0.4rem
     bottom) — not a smaller placeholder value, since the sticky header's own `-0.4rem` flush-seam
     margin below (`.thread-card-header + .thread-card.thread-card--flush-header`) is tuned to
     close exactly this much bottom padding; a smaller bottom padding here would let that negative
     margin overshoot and pull the box below up into this header's own title/actions row, cutting
     it off abruptly once the header engages `position: sticky`. */
  padding: 0.55rem 0.75rem 0.4rem;
  border: 1px solid var(--border-color, #ccc);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  position: sticky;
  top: 0;
  z-index: var(--z-raised, 1);
  background: var(--panel-bg, #f7f7f8);
  width: 100%;
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
/* The continuation's own straight-down connector. Two variants share this base rule plus the
   `::before`/`::after` pseudo-elements below:
    - No branch row on this run: a normal in-flow block-level element (NOT positioned relative to
      anything shared with a branch row; see this file's own top doc comment for why continuation
      and branches are sequential blocks, not flex-row siblings), sitting directly between the
      run-card and the continuation's own nested `.thread-node` immediately below.
    - A branch row DOES exist on this run (`.thread-fork-connector--spanning`, rendered inside
      `.thread-branch-group` alongside that row rather than as this run's own flex-column
      sibling): absolutely positioned to stretch across the branch row's own full (dynamic)
      height instead of the fixed `1.25rem` box below, so the line reaches past the row rather
      than stopping at its near edge. See `.thread-fork-connector--spanning`'s own rule further
      down for the override.
   Either way: plain vertical line + downward arrowhead. */
.thread-fork-connector {
  position: relative;
  height: 1.25rem;
  width: 100%;
  /* Bug fix: purely decorative (`aria-hidden="true"`, no interactive content) but its box was
     still hit-testable — the spanning variant below stretches this across the full branch row's
     height/width, landing directly on top of a continuation's composer beneath it and silently
     swallowing every click there. A mouse click landing on the connector never reached the
     textarea underneath, so the composer could only be focused via a HUD row click or hotkey jump
     (`ThreadModeView.vue`'s `activeThreadId` watcher calls `.focus()` directly, bypassing hit
     testing entirely) — never by clicking it directly. */
  pointer-events: none;
}
.thread-fork-connector::before {
  content: '';
  position: absolute;
  /* `.thread-node`'s own `gap: 0.4rem` (flex column, CSS above) inserts that same 0.4rem of blank
     space both above this element (between it and the run-card/branch-row before it) and below it
     (between it and the continuation's own `.thread-node` after it) — space this pseudo-element's
     box doesn't otherwise cover, which is exactly what read as "disjointed" (the line stopping
     short of both boxes with a visible break on each end). Extending top/bottom past this box's own
     edges by that same 0.4rem makes the line span the full gap on both sides, flush against the
     card border above and the continuation's card border below, instead of floating between them. */
  top: -0.4rem;
  bottom: -0.4rem;
  left: 1.5rem;
  width: 0;
  border-left: 2px solid var(--neutral-muted-color, #4b5563);
}
.thread-fork-connector::after {
  content: '';
  position: absolute;
  /* Same 0.4rem extension as `::before` above, so the arrowhead's tip lands flush against (1px
     into) the continuation's card border instead of stopping short in the flex gap above it. */
  bottom: calc(-0.4rem - 1px);
  left: calc(1.5rem - 5px);
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-top-color: var(--neutral-muted-color, #4b5563);
  border-bottom-width: 0;
}
/* Positioning root for the spanning connector variant below — a run that both forks and
   continues needs the connector to reach past the branch row's own (dynamic, unmeasured) height,
   not just the flex gap immediately beside itself. No explicit width/height: this wrapper's own
   box shrink-wraps to `.thread-branch-row`'s real rendered footprint exactly as that row did
   un-wrapped before (see template's own doc comment) — this only changes the positioning context
   for `.thread-fork-connector--spanning`, not this run's layout/sizing. */
.thread-branch-group {
  position: relative;
}
/* Same visual line/arrowhead as the plain `.thread-fork-connector` above (shares its
   `::before`/`::after` rules unchanged — those are keyed off `.thread-fork-connector`, not this
   modifier, and both apply together via the template's dual class binding) but taken out of flex
   flow and stretched to cover `.thread-branch-group`'s own full height instead of a fixed
   1.25rem box, so the line runs the branch row's entire (dynamic) height rather than stopping at
   the near edge. `height: auto` (overriding the base rule's fixed `1.25rem`) is load-bearing: an
   absolutely positioned box with `top`/`bottom` both set only stretches to fill the gap between
   them when `height` doesn't also pin it, per CSS's over-constrained-box resolution rules. */
.thread-fork-connector--spanning {
  position: absolute;
  top: 0;
  bottom: 0;
  height: auto;
}
/* FR-005b: the branch row for one fork point — a SEPARATE block below the run-card (never a
   flex-row sibling of the continuation; see this file's own top doc comment), indented via its own
   `margin-left` (`branchRowStyle`, script — a FIXED per-depth constant, not anything measured or
   dependent on a sibling). `flex-wrap` is deliberately omitted on the row itself — columns never
   wrap to a second row no matter how many siblings share one fork point; the row instead just grows
   as wide as it needs (no `max-width`, no `overflow-x` of its own — removed per explicit request so
   3+ column fans render fully visible side by side rather than behind a row-local scrollbar). If
   that makes the row wider than the viewport, `ThreadModeView.vue`'s own `.thread-mode-list`
   page-level `overflow-x: auto` still picks up the scroll. The `--thread-branch-fan-gap` custom
   property comes from the inline `branchRowStyle` rather than a static rule here, since
   `BRANCH_COLUMN_GAP_PX` is the single source of truth for spacing between sibling columns. */
.thread-branch-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--thread-branch-fan-gap, 2rem);
  padding-bottom: 2px;
}
/* Exactly one active child at this fork point. `flex: 0 0 auto` so the column never shrinks below
   its own nested `ThreadCard`'s fixed width (its own `.thread-node` CSS rule). No connector line
   between this run and the child branch below it — removed per explicit request: the flat card
   width and unconstrained row width already make the parent/child relationship visually obvious
   without one. */
.thread-branch-fork {
  flex: 0 0 auto;
}
/* Two or more active children at this fork point: one column per child instead of the
   single-branch `.thread-branch-fork` above. `flex: 0 0 auto` so a column never shrinks below its
   own nested `ThreadCard`'s fixed width (its own `.thread-node` CSS rule) — the whole point of
   removing the row's own width cap is that columns keep their real width and the row grows, rather
   than columns silently squashing to fit. No connector line between columns or down into each
   child — removed per explicit request, same reasoning as `.thread-branch-fork` above. */
.thread-branch-column {
  flex: 0 0 auto;
}
</style>
