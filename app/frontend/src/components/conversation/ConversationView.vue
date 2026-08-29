<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useConversationsStore, type ConversationMessageState } from '../../stores/conversations.js';
import { useEditsStore } from '../../stores/edits.js';
import { ApiError } from '../../transport/http-client.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import { clamp, useResizeHandle } from '../../composables/useResizeHandle.js';
import { loadPaneSizes, persistPaneSizes } from '../../composables/panePersistence.js';
import MessageBubble from './MessageBubble.vue';
import EditsList from '../edits/EditsList.vue';

const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
const store = useConversationsStore();
const editsStore = useEditsStore();

const draft = ref('');
const sending = ref(false);
const closing = ref(false);
const closeError = ref<string | null>(null);
const listRef = ref<HTMLDivElement | null>(null);

// FR-034: the close dialog offers folding a compact summary into the parent, separately from
// closing itself. `foldSummaryIntoParent` defaults to unchecked (http-api.md: request default is
// `false`).
const closeDialogOpen = ref(false);
const foldSummaryIntoParent = ref(false);
const closeDialogEl = ref<HTMLElement | null>(null);

// FR-043d: opening the close-confirmation dialog moves focus to its first control; Escape (or
// Cancel) returns focus to the "Close" button that opened it.
useFocusTrap(closeDialogEl, closeDialogOpen, { onEscape: () => cancelCloseDialog() });

const reviewing = ref(false);
const reviewError = ref<string | null>(null);

// FR-007a: a small, unobtrusive, dismiss-once hint pointing at the proposal-based editing path —
// stored globally (not per-conversation) so dismissing it once keeps it out of the way everywhere.
const DIRECT_EDIT_HINT_KEY = 'raidr:directEditHintDismissed';
const directEditHintDismissed = ref(localStorage.getItem(DIRECT_EDIT_HINT_KEY) === '1');
function dismissDirectEditHint(): void {
  directEditHintDismissed.value = true;
  localStorage.setItem(DIRECT_EDIT_HINT_KEY, '1');
}

const messages = computed(() => store.messagesFor(props.conversationId));
const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);

// ---------------------------------------------------------------------------------------------
// New: a vertical, draggable/keyboard-operable split between the message transcript and the
// proposed-edits list below it, reusing the same `useResizeHandle`/`panePersistence` composables
// as App.vue's splits (see App.vue for the shared drag/keyboard/localStorage logic). This split
// has to fill whatever height ConversationView is actually given by its parent (App.vue's
// sidebar) rather than assume a fixed viewport height — `.transcript-edits` is a flex child of
// `.conversation-view` (flex: 1; min-height: 0) so it always sizes to that available space, and
// the `fr` math below is computed against its own `getBoundingClientRect()`, not the viewport's.
// ---------------------------------------------------------------------------------------------
const DEFAULT_TRANSCRIPT_FR = 3;
const DEFAULT_EDITS_FR = 2;
const MIN_TRANSCRIPT_PX = 120;
const MIN_EDITS_PX = 100;
const EDITS_HANDLE_SPACE_PX = 6;

const initialSplit = loadPaneSizes({ transcriptFr: DEFAULT_TRANSCRIPT_FR, editsFr: DEFAULT_EDITS_FR });
const transcriptFr = ref(initialSplit.transcriptFr);
const editsFr = ref(initialSplit.editsFr);
const transcriptEditsEl = ref<HTMLDivElement | null>(null);

/** Hides (and makes unreachable) the drag handle when there is nothing to resize — a conversation
 *  with zero proposed edits ever (see EditsList.vue's own "No proposed edits yet." empty state) —
 *  rather than let it split the transcript against dead space. */
const hasEdits = computed(() => editsStore.editsFor(props.conversationId).length > 0);

const transcriptEditsStyle = computed(() => {
  if (!hasEdits.value) return undefined;
  return { gridTemplateRows: `${transcriptFr.value}fr ${EDITS_HANDLE_SPACE_PX}px ${editsFr.value}fr` };
});

const editsResize = useResizeHandle({
  axis: 'vertical',
  containerEl: transcriptEditsEl,
  beginGesture: (containerRect) => {
    const startTranscriptFr = transcriptFr.value;
    const totalFr = startTranscriptFr + editsFr.value;
    const remainingPx = containerRect.height - EDITS_HANDLE_SPACE_PX;
    const startTranscriptPx = remainingPx * (startTranscriptFr / totalFr);
    return (deltaPx) => {
      const nextTranscriptPx = clamp(
        startTranscriptPx + deltaPx,
        MIN_TRANSCRIPT_PX,
        Math.max(MIN_TRANSCRIPT_PX, remainingPx - MIN_EDITS_PX),
      );
      transcriptFr.value = (nextTranscriptPx / remainingPx) * totalFr;
      editsFr.value = totalFr - transcriptFr.value;
    };
  },
  onSettle: () => persistPaneSizes({ transcriptFr: transcriptFr.value, editsFr: editsFr.value }),
});

