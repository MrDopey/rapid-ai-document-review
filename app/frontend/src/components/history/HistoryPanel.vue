<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { PendingProposalReconciliationEntry } from '@rapid-ai-document-review/shared/contracts/http';
import { useDocumentStore } from '../../stores/document.js';
import { useConversationsStore } from '../../stores/conversations.js';
import { useEditsStore } from '../../stores/edits.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import RevisionDiffViewer from '../diff/RevisionDiffViewer.vue';

const emit = defineEmits<{ (e: 'close'): void }>();

const store = useDocumentStore();
const conversationsStore = useConversationsStore();
const editsStore = useEditsStore();

const diffingRevision = ref<number | null>(null);

// Restore instantly overwrites the live document with no undo — every other state-changing action
// in this app (e.g. closing a conversation, ConversationView.vue's close dialog) gates behind a
// confirmation dialog first. Mirrors that same role="alertdialog"/focus-trap pattern.
const restoreDialogOpen = ref(false);
const restoreTarget = ref<number | null>(null);
const restoreDialogEl = ref<HTMLElement | null>(null);
const restoring = ref(false);

useFocusTrap(restoreDialogEl, restoreDialogOpen, { onEscape: () => cancelRestoreDialog() });

/** Set only right after a restore whose response included `pendingProposalReconciliation`
 *  (http-api.md §POST /revisions/:revision/restore) — purely informational: the restore has
 *  already committed by the time this is shown, and nothing here changes any proposal's status. */
const restoreReconciliation = ref<PendingProposalReconciliationEntry[] | null>(null);

/** Revision timestamps are stored and transmitted as UTC ISO 8601; displayed in the viewer's own
 *  timezone (the `datetime` attribute keeps the raw UTC value for assistive tech/tooling). */
function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString();
}

onMounted(() => {
  if (store.revisions.length === 0) {
    void store.loadRevisions();
  }
});

function openRestoreDialog(revision: number): void {
  restoreTarget.value = revision;
  restoreDialogOpen.value = true;
}

function cancelRestoreDialog(): void {
  restoreDialogOpen.value = false;
  restoreTarget.value = null;
}

