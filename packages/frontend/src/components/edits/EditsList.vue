<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useEditsStore } from '../../stores/edits.js';
import AcceptAllButton from './AcceptAllButton.vue';
import DropAllButton from './DropAllButton.vue';
import DiffViewer from '../diff/DiffViewer.vue';

const props = defineProps<{ conversationId: string }>();
const store = useEditsStore();

const previewingEditId = ref<string | null>(null);
const busyEditId = ref<string | null>(null);

const edits = computed(() => store.editsFor(props.conversationId));
const pendingCount = computed(() => edits.value.filter((e) => e.status === 'pending').length);
const exhausted = computed(() => store.exhausted[props.conversationId] === true);

function load(): void {
  void store.load(props.conversationId);
}
onMounted(load);
watch(() => props.conversationId, load);

function supersededChainLabel(supersedesId: string | null): string | null {
  if (!supersedesId) return null;
  return `Replaces proposal ${supersedesId.slice(0, 12)}…`;
}

async function onAccept(editId: string): Promise<void> {
  busyEditId.value = editId;
  try {
    await store.apply(editId, props.conversationId);
  } finally {
    busyEditId.value = null;
  }
}

async function onDrop(editId: string): Promise<void> {
  busyEditId.value = editId;
  try {
    await store.drop(editId, props.conversationId);
  } finally {
    busyEditId.value = null;
  }
}

function openPreview(editId: string): void {
  previewingEditId.value = editId;
}
function closePreview(): void {
  previewingEditId.value = null;
}
</script>

<template>
  <section class="edits-list" aria-label="Proposed edits">
    <span class="pane-eyebrow">Proposed edits</span>
    <div v-if="exhausted" class="exhausted-banner" role="alert">
      The agent could not produce an edit that applies to the current document after several
      attempts. The document is unchanged — a new request will start with a fresh budget.
      <button type="button" @click="store.dismissExhausted(conversationId)">Dismiss</button>
    </div>

    <div class="bulk-actions" v-if="pendingCount > 1">
      <AcceptAllButton :conversation-id="conversationId" />
      <DropAllButton :conversation-id="conversationId" />
    </div>

    <p v-if="edits.length === 0" class="empty">No proposed edits yet.</p>

    <ul>
      <li v-for="edit in edits" :key="edit.id" class="edit-row" :data-status="edit.status">
        <div class="edit-summary">
          <span class="summary-text">{{ edit.summary }}</span>
          <span class="badge status-badge" :data-status="edit.status">{{ edit.status }}</span>
        </div>
        <div class="edit-meta">
          <span>Source revision v{{ edit.sourceRevision }}</span>
          <span v-if="edit.autoApplied" class="badge">Primary auto-apply</span>
          <span v-if="supersededChainLabel(edit.supersedesId)" class="chain-indicator">
            {{ supersededChainLabel(edit.supersedesId) }}
          </span>
        </div>
        <div class="edit-actions">
          <button type="button" :aria-label="`Preview: ${edit.summary}`" @click="openPreview(edit.id)">Preview</button>
          <template v-if="edit.status === 'pending'">
            <button
              type="button"
              :aria-label="`Accept: ${edit.summary}`"
              :disabled="busyEditId === edit.id"
              @click="onAccept(edit.id)"
            >
              Accept
            </button>
            <button
              type="button"
              :aria-label="`Drop: ${edit.summary}`"
              :disabled="busyEditId === edit.id"
              @click="onDrop(edit.id)"
            >
              Drop
            </button>
          </template>
        </div>
      </li>
    </ul>

    <div v-if="previewingEditId" class="preview-overlay">
      <DiffViewer :edit-id="previewingEditId" @close="closePreview" />
    </div>
  </section>
</template>

<style scoped>
.edits-list {
  padding: 0.5rem 0.75rem;
  border-top: 2px solid var(--border-color, #ddd);
  /* Fix 2: a surface distinct from the transcript above it. */
  background: var(--panel-bg, #f7f7f8);
}
.pane-eyebrow {
  display: block;
  text-transform: uppercase;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  opacity: 0.6;
  margin-bottom: 0.35rem;
}
.exhausted-banner {
  padding: 0.5rem;
  margin-bottom: 0.5rem;
  background: #fef3c7;
  color: #92400e;
  border-radius: 4px;
}
.bulk-actions {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.edits-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.edit-row {
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--border-color, #eee);
}
.edit-summary {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-weight: 600;
}
.edit-meta {
  display: flex;
  gap: 0.5rem;
  font-size: 0.75rem;
  opacity: 0.75;
  flex-wrap: wrap;
}
.chain-indicator {
  font-style: italic;
}
.edit-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.25rem;
}
.badge {
  border-radius: 4px;
  padding: 0 0.35rem;
  font-size: 0.7rem;
  border: 1px solid currentColor;
}
/* Fix 4: color-code proposal status, layered on top of the (unchanged) text label — never
   relying on color alone (FR-043c). */
.status-badge[data-status='pending'] {
  color: #b45309;
}
.status-badge[data-status='applied'] {
  color: #065f46;
}
.status-badge[data-status='dropped'],
.status-badge[data-status='superseded'] {
  color: #4b5563;
}
.preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.preview-overlay :deep(.diff-viewer) {
  background: var(--bg-color, #fff);
  border-radius: 8px;
  max-width: 90vw;
  max-height: 85vh;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
</style>
