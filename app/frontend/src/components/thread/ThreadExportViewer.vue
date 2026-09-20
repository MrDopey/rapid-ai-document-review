<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import { ApiError } from '../../transport/http-client.js';
import {
  seedExpandedForEntity,
  setExpandedForEntity,
  type ExpandedByEntity,
} from '../../composables/expandableMessages.js';
import MessageBubble from '../conversation/MessageBubble.vue';
import type { ConversationMessageState } from '../../stores/conversations.js';

/**
 * 011-linear-thread-mode, User Story 4/FR-013: a read-only viewer for a fresh, on-demand genuine
 * Pi-native session export (`GET .../threads/:id/export`, research.md R9). Renders two things,
 * both derived from the exact same export response: the parsed transcript through the same
 * `MessageBubble.vue` a live Thread already uses (FR-015 reuse — matching the thread's actual
 * message history at export time, SC-005), and the literal raw exported bytes (`jsonl`) — the
 * latter is what makes this demonstrably "the underlying Pi session export itself" (spec's "Why
 * this priority"), not only the application's own transcript view.
 *
 * Expand/collapse state is local to this viewer (a fresh export is ephemeral, data-model.md's
 * "Exported session" — nothing is cached in `useThreadStore`), but reuses the same
 * `composables/expandableMessages.ts` primitives every other message list in this mode already
 * shares, rather than a third copy of that logic.
 */
const props = defineProps<{ threadId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useThreadStore();

const thread = computed(() => store.findThread(props.threadId));

const loading = ref(true);
const error = ref<string | null>(null);
const exportedAt = ref<string | null>(null);
const jsonl = ref('');
const messages = ref<ConversationMessageState[]>([]);

// Same "Download"/"Copy" convention `HistoryPanel.vue` already uses for its own revision export
// (a plain `<a download>` anchor plus a `navigator.clipboard.writeText` button) — the one
// difference is `jsonl` already lives in memory here (this endpoint returns it inline, unlike
// `HistoryPanel.vue`'s own server-streamed `?download=1` URL), so the anchor's `href` is a `Blob`
// object URL built from that same in-memory string rather than a second network round-trip.
// Without this, the raw export text was reachable only by opening the `<details>` disclosure below
// and manually selecting/copying out of a `<pre>` — the actual underlying Pi session bytes (the
// thing that makes this genuinely "the export", not just the thread's own message view rendered a
// second time) had no real way out of the modal.
const downloadUrl = ref('');
const downloadFilename = computed(() => `thread-export-${props.threadId}.jsonl`);

async function onCopy(): Promise<void> {
  await navigator.clipboard.writeText(jsonl.value);
}

onBeforeUnmount(() => {
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value);
});

const expandedByMessage = reactive<ExpandedByEntity>({});
const EXPORT_ENTITY_ID = 'export';

function setMessageExpanded(messageId: string, expanded: boolean): void {
  setExpandedForEntity(expandedByMessage, EXPORT_ENTITY_ID, messageId, expanded);
}

onMounted(async () => {
  try {
    const result = await store.exportThread(props.threadId);
    exportedAt.value = result.exportedAt;
    jsonl.value = result.jsonl;
    downloadUrl.value = URL.createObjectURL(
      new Blob([result.jsonl], { type: 'application/x-ndjson' }),
    );
    messages.value = result.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      reasoning: m.reasoning ?? null,
      isToolCallCarrier: m.isToolCallCarrier ?? false,
      toolCalls: m.toolCalls ?? [],
      streaming: false,
      createdAt: m.createdAt,
    }));
    seedExpandedForEntity(expandedByMessage, EXPORT_ENTITY_ID, messages.value);
  } catch (err) {
    error.value =
      err instanceof ApiError && err.code === 'EMPTY_THREAD_EXPORT'
        ? 'This thread has no message history yet, so there is nothing to export.'
        : err instanceof Error
          ? err.message
          : 'Failed to export this thread.';
  } finally {
    loading.value = false;
  }
});

const expandedFor = computed(() => expandedByMessage[EXPORT_ENTITY_ID] ?? {});
</script>

<template>
  <aside class="thread-export-viewer dialog-box" aria-label="Thread export">
    <header class="thread-export-header">
      <div class="thread-export-title">
        <h2>Export — {{ thread?.name ?? 'Thread' }}</h2>
        <p class="thread-export-subtitle">
          A fresh, read-only export of this thread's underlying Pi session — not just the thread
          view rendered again.
        </p>
      </div>
      <button type="button" aria-label="Close export viewer" @click="emit('close')">✕</button>
    </header>

    <p v-if="loading" class="thread-export-status">Generating export…</p>
    <p v-else-if="error" class="thread-export-status thread-export-error" role="alert">
      {{ error }}
    </p>
    <template v-else>
      <p class="thread-export-meta">Exported {{ exportedAt }}</p>

      <div class="thread-export-actions">
        <a :href="downloadUrl" :download="downloadFilename">Download</a>
        <button type="button" @click="onCopy">Copy</button>
      </div>

      <h3 class="thread-export-section-label pane-eyebrow">Transcript</h3>
      <div class="thread-export-messages">
        <MessageBubble
          v-for="message in messages"
          :key="message.id"
          :message="message"
          :expanded="expandedFor[message.id] ?? false"
          @update:expanded="(value) => setMessageExpanded(message.id, value)"
        />
      </div>

      <details class="thread-export-raw">
        <summary>Raw Pi session export (JSONL)</summary>
        <pre class="thread-export-raw-content">{{ jsonl }}</pre>
      </details>
    </template>
  </aside>
</template>

<style scoped>
.thread-export-viewer {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem;
  width: min(560px, 90vw);
  max-height: 80vh;
  overflow-y: auto;
}
.thread-export-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.thread-export-title {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.thread-export-header h2 {
  font-size: 1rem;
  margin: 0;
}
.thread-export-subtitle {
  margin: 0;
  font-size: 0.75rem;
  color: var(--neutral-muted-color, #4b5563);
}
.thread-export-status {
  color: var(--neutral-muted-color, #4b5563);
  font-size: 0.85rem;
}
.thread-export-error {
  color: var(--danger-color, #b91c1c);
}
.thread-export-meta {
  margin: 0;
  font-size: 0.75rem;
  color: var(--neutral-muted-color, #4b5563);
}
.thread-export-actions {
  display: flex;
  gap: 0.5rem;
}
.thread-export-section-label {
  margin: 0.2rem 0 0;
}
.thread-export-messages {
  display: flex;
  flex-direction: column;
}
.thread-export-raw summary {
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.thread-export-raw-content {
  margin: 0.4rem 0 0;
  padding: 0.5rem;
  max-height: 240px;
  overflow: auto;
  font-family: monospace;
  font-size: 0.7rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--panel-bg-alt, #eef0f3);
  border: 1px solid var(--border-color, #ccc);
  border-radius: 6px;
}
</style>
