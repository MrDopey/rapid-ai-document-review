<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { PendingProposalReconciliationEntry } from '@rapid-ai-document-review/shared/contracts/http';
import { useDocumentStore } from '../../stores/document.js';
import { useConversationsStore } from '../../stores/conversations.js';
import { useEditsStore } from '../../stores/edits.js';

const emit = defineEmits<{ (e: 'close'): void }>();

const store = useDocumentStore();
const conversationsStore = useConversationsStore();
const editsStore = useEditsStore();

/** Set only right after a restore whose response included `pendingProposalReconciliation`
 *  (http-api.md §POST /revisions/:revision/restore) — purely informational: the restore has
 *  already committed by the time this is shown, and nothing here changes any proposal's status. */
const restoreReconciliation = ref<PendingProposalReconciliationEntry[] | null>(null);

onMounted(() => {
  if (store.revisions.length === 0) {
    void store.loadRevisions();
  }
});

async function onRestore(revision: number): Promise<void> {
  const result = await store.restore(revision);
  const entries = result.pendingProposalReconciliation ?? [];
  if (entries.length === 0) {
    restoreReconciliation.value = null;
    return;
  }
  // Best-effort labelling: load edit lists for every conversation with pending proposals so each
  // entry below can be shown by summary/conversation rather than a bare id. A normal GET, same as
  // opening that conversation would trigger — never mutates any proposal's status.
  await Promise.all(
    conversationsStore.conversations.filter((c) => c.pendingEditCount > 0).map((c) => editsStore.load(c.id)),
  );
  restoreReconciliation.value = entries;
}

function dismissReconciliation(): void {
  restoreReconciliation.value = null;
}

function describeProposal(stagedEditId: string): { summary: string; conversationName: string } | null {
  for (const conversation of conversationsStore.conversations) {
    const edit = (editsStore.byConversation[conversation.id] ?? []).find((e) => e.id === stagedEditId);
    if (edit) return { summary: edit.summary, conversationName: conversation.name };
  }
  return null;
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
  <div class="history-panel" role="region" aria-label="Revision history">
    <div class="history-panel-header">
      <h2>History</h2>
      <button type="button" class="close-drawer-button" aria-label="Dismiss panel" @click="emit('close')">
        Close
      </button>
    </div>
    <div v-if="restoreReconciliation" class="reconciliation-panel" role="status">
      <div class="reconciliation-header">
        <strong>Pending proposals after this restore</strong>
        <button type="button" @click="dismissReconciliation">Dismiss</button>
      </div>
      <p>
        The restore is complete. These proposals from other conversations were checked against the
        restored content — this is informational only and has not changed any proposal's status;
        decide per-proposal whether to keep waiting, apply, or drop it.
      </p>
      <ul class="reconciliation-list">
        <li v-for="entry in restoreReconciliation" :key="entry.stagedEditId" :data-reconcilable="entry.reconcilable">
          <span class="badge" :data-reconcilable="entry.reconcilable">
            {{ entry.reconcilable ? 'Still applies' : 'No longer applies' }}
          </span>
          <template v-if="describeProposal(entry.stagedEditId)">
            <span class="summary-text">{{ describeProposal(entry.stagedEditId)!.summary }}</span>
            <span class="conversation-name">({{ describeProposal(entry.stagedEditId)!.conversationName }})</span>
          </template>
          <span v-else class="summary-text">Proposal {{ entry.stagedEditId.slice(0, 12) }}…</span>
        </li>
      </ul>
    </div>
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
  /* Fix 2: a distinct panel surface, self-contained even when this component is used outside the
     App.vue drawer overlay that also sets this background. */
  background: var(--panel-bg, #f7f7f8);
}
.history-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 2px solid var(--border-color, #ddd);
}
.history-panel-header h2 {
  margin: 0;
}
.close-drawer-button {
  font-size: 0.8rem;
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
.reconciliation-panel {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  padding: 0.5rem;
  margin-bottom: 0.75rem;
}
.reconciliation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.reconciliation-list {
  padding: 0;
  margin: 0.5rem 0 0;
}
.reconciliation-list li {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0;
}
.reconciliation-list .badge[data-reconcilable='true'] {
  color: var(--success-color, #1a7f37);
  border-color: currentColor;
}
.reconciliation-list .badge[data-reconcilable='false'] {
  color: var(--danger-color, #b3261e);
  border-color: currentColor;
}
</style>
