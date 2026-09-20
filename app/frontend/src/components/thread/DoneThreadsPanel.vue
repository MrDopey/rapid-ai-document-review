<script setup lang="ts">
import { computed } from 'vue';
import { useThreadStore } from '../../stores/thread.js';

/**
 * 011-linear-thread-mode (FR-008/FR-009, User Story 3): the "done"/history view — every
 * Thread with `doneAt !== null`, in whichever document is currently active, with a "Reopen"
 * action. Deliberately a flat list (not the segmented/nested tree `ThreadCard.vue` renders for the
 * active view) since a done Thread's own branch relationships remain fully inspectable by
 * reopening it back into the default list; this panel's job is purely "find and reopen", not a
 * second copy of the segment-splitting UI.
 */
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useThreadStore();

const doneThreads = computed(() =>
  store.threads
    .filter((t) => t.doneAt !== null)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')),
);

async function onReopen(threadId: string): Promise<void> {
  await store.reopen(threadId);
}
</script>

<template>
  <aside class="done-threads-panel dialog-box" aria-label="Done threads">
    <header class="done-threads-header">
      <h2>Done threads</h2>
      <button type="button" aria-label="Close done threads" @click="emit('close')">✕</button>
    </header>
    <p v-if="doneThreads.length === 0" class="done-threads-empty">No done threads yet.</p>
    <ul v-else class="done-threads-list">
      <li v-for="t in doneThreads" :key="t.id" class="done-thread-row">
        <span class="done-thread-name text-wrap-safe">{{ t.name }}</span>
        <button type="button" @click="onReopen(t.id)">Reopen</button>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.done-threads-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  width: min(360px, 90vw);
}
.done-threads-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.done-threads-header h2 {
  font-size: 1rem;
  margin: 0;
}
.done-threads-empty {
  color: var(--neutral-muted-color, #4b5563);
  font-size: 0.85rem;
}
.done-threads-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.done-thread-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 6px;
}
.done-thread-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
