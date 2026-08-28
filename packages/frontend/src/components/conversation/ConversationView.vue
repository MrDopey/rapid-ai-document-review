<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { ApiError } from '../../transport/http-client.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import MessageBubble from './MessageBubble.vue';
import EditsList from '../edits/EditsList.vue';

const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
const store = useConversationsStore();

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

const messages = computed(() => store.messagesFor(props.conversationId));
const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);
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
      closeError.value = err.message;
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
      <h2>{{ conversation?.name ?? 'Conversation' }}</h2>
      <span v-if="conversation" class="badge" :data-status="conversation.status">{{ conversation.status }}</span>
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

    <div ref="listRef" class="message-list" role="log" aria-live="polite" aria-relevant="additions">
      <MessageBubble v-for="msg in messages" :key="msg.id" :message="msg" />
    </div>

    <div v-if="conversation?.status === 'errored'" class="error-banner" role="alert">
      <span>{{ conversation.errorMessage ?? 'The agent hit an error.' }}</span>
      <button type="button" @click="onRetry">Retry</button>
    </div>

    <EditsList :conversation-id="conversationId" />

    <form class="composer" @submit.prevent="onSend">
      <label class="visually-hidden" :for="`composer-${conversationId}`">Message {{ conversation?.name }}</label>
      <textarea
        :id="`composer-${conversationId}`"
        v-model="draft"
        :disabled="conversation?.status === 'closed'"
        placeholder="Ask about the document…"
        @keydown="onComposerKeydown"
      ></textarea>
      <button type="submit" :disabled="!draft.trim() || sending || conversation?.status === 'closed'">Send</button>
      <button
        type="button"
        title="Refresh context to the latest document revision, then send (Ctrl+Enter)"
        :disabled="!draft.trim() || sending || conversation?.status === 'closed'"
        @click="onRefreshSend"
      >
        Refresh + Send
      </button>
    </form>

    <div v-if="closeDialogOpen" class="close-dialog-overlay">
      <div ref="closeDialogEl" class="close-dialog" role="alertdialog" aria-modal="true" aria-label="Close conversation">
        <p>Close "{{ conversation?.name }}"? This cannot be undone.</p>
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
  border-bottom: 1px solid var(--border-color, #ddd);
}
.conversation-header h2 {
  margin: 0;
  font-size: 1rem;
}
.badge {
  border-radius: 4px;
  padding: 0 0.35rem;
  font-size: 0.7rem;
  border: 1px solid currentColor;
}
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
}
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #fee2e2;
  color: #991b1b;
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
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.readonly-banner {
  padding: 0.5rem 0.75rem;
  background: #f3f4f6;
  color: #374151;
  font-size: 0.85rem;
}
.folded-summary-banner {
  padding: 0.5rem 0.75rem;
  background: #ecfdf5;
  color: #065f46;
  font-size: 0.8rem;
}
.folded-summary-banner pre {
  white-space: pre-wrap;
  margin: 0.35rem 0 0;
  font-family: inherit;
}
.close-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
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
