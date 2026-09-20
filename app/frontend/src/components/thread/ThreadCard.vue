<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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
 * `ThreadCard` per child, indented one level deeper (`depth + 1`) — since there is exactly one root
 * Thread per document (FR-003), the whole document's Thread tree renders from a single top-level
 * `ThreadModeView.vue` invocation of this component. Only the final segment of a Thread
 * (`isTipSegment`) ever mounts `ThreadComposer` (FR-005c); every earlier segment offers only
 * highlight-to-branch (`HighlightBranchMenu`).
 */
const props = withDefaults(defineProps<{ threadId: string; depth?: number }>(), { depth: 0 });

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

// ---------------------------------------------------------------------------------------------
// Highlight-to-branch (FR-005/FR-005a). Suppressed only on the Thread's actual current tip
// MESSAGE (`tipMessageId`) — not the whole tip segment — matching FR-007's literal "N-1, N-2, or
// any earlier message are all valid" (an earlier message inside the still-open tip segment is a
// perfectly valid anchor) and the backend's own `ANCHOR_IS_TIP` check, which is keyed on the exact
// message id, not the segment.
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

function onMessageMouseUp(messageId: string): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || messageId === tipMessageId.value || sel!.rangeCount === 0) {
    selection.value = null;
    return;
  }
  const rect = sel!.getRangeAt(0).getBoundingClientRect();
  selection.value = { messageId, text, x: rect.left + rect.width / 2, y: rect.top };
}

function dismissSelection(): void {
  selection.value = null;
}

async function onBranchFromSelection(): Promise<void> {
  if (!selection.value || thread.value?.status === 'closed') return;
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
</script>

<template>
  <article
    v-if="thread"
    class="thread-card"
    :data-thread-id="threadId"
    :data-thread-kind="thread.kind"
  >
    <header class="thread-card-header">
      <span class="thread-card-title text-wrap-safe">{{ thread.name }}</span>
      <span v-if="thread.kind === 'thread-root'" class="thread-root-badge">Root</span>
      <span class="thread-card-actions">
        <ConversationActionButtons :actions="doneActions" />
      </span>
    </header>
    <span v-if="doneError" class="thread-error" role="alert">{{ doneError }}</span>

    <!-- `useThreadSegments` returns no segments at all for a Thread with zero messages yet (a
         freshly created root — thread-branches always get an auto-seeded first message) — without
         this, a brand-new Thread could never render a composer to send its own first message. -->
    <ThreadComposer
      v-if="messages.length === 0"
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
        :thread-id="threadId"
        :disabled="thread.doneAt !== null"
      />

      <div
        v-for="childId in activeChildIds(segment.childBranchIds)"
        :key="childId"
        class="thread-branch-fork"
      >
        <ThreadCard :thread-id="childId" :depth="depth + 1" />
      </div>
    </div>

    <span v-if="branchError" class="thread-error" role="alert">{{ branchError }}</span>

    <HighlightBranchMenu
      v-if="selection"
      :x="selection.x"
      :y="selection.y"
      :highlighted-text="selection.text"
      :pending="branching"
      @branch="onBranchFromSelection"
      @dismiss="dismissSelection"
    />
  </article>
</template>

<style scoped>
.thread-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 8px;
  background: var(--panel-bg, #f7f7f8);
}
.thread-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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
/* FR-005b: each branch renders indented to the right of the segment it forks from, so it's
   visually distinguishable from the source thread's own continuation at a glance. */
.thread-branch-fork {
  margin: 0.4rem 0 0 1.5rem;
  padding-left: 0.75rem;
  border-left: 2px solid var(--border-color, #ccc);
}
</style>