// FR-007c: the auto-generated branch-seed message (ConversationService's `branch()`) is sent
// through the ordinary user-message path — its role is genuinely 'user' (relied on by
// `.message-bubble[data-role="user"]` elsewhere, e.g. tests/e2e/us3.spec.ts) — so this is a
// display-only heuristic that recognizes it by its fixed template and position rather than a
// dedicated flag, and renders it as a distinct context card instead of a normal "You" bubble.
const BRANCH_SEED_PREFIXES = [
  'Here is the passage this conversation was branched from',
  'This conversation was branched from "',
];
function isSeedMessage(message: ConversationMessageState, index: number): boolean {
  return (
    index === 0 &&
    message.role === 'user' &&
    conversation.value?.kind === 'branch' &&
    BRANCH_SEED_PREFIXES.some((prefix) => message.text.startsWith(prefix))
  );
}

/** FR-007h: "1 pending proposal" vs "N pending proposals" — used both for the upfront
 *  close-dialog notice and the post-failure error banner. */
function pendingProposalPhrase(count: number): string {
  return `${count} pending proposal${count === 1 ? '' : 's'}`;
}
/** FR-034: set once a fold summary has actually been delivered into this conversation (as the
 *  parent of a conversation that closed with "Fold summary" enabled) — see conversations.ts's
 *  `conversation_summary_folded` handler. */
const foldedSummary = computed(() => store.foldedSummaries[props.conversationId] ?? null);

function load(): void {
  void store.loadDetail(props.conversationId);
}

onMounted(load);
watch(() => props.conversationId, load);

watch(
  messages,
  async () => {
    await nextTick();
    listRef.value?.scrollTo({ top: listRef.value.scrollHeight });
  },
  { deep: true },
);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value || conversation.value?.status === 'closed') return;
  draft.value = '';
  sending.value = true;
  try {
    await store.send(props.conversationId, text);
  } finally {
    sending.value = false;
  }
}

/** FR-018: refresh this conversation's context to the current document revision, then send. */
async function onRefreshSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value || conversation.value?.status === 'closed') return;
  draft.value = '';
  sending.value = true;
  try {
    await store.refreshAndSend(props.conversationId, text);
  } finally {
    sending.value = false;
  }
}

/** FR-043a: plain Enter sends as before; Ctrl/Cmd+Enter is the keyboard-operable equivalent of
 *  the "Refresh + Send" button below. Shift/Alt+Enter fall through to the textarea's default
 *  newline behaviour, unchanged. */
function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    void onRefreshSend();
    return;
  }
  if (!event.shiftKey && !event.altKey) {
    event.preventDefault();
    void onSend();
  }
}

async function onRetry(): Promise<void> {
  await store.retry(props.conversationId);
}

/** Opens the close confirmation dialog, which separately offers folding a compact summary into
 *  the parent conversation (FR-034) — closing and folding are two distinct decisions. */
function openCloseDialog(): void {
  closeError.value = null;
  foldSummaryIntoParent.value = false;
  closeDialogOpen.value = true;
}

function cancelCloseDialog(): void {
  closeDialogOpen.value = false;
}

/** FR-033: refused while any proposal is pending — surfaced inline rather than thrown away, so
 * the user sees exactly why (naming the count, per PENDING_EDITS_BLOCK_CLOSE's `details`). */
async function confirmClose(): Promise<void> {
  closeError.value = null;
  closing.value = true;
  try {
    await store.close(props.conversationId, foldSummaryIntoParent.value);
    closeDialogOpen.value = false;
  } catch (err) {
    // Dismiss the dialog on failure too (FR-033): the error (e.g. pending proposals blocking
    // close) is surfaced in the main view's banner, not inside the now-irrelevant confirmation
    // dialog, and leaving the dialog's overlay open would block the very controls (Accept/Drop)
    // the user needs to resolve it.
    closeDialogOpen.value = false;
    if (err instanceof ApiError && err.code === 'PENDING_EDITS_BLOCK_CLOSE') {
      // FR-007h: build our own properly-pluralized message from `details.pendingEditIds` rather
      // than surfacing the backend's raw "N proposal(s)" string verbatim.
      const ids = err.details?.pendingEditIds;
      closeError.value = Array.isArray(ids)
        ? `Cannot close: ${pendingProposalPhrase(ids.length)} must be resolved first.`
        : err.message;
    } else {
      closeError.value = err instanceof Error ? err.message : 'Failed to close conversation.';
    }
  } finally {
    closing.value = false;
  }
}

/** FR-036: request an independent review of this closed conversation and its branches, then
 *  navigate to the newly created `kind: 'review'` conversation. */
