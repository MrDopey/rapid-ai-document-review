<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { diffWords } from 'diff';
import type { PreviewEditResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../../transport/http-client.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';

const props = defineProps<{ editId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const preview = ref<PreviewEditResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const view = ref<'full' | 'hunks'>('hunks');
const rootEl = ref<HTMLElement | null>(null);

// FR-043d: this component only ever exists in the DOM while its preview dialog is open (the
// parent, EditsList.vue, mounts/unmounts it via `v-if`) — so "active" is simply "for as long as
// this component instance is alive", and useFocusTrap's own onBeforeUnmount handles restoring
// focus to the "Preview" button that triggered it.
useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    preview.value = await httpClient.previewEdit(props.editId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load preview.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.editId, load);

const wordDiffs = computed(() =>
  (preview.value?.hunks ?? []).map((hunk) => diffWords(hunk.removed, hunk.added)),
);
</script>

<template>
  <div ref="rootEl" class="diff-viewer" role="dialog" aria-label="Review proposed edit" aria-modal="true">
    <header class="diff-header">
      <div class="diff-header-left">
        <span class="pane-eyebrow">Proposed edit</span>
        <div class="view-toggle" role="tablist" aria-label="Diff view">
          <button
            id="diff-tab-hunks"
            type="button"
            role="tab"
            :aria-selected="view === 'hunks'"
            aria-controls="diff-panel-hunks"
            @click="view = 'hunks'"
          >
            Added / removed
          </button>
          <button
            id="diff-tab-full"
            type="button"
            role="tab"
            :aria-selected="view === 'full'"
            aria-controls="diff-panel-full"
            @click="view = 'full'"
          >
            Full document
          </button>
        </div>
      </div>
      <button type="button" class="close-button" @click="emit('close')">Close</button>
    </header>

    <p v-if="loading">Loading preview…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>

    <template v-else-if="preview">
      <div v-if="!preview.reconcilable" class="conflict-banner" role="alert">
        <strong>This proposal no longer applies cleanly.</strong>
        <ul>
          <li v-for="op in preview.conflictDetail?.operations ?? []" :key="op.index">
            Operation {{ op.index + 1 }}:
            {{
              op.reason === 'not_found'
                ? 'the targeted text was not found in the current document.'
                : op.reason === 'ambiguous'
                  ? `the targeted text now occurs ${op.occurrences} times (must be unique).`
                  : 'this operation overlaps another in the same proposal.'
            }}
          </li>
        </ul>
      </div>

      <!-- Both tabpanels stay mounted (toggled via the native `hidden` attribute, not v-if/v-else)
           once the proposal is reconcilable — each tab's `aria-controls` above must reference an
           element that actually exists in the DOM, not just whichever one is currently active. -->
      <template v-else>
        <div
          id="diff-panel-hunks"
          class="hunks-view"
          role="tabpanel"
          aria-labelledby="diff-tab-hunks"
          tabindex="0"
          :hidden="view !== 'hunks'"
        >
          <div v-for="(hunk, i) in preview.hunks" :key="hunk.operationIndex" class="hunk">
            <p class="hunk-context">…{{ hunk.contextBefore }}</p>
            <p class="hunk-diff">
              <template v-for="(part, j) in wordDiffs[i]" :key="j">
                <del v-if="part.removed" class="removed">
                  <span class="marker" aria-hidden="true">−</span>
                  <span class="visually-hidden">removed:</span>{{ part.value }}
                </del>
                <ins v-else-if="part.added" class="added">
                  <span class="marker" aria-hidden="true">+</span>
                  <span class="visually-hidden">added:</span>{{ part.value }}
                </ins>
                <span v-else>{{ part.value }}</span>
              </template>
            </p>
            <p class="hunk-context">{{ hunk.contextAfter }}…</p>
          </div>
        </div>

        <div
          id="diff-panel-full"
          class="full-preview"
          role="tabpanel"
          aria-labelledby="diff-tab-full"
          tabindex="0"
          :hidden="view !== 'full'"
        >
          <pre>{{ preview.fullPreview }}</pre>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.diff-viewer {
  padding: 1rem;
  max-width: 100%;
  overflow: auto;
}
.diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin: -1rem -1rem 0.75rem;
  padding: 0.5rem 1rem;
  /* Fix 2: a distinct header surface, consistent with the other panes' toolbars. */
  background: var(--panel-bg, #f7f7f8);
  border-bottom: 2px solid var(--border-color, #ddd);
  border-radius: 8px 8px 0 0;
}
.diff-header-left {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.pane-eyebrow {
  text-transform: uppercase;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  opacity: 0.6;
}
.view-toggle button[aria-selected='true'] {
  font-weight: 600;
  text-decoration: underline;
}
.conflict-banner {
  padding: 0.5rem 0.75rem;
  background: #fee2e2;
  color: #991b1b;
  border-radius: 4px;
}
.hunk {
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
}
.hunk-context {
  opacity: 0.6;
  font-size: 0.85rem;
  margin: 0.15rem 0;
}
.hunk-diff {
  white-space: pre-wrap;
  margin: 0.35rem 0;
}
.removed {
  color: #991b1b;
  background: #fee2e2;
  text-decoration: line-through;
}
.added {
  color: #065f46;
  background: #d1fae5;
  text-decoration: none;
}
.marker {
  font-weight: 700;
  margin-right: 0.15rem;
}
.full-preview pre {
  white-space: pre-wrap;
  font-family: inherit;
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