async function confirmRestore(): Promise<void> {
  if (restoreTarget.value === null) return;
  restoring.value = true;
  try {
    await onRestore(restoreTarget.value);
  } finally {
    restoring.value = false;
    restoreDialogOpen.value = false;
    restoreTarget.value = null;
  }
}

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
            <span class="summary-text text-wrap-safe">{{ describeProposal(entry.stagedEditId)!.summary }}</span>
            <span class="conversation-name text-wrap-safe">({{ describeProposal(entry.stagedEditId)!.conversationName }})</span>
          </template>
          <span v-else class="summary-text text-wrap-safe">Proposal {{ entry.stagedEditId.slice(0, 12) }}…</span>
        </li>
      </ul>
    </div>
    <ul>
      <li v-for="rev in store.revisions" :key="rev.revision" class="history-entry">
        <div class="history-entry-header">
          <strong>v{{ rev.revision }}</strong>
          <span class="badge" :data-source="rev.source">{{ rev.source }}</span>
          <span class="origin text-wrap-safe">{{ rev.origin }}</span>
        </div>
        <div v-if="rev.conversationName" class="conversation-name text-wrap-safe">{{ rev.conversationName }}</div>
        <div v-if="rev.note" class="note text-wrap-safe">{{ rev.note }}</div>
        <time :datetime="rev.createdAt">{{ formatLocal(rev.createdAt) }}</time>
        <div class="actions">
          <button type="button" class="restore-button" @click="openRestoreDialog(rev.revision)">Restore</button>
          <a :href="exportUrl(rev.revision)" download>Download</a>
          <button type="button" @click="onCopy(rev.revision)">Copy</button>
          <button v-if="rev.revision > 1" type="button" @click="diffingRevision = rev.revision">Diff</button>
        </div>
      </li>
    </ul>
    <button v-if="store.revisionsNextCursor" type="button" @click="store.loadRevisions()">
      Load more
    </button>
    <Transition name="modal">
      <div v-if="diffingRevision !== null" class="modal-overlay diff-overlay">
        <RevisionDiffViewer
          :revision="diffingRevision"
          :previous-revision="diffingRevision - 1"
          @close="diffingRevision = null"
        />
      </div>
    </Transition>
    <div v-if="restoreDialogOpen" class="modal-overlay restore-dialog-overlay">
      <div ref="restoreDialogEl" class="restore-dialog" role="alertdialog" aria-modal="true" aria-label="Restore revision">
        <p>Restore to revision {{ restoreTarget }}? This will overwrite the current document content.</p>
        <div class="restore-dialog-actions">
          <button type="button" class="restore-button" :disabled="restoring" @click="confirmRestore">
            {{ restoring ? 'Restoring…' : 'Restore' }}
          </button>
          <button type="button" :disabled="restoring" @click="cancelRestoreDialog">Cancel</button>
        </div>
      </div>
    </div>
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
/* Fix: this entire style block previously had no overflow-wrap/min-width:0 at all, so an
   LLM-generated edit summary, a user-entered conversation name, or a `rev.note` revision note
   could overflow this fixed-width panel. `.text-wrap-safe`'s shared overflow-wrap handling
   (applied via the template class) now lives in style.css; `min-width: 0` is set here since
   `.summary-text`/`.conversation-name`/`.origin` sit inside flex rows
   (`.reconciliation-list li`/`.history-entry-header`) that would otherwise refuse to let them
   shrink below their content's intrinsic width — harmless on `.note` and the block-level
   `.conversation-name` div, neither of which is a flex item, since a plain block element's own
   default min-width is already 0. */
.summary-text,
.conversation-name,
.note,
.origin {
  min-width: 0;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
/* Restore overwrites the live document with no undo, unlike Download/Copy/Diff (all read-only) —
   danger-toned treatment (same pattern as DropAllButton.vue) so it doesn't read as an
   equally-weighted peer of the three safe actions beside it. */
.restore-button {
  background: transparent;
  border-color: var(--danger-color, #b91c1c);
  color: var(--danger-color, #b91c1c);
}
.restore-button:hover:not(:disabled) {
  background: var(--danger-bg, #fef2f2);
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
/* `.modal-overlay`'s shared base rule (see its own comment in style.css) deliberately leaves
   z-index to each caller, since overlays nest. `.diff-overlay` needs an explicit z-index here: at
   `z-index: auto`, this `position: fixed` overlay wouldn't establish its own stacking context and
   would paint in plain tree order within the page's root stacking context — where
   EditorComponent.vue's `position: sticky` `.editor-toolbar` (`--z-sticky`) DOES establish one and
   paints above any unstyled (auto) content in that same root context, regardless of DOM order,
   letting the sticky editor header render on top of this modal instead of behind it.
   It must specifically use `--z-overlay-blocking`, not `--z-overlay`: this is an independent,
   page-level "simple" modal that can be opened while a conversation is focused
   (`--z-overlay-detail`), so it must always render above that tier — `--z-overlay` sits BELOW
   `--z-overlay-detail` and would render sliced in half underneath the focused panel, with its
   Close button unclickable. `--z-overlay-blocking` (style.css `:root`) is the tier reserved for
   exactly this "must always render above everything else" case. */
.diff-overlay {
  z-index: var(--z-overlay-blocking, 70);
}
/* Same alertdialog/focus-trap pattern and z-index tier as ConversationView.vue's
   .close-dialog-overlay/.close-dialog/.close-dialog-actions — above the simple, non-nesting
   .diff-overlay above. */
.restore-dialog-overlay {
  z-index: var(--z-overlay-primary, 60);
}
.restore-dialog {
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1rem;
  max-width: 22rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.restore-dialog-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
}
</style>