async function onRequestReview(): Promise<void> {
  reviewError.value = null;
  reviewing.value = true;
  try {
    const result = await store.review(props.conversationId);
    emit('select', result.conversation.id);
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : 'Failed to request review.';
  } finally {
    reviewing.value = false;
  }
}
</script>

<template>
  <section class="conversation-view" aria-label="Conversation">
    <header class="conversation-header">
      <div class="header-titles">
        <span class="pane-eyebrow">Conversation</span>
        <h2>{{ conversation?.name ?? 'Conversation' }}</h2>
      </div>
      <span v-if="conversation" class="badge status-badge" :data-status="conversation.status">{{
        conversation.status
      }}</span>
      <button
        v-if="conversation && conversation.kind !== 'main' && conversation.status !== 'closed'"
        type="button"
        class="close-button"
        :disabled="closing"
        @click="openCloseDialog"
      >
        Close
      </button>
      <button
        v-if="conversation?.status === 'closed'"
        type="button"
        class="review-button"
        :disabled="reviewing"
        @click="onRequestReview"
      >
        Request review
      </button>
    </header>

    <!-- FR-035: closed conversations remain fully viewable but are read-only — no reopen, no
         branch, no Primary, no send/refresh-send (all gated below by conversation.status). -->
    <div v-if="conversation?.status === 'closed'" class="readonly-banner" role="status">
      This conversation is closed and read-only. Its history and proposals remain visible, but it
      cannot be reopened, branched from, or made Primary.
    </div>

    <div v-if="closeError" class="error-banner" role="alert">{{ closeError }}</div>
    <div v-if="reviewError" class="error-banner" role="alert">{{ reviewError }}</div>

    <div v-if="foldedSummary" class="folded-summary-banner" role="status">
      <strong>Folded summary received:</strong>
      <pre>{{ foldedSummary.summary }}</pre>
    </div>

    <div ref="transcriptEditsEl" class="transcript-edits" :style="transcriptEditsStyle">
      <div ref="listRef" class="message-list" role="log" aria-live="polite" aria-relevant="additions">
        <MessageBubble
          v-for="(msg, index) in messages"
          :key="msg.id"
          :message="msg"
          :seed="isSeedMessage(msg, index)"
        />
      </div>
      <div
        v-if="hasEdits"
        class="resize-handle resize-handle--vertical"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize transcript and proposed edits"
        tabindex="0"
        @pointerdown="editsResize.startDrag($event)"
        @keydown="editsResize.onKeydown($event)"
      ></div>
      <EditsList :conversation-id="conversationId" />
    </div>

    <div v-if="conversation?.status === 'errored'" class="error-banner" role="alert">
      <span>{{ conversation.errorMessage ?? 'The agent hit an error.' }}</span>
      <button type="button" @click="onRetry">Retry</button>
    </div>

    <div v-if="!directEditHintDismissed" class="composer-hint">
      <span>
        Tip: highlight text in the document and click "Start conversation from selection" to get a
        reviewable edit proposal instead of a direct answer.
      </span>
      <button type="button" class="dismiss-notice-button" aria-label="Dismiss tip" @click="dismissDirectEditHint">
        Got it
      </button>
    </div>

    <form class="composer" @submit.prevent="onSend">
      <label class="visually-hidden" :for="`composer-${conversationId}`">Message {{ conversation?.name }}</label>
      <textarea
        :id="`composer-${conversationId}`"
        v-model="draft"
        :disabled="conversation?.status === 'closed'"
        placeholder="Ask about the document…"
        @keydown="onComposerKeydown"
      ></textarea>
      <button
        type="submit"
        class="send-button"
        title="Send this message as a direct question or instruction to the conversation."
        :disabled="!draft.trim() || sending || conversation?.status === 'closed' || conversation?.status === 'working'"
      >
        {{ conversation?.status === 'working' ? 'Sending…' : 'Send' }}
      </button>
      <button
        type="button"
        class="refresh-send-button"
        :class="{ emphasized: conversation?.isStale }"
        title="Refresh this conversation's context to the latest document revision, then send — use this when the document has changed since this conversation last saw it (Ctrl+Enter)."
        :disabled="!draft.trim() || sending || conversation?.status === 'closed' || conversation?.status === 'working'"
        @click="onRefreshSend"
      >
        Refresh + Send
      </button>
    </form>

    <div v-if="closeDialogOpen" class="modal-overlay close-dialog-overlay">
      <div ref="closeDialogEl" class="close-dialog" role="alertdialog" aria-modal="true" aria-label="Close conversation">
        <p>Close "{{ conversation?.name }}"? This cannot be undone.</p>
        <p v-if="conversation && conversation.pendingEditCount > 0" class="pending-warning" role="alert">
          This conversation has {{ pendingProposalPhrase(conversation.pendingEditCount) }}; resolve
          {{ conversation.pendingEditCount === 1 ? 'it' : 'them' }} before closing.
        </p>
        <label class="fold-summary-option">
          <input v-model="foldSummaryIntoParent" type="checkbox" />
          Fold a compact summary into the parent conversation
        </label>
        <div class="close-dialog-actions">
          <button type="button" :disabled="closing" @click="confirmClose">Close conversation</button>
          <button type="button" :disabled="closing" @click="cancelCloseDialog">Cancel</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.conversation-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.conversation-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid var(--border-color, #ddd);
  /* Fix 2: a surface distinct from the HUD above it and the transcript below it. */
  background: var(--panel-bg-alt, #eef0f3);
}
.header-titles {
  display: flex;
  flex-direction: column;
  margin-right: auto;
  min-width: 0;
}
/* .pane-eyebrow's shared text styling now lives in style.css. */
.conversation-header h2 {
  margin: 0;
  font-size: 1rem;
}
.status-badge[data-status='idle'] {
  color: var(--neutral-muted-color, #4b5563);
}
.status-badge[data-status='working'] {
  color: var(--status-active-color, #1d4ed8);
}
.status-badge[data-status='errored'] {
  color: var(--danger-color, #b91c1c);
}
.status-badge[data-status='closed'] {
  color: var(--status-closed-color, #374151);
}
/* New: `.transcript-edits` is a flex child of `.conversation-view` (flex: 1; min-height: 0) so it
   always fills whatever height this component is actually given, never a fixed viewport amount.
   It's a grid with a default `1fr auto` row template — transcript takes all remaining space,
   EditsList sizes to its own (small) empty-state content — for when there's nothing to resize
   (no proposed edits yet, see `hasEdits`); `transcriptEditsStyle` overrides that with an explicit
   `fr` split, once there's a proposed-edits list worth splitting against. */
.transcript-edits {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: 1fr auto;
}
.message-list {
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
}
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger-color, #991b1b);
}
.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border-color, #ddd);
}
.composer textarea {
  flex: 1;
  resize: vertical;
  min-height: 2.5rem;
}
.composer-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--info-bg, #eff6ff);
  color: var(--info-color, #1e3a8a);
  border-top: 1px solid var(--info-border, #bfdbfe);
  font-size: 0.75rem;
}
.dismiss-notice-button {
  flex: 0 0 auto;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
/* New: draggable, keyboard-operable resize handle between the transcript and proposed-edits list
   — same look/behaviour as App.vue's `.resize-handle--vertical` (a separate, identically-named
   rule here since each `<style scoped>` block is its own component). */
.resize-handle {
  position: relative;
  touch-action: none;
  background: transparent;
}
.resize-handle--vertical {
  cursor: row-resize;
}
.resize-handle--vertical::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: var(--border-color, #ccc);
}
.resize-handle--vertical:hover::after,
.resize-handle--vertical:focus-visible::after {
  background: var(--accent-color, #2563eb);
  height: 4px;
}
.resize-handle:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: -2px;
}
/* Contrast fix: relying on the browser's native (color-scheme-driven) button-face background for
   text-color contrast math is fragile — dark mode's native button face isn't reliably dark enough
   for light/bright accent text (measured well below 4.5:1). Both composer buttons get an explicit
   background from the token system instead, in every state, so contrast never depends on the
   browser's own button rendering. */
.send-button,
.refresh-send-button {
  background: var(--panel-bg-alt, #eef0f3);
  color: var(--text-color, #111);
  border: 1px solid var(--border-color, #ccc);
}
.send-button:disabled,
.refresh-send-button:disabled {
  background: var(--panel-bg-alt, #eef0f3);
  color: var(--neutral-muted-color, #4b5563);
  border-color: var(--border-color, #ccc);
}
.refresh-send-button.emphasized {
  font-weight: 700;
  border-color: var(--warning-color, #92400e);
  color: var(--warning-color, #92400e);
}
.pending-warning {
  padding: 0.4rem 0.6rem;
  background: var(--warning-bg, #fef3c7);
  color: var(--warning-color, #92400e);
  border-radius: 4px;
  font-size: 0.85rem;
}
.readonly-banner {
  padding: 0.5rem 0.75rem;
  background: var(--seed-bg, #f3f4f6);
  color: var(--status-closed-color, #374151);
  font-size: 0.85rem;
}
.folded-summary-banner {
  padding: 0.5rem 0.75rem;
  background: var(--success-bg, #ecfdf5);
  color: var(--success-color, #065f46);
  font-size: 0.8rem;
}
.folded-summary-banner pre {
  white-space: pre-wrap;
  margin: 0.35rem 0 0;
  font-family: inherit;
}
.close-dialog-overlay {
  z-index: 60;
}
.close-dialog {
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1rem;
  max-width: 22rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.fold-summary-option {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  margin: 0.75rem 0;
}
.close-dialog-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
