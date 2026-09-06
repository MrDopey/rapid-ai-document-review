<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useEditsStore } from '../../stores/edits.js';
import { useBusyId } from '../../composables/useBusyAction.js';
import AcceptAllButton from './AcceptAllButton.vue';
import DropAllButton from './DropAllButton.vue';
import DiffViewer from '../diff/DiffViewer.vue';

const props = defineProps<{ conversationId: string }>();
const store = useEditsStore();

const previewingEditId = ref<string | null>(null);
const { busyId: busyEditId, run: runBusy } = useBusyId<string>();

// Oldest-first (top) to newest-last (bottom), by actual proposal creation time. The store's
// underlying array is newest-first (matches GET /conversations/:id/edits' `created_at DESC`,
// which several other backend call sites rely on for their own re-sort-to-ascending — see
// edit-service.ts's acceptRemaining) — sorted here rather than in the store since this display
// order is specific to this list, not to every consumer of `editsFor`/`pendingFor`.
const edits = computed(() =>
  [...store.editsFor(props.conversationId)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);
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
  await runBusy(editId, () => store.apply(editId, props.conversationId));
}

async function onDrop(editId: string): Promise<void> {
  // Same fix as DropAllButton.vue: dropping is destructive with no undo, unlike Accept, so this
  // per-row drop is gated behind an explicit confirmation before it fires.
  if (!window.confirm('Drop this proposed edit? This cannot be undone.')) return;
  await runBusy(editId, () => store.drop(editId, props.conversationId));
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
          <span class="summary-text text-wrap-safe">{{ edit.summary }}</span>
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
              class="drop-button"
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

    <!-- Click-outside-to-dismiss: a click landing on the backdrop itself (not bubbled up from the
         DiffViewer dialog nested inside it) closes the preview. `@click.self` (the same pattern
         App.vue uses for `.conversation-detail-overlay`) only fires when the click originates on
         this exact element, so a click on the DiffViewer content never triggers it. The explicit
         "Close" button and Escape (via `useFocusTrap`'s `onEscape`) stay untouched alongside this. -->
    <div v-if="previewingEditId" class="modal-overlay preview-overlay" @click.self="closePreview">
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
  /* New: when ConversationView.vue's transcript|edits split is active, this is a grid row sized
     by `fr` rather than by content — min-height: 0 lets it actually shrink to that row instead of
     forcing the row (and the page) to grow, and overflow-y: auto scrolls its own list instead.
     Inert (no visible scrollbar) when the split isn't active and this sizes to its own content. */
  min-height: 0;
  overflow-y: auto;
  /* Same fix as ConversationView.vue's .message-list: reserve the scrollbar's width so switching
     to a conversation with a different pending-edit count doesn't shift this pane's content. */
  scrollbar-gutter: stable;
}
/* Base text styling for `.pane-eyebrow` now lives in style.css; this file just adds its own
   block/spacing layout on top of the shared rule. */
.pane-eyebrow {
  display: block;
  margin-bottom: 0.35rem;
}
.exhausted-banner {
  padding: 0.5rem;
  margin-bottom: 0.5rem;
  background: var(--warning-bg, #fef3c7);
  color: var(--warning-color, #92400e);
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
  /* Fix: flex's default `align-items: stretch` was letting `.status-badge` grow tall/thin
     (its 1px `currentColor` border stretching into a distorted pill) to match `.summary-text`'s
     height whenever a long summary wrapped to multiple lines — i.e. the badge's height tracked
     its sibling's content height instead of staying fixed to its own text. `flex-start` pins it
     to a fixed, content-sized height regardless of how tall the summary next to it grows. */
  align-items: flex-start;
  gap: 0.5rem;
  font-weight: 600;
}
/* Fix: an LLM-generated edit summary is unbounded text sitting in `.edit-summary`'s flex row,
   which otherwise refuses to let this span shrink below its content's intrinsic width.
   `.text-wrap-safe`'s shared overflow-wrap handling (applied via the template class) now lives in
   style.css; `min-width: 0` stays here since it's this flex item's own layout concern. */
.summary-text {
  min-width: 0;
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
/* Fix: same danger/lower-emphasis treatment as DropAllButton.vue's ".drop-all-button", so the
   per-row Drop button doesn't look identical to the adjacent (non-destructive) Accept button. */
.drop-button {
  background: transparent;
  border-color: var(--danger-color, #b3261e);
  color: var(--danger-color, #b3261e);
}
.drop-button:hover:not(:disabled) {
  background: var(--danger-bg, #fee2e2);
}
/* Fix 4: color-code proposal status, layered on top of the (unchanged) text label — never
   relying on color alone (FR-043c). */
.status-badge[data-status='pending'] {
  /* Fix: unify with the same semantic "warning amber" token used for the stale/refresh-send
     warnings elsewhere — see style.css's --warning-color for why the previous #b45309 changed. */
  color: var(--warning-color, #92400e);
}
.status-badge[data-status='applied'] {
  color: var(--success-color, #065f46);
}
.status-badge[data-status='dropped'],
.status-badge[data-status='superseded'] {
  color: var(--neutral-muted-color, #4b5563);
}
.preview-overlay {
  z-index: var(--z-overlay, 50);
}
.preview-overlay :deep(.diff-viewer) {
  background: var(--bg-color, #fff);
  border-radius: 8px;
  max-width: 90vw;
  max-height: 85vh;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
</style>
