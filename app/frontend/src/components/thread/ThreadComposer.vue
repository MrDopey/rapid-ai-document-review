<script setup lang="ts">
import { computed, ref } from 'vue';
import { useThreadStore } from '../../stores/thread.js';

/**
 * 011-linear-thread-mode (FR-005c): the send box mounted on exactly one segment per Thread —
 * whichever `ThreadCard.vue` resolves as `isTipSegment: true` (`useThreadSegments.ts`). Every
 * earlier, already-split-off segment renders no composer at all; this component's own existence on
 * the page is itself the enforcement of "only a Thread's current tip may accept a new message".
 * Deliberately simpler than `ConversationView.vue`'s composer (no Refresh+Send/Retry/Close — none
 * of those canvas-mode concepts apply to a Thread, per FR-015's "reuse... except where this
 * feature's requirements explicitly call for different behavior").
 */
const props = defineProps<{ threadId: string; disabled?: boolean }>();

const store = useThreadStore();
const sending = ref(false);
// Surfaced the same way as every other action failure in this app (`.error-banner`, style.css) —
// previously the draft was cleared before `store.send` resolved with no `catch` at all, so a failed
// send (dropped network, a 409 race, …) silently discarded whatever the reviewer had just typed.
const sendError = ref<string | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

// Backed by `store.draftByThread` (not a local `ref`) so "Quote from here" (`ThreadCard.vue`'s
// `onQuoteFromSelection`, via `store.quoteHighlightIntoComposer`) — a sibling component, not an
// ancestor with direct access to this component's internals — has somewhere to seed the quoted
// excerpt into. See `draftByThread`'s own doc comment in `stores/thread.ts`.
const draft = computed({
  get: () => store.draftByThread[props.threadId] ?? '',
  set: (value: string) => store.setThreadDraft(props.threadId, value),
});

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value || props.disabled) return;
  sending.value = true;
  sendError.value = null;
  try {
    await store.send(props.threadId, text);
    // Only cleared once the send actually succeeds — on failure the draft (still holding `text`)
    // is left exactly as the reviewer typed it, matching the restore behaviour below.
    draft.value = '';
  } catch (err) {
    draft.value = text;
    sendError.value = err instanceof Error ? err.message : 'Failed to send message.';
  } finally {
    sending.value = false;
  }
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  event.preventDefault();
  void onSend();
}

// Called by `ThreadCard.vue` right after "Quote from here" seeds this thread's draft, so the
// reviewer lands with their cursor ready to type their own follow-up rather than having to click
// into the textarea themselves.
defineExpose({ focus: () => textareaRef.value?.focus() });
</script>

<template>
  <div v-if="sendError" class="error-banner" role="alert">
    {{ sendError }}
  </div>
  <form class="thread-composer" @submit.prevent="onSend">
    <label class="visually-hidden" :for="`thread-composer-${threadId}`">Continue this thread</label>
    <textarea
      :id="`thread-composer-${threadId}`"
      ref="textareaRef"
      v-model="draft"
      placeholder="Continue this thread…"
      :disabled="disabled || sending"
      @keydown="onComposerKeydown"
    />
    <button
      type="submit"
      class="thread-send-button"
      :disabled="!draft.trim() || sending || disabled"
    >
      {{ sending ? 'Sending…' : 'Send' }}
    </button>
  </form>
</template>

<style scoped>
.thread-composer {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
  padding: 0.4rem 0;
}
.thread-composer textarea {
  flex: 1 1 auto;
  min-height: 4.8rem;
  min-block-size: 3lh;
  field-sizing: content;
  resize: vertical;
  font: inherit;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 6px;
  background: var(--panel-bg, #f7f7f8);
  color: inherit;
}
.thread-send-button {
  flex: 0 0 auto;
}
</style>
