<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import MessageBubble from './MessageBubble.vue';

const props = defineProps<{ conversationId: string }>();
const store = useConversationsStore();

const draft = ref('');
const sending = ref(false);
const listRef = ref<HTMLDivElement | null>(null);

const messages = computed(() => store.messagesFor(props.conversationId));
const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);

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

async function onRetry(): Promise<void> {
  await store.retry(props.conversationId);
}
</script>

<template>
  <section class="conversation-view" aria-label="Conversation">
    <header class="conversation-header">
      <h2>{{ conversation?.name ?? 'Conversation' }}</h2>
      <span v-if="conversation" class="badge" :data-status="conversation.status">{{ conversation.status }}</span>
    </header>

    <div ref="listRef" class="message-list" role="log" aria-live="polite" aria-relevant="additions">
      <MessageBubble v-for="msg in messages" :key="msg.id" :message="msg" />
    </div>

    <div v-if="conversation?.status === 'errored'" class="error-banner" role="alert">
      <span>{{ conversation.errorMessage ?? 'The agent hit an error.' }}</span>
      <button type="button" @click="onRetry">Retry</button>
    </div>

    <form class="composer" @submit.prevent="onSend">
      <label class="visually-hidden" :for="`composer-${conversationId}`">Message {{ conversation?.name }}</label>
      <textarea
        :id="`composer-${conversationId}`"
        v-model="draft"
        :disabled="conversation?.status === 'closed'"
        placeholder="Ask about the document…"
        @keydown.enter.exact.prevent="onSend"
      ></textarea>
      <button type="submit" :disabled="!draft.trim() || sending || conversation?.status === 'closed'">Send</button>
    </form>
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
</style>
