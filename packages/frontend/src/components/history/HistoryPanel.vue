<script setup lang="ts">
import { onMounted } from 'vue';
import { useDocumentStore } from '../../stores/document.js';

const store = useDocumentStore();

onMounted(() => {
  if (store.revisions.length === 0) {
    void store.loadRevisions();
  }
});

async function onRestore(revision: number): Promise<void> {
  await store.restore(revision);
}

function exportUrl(revision: number): string {
  return `/api/document/export?revision=${revision}&download=1`;
}

async function onCopy(revision: number): Promise<void> {
  const text = await store.exportRevision(revision);
  await navigator.clipboard.writeText(text);
}
</script>

<template>
  <div class="history-panel" aria-label="Revision history">
    <h2>History</h2>
    <ul>
      <li v-for="rev in store.revisions" :key="rev.revision" class="history-entry">
        <div class="history-entry-header">
          <strong>v{{ rev.revision }}</strong>
          <span class="badge" :data-source="rev.source">{{ rev.source }}</span>
          <span class="origin">{{ rev.origin }}</span>
        </div>
        <div v-if="rev.conversationName" class="conversation-name">{{ rev.conversationName }}</div>
        <div v-if="rev.note" class="note">{{ rev.note }}</div>
        <time :datetime="rev.createdAt">{{ rev.createdAt }}</time>
        <div class="actions">
          <button type="button" @click="onRestore(rev.revision)">Restore</button>
          <a :href="exportUrl(rev.revision)" download>Download</a>
          <button type="button" @click="onCopy(rev.revision)">Copy</button>
        </div>
      </li>
    </ul>
    <button v-if="store.revisionsNextCursor" type="button" @click="store.loadRevisions()">
      Load more
    </button>
  </div>
</template>

<style scoped>
.history-panel {
  overflow-y: auto;
  height: 100%;
  padding: 0.5rem;
  text-align: left;
}
.history-entry {
  border-bottom: 1px solid var(--border-color, #ddd);
  padding: 0.5rem 0;
  list-style: none;
}
.history-entry-header {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.badge {
  border-radius: 4px;
  padding: 0 0.35rem;
  font-size: 0.75rem;
  border: 1px solid currentColor;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
