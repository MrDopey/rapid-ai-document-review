<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { diffWords } from 'diff';
import type { PreviewEditResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../../transport/http-client.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import { useDocumentStore } from '../../stores/document.js';
import DiffText from './DiffText.vue';
import { groupParts } from './collapseUnchanged.js';
import { diffContextLinesFromEnv } from '../../composables/diffContextConfig.js';
import { useCollapsedDiffGroups } from '../../composables/collapsedDiffView.js';

const props = defineProps<{ editId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const documentStore = useDocumentStore();

const preview = ref<PreviewEditResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const view = ref<'full' | 'hunks' | 'side-by-side'>('hunks');
const rootEl = ref<HTMLElement | null>(null);
const originalSnapshot = ref('');

// FR-043d: this component only ever exists in the DOM while its preview dialog is open (the
// parent, EditsList.vue, mounts/unmounts it via `v-if`) — so "active" is simply "for as long as
// this component instance is alive", and useFocusTrap's own onBeforeUnmount handles restoring
// focus to the "Preview" button that triggered it.
useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

const fullDocDiff = computed(() =>
  diffWords(originalSnapshot.value, preview.value?.fullPreview ?? ''),
);

const {
  focusedView,
  isGroupVisible,
  expandGroup,
  resetExpanded,
  groups: fullDocGroups,
} = useCollapsedDiffGroups(fullDocDiff, diffContextLinesFromEnv);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    originalSnapshot.value = documentStore.content;
    resetExpanded();
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

const fullDocHasNoDiff = computed(
  () =>
    fullDocDiff.value.length === 1 && !fullDocDiff.value[0].added && !fullDocDiff.value[0].removed,
);
</script>

<template>
  <div
    ref="rootEl"
    class="diff-viewer"
    role="dialog"
    aria-label="Review proposed edit"
    aria-modal="true"
  >
    <header class="diff-header">
      <div class="diff-header-left">
        <span class="pane-eyebrow">Proposed edit</span>
        <div
          v-if="!preview || preview.reconcilable"
          class="view-toggle"
          role="tablist"
          aria-label="Diff view"
        >
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
          <button
            id="diff-tab-side-by-side"
            type="button"
            role="tab"
            :aria-selected="view === 'side-by-side'"
            aria-controls="diff-panel-side-by-side"
            @click="view = 'side-by-side'"
          >
            Side by side
          </button>
        </div>
        <label v-if="view !== 'hunks' && !fullDocHasNoDiff" class="focus-toggle">
          <input v-model="focusedView" type="checkbox" />
          Focus on changes
        </label>
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
            <p class="hunk-diff text-wrap-safe-pre">
              <DiffText :parts="wordDiffs[i]" side="unified" />
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
          <p v-if="fullDocHasNoDiff">No differences found.</p>
          <pre
            v-else-if="!focusedView"
            class="text-wrap-safe-pre"
          ><DiffText :parts="fullDocDiff" side="unified" /></pre>
          <pre
            v-else
            class="text-wrap-safe-pre"
          ><template v-for="(group, i) in fullDocGroups" :key="i"><DiffText v-if="isGroupVisible(group, i)" :parts="groupParts(group)" side="unified" /><button v-else type="button" class="collapsed-marker" @click="expandGroup(i)">⋯ {{ group.lines.length }} unchanged line{{ group.lines.length === 1 ? '' : 's' }} ⋯</button></template></pre>
        </div>

        <div
          id="diff-panel-side-by-side"
          class="side-by-side-view"
          role="tabpanel"
          aria-labelledby="diff-tab-side-by-side"
          tabindex="0"
          :hidden="view !== 'side-by-side'"
        >
          <p v-if="fullDocHasNoDiff">No differences found.</p>
          <div v-else-if="!focusedView" class="side-by-side-columns">
            <pre
              class="diff-column-left text-wrap-safe-pre"
            ><DiffText :parts="fullDocDiff" side="left" /></pre>
            <pre
              class="diff-column-right text-wrap-safe-pre"
            ><DiffText :parts="fullDocDiff" side="right" /></pre>
          </div>
          <div v-else class="side-by-side-columns">
            <template v-for="(group, i) in fullDocGroups" :key="i">
              <template v-if="isGroupVisible(group, i)">
                <pre
                  class="diff-column-left text-wrap-safe-pre"
                ><DiffText :parts="groupParts(group)" side="left" /></pre>
                <pre
                  class="diff-column-right text-wrap-safe-pre"
                ><DiffText :parts="groupParts(group)" side="right" /></pre>
              </template>
              <button
                v-else
                type="button"
                class="collapsed-marker collapsed-marker--full-row"
                @click="expandGroup(i)"
              >
                ⋯ {{ group.lines.length }} unchanged line{{ group.lines.length === 1 ? '' : 's' }} ⋯
              </button>
            </template>
          </div>
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
/* .pane-eyebrow's shared text styling now lives in style.css. */
/* `.diff-header`, `.diff-header-left`, `.view-toggle button[aria-selected='true']`,
   `.focus-toggle`, `.collapsed-marker`, `.collapsed-marker--full-row`, `.side-by-side-columns`,
   and `.diff-column-left`/`.diff-column-right` (below) are shared with RevisionDiffViewer.vue and
   now live in style.css. */
.conflict-banner {
  padding: 0.5rem 0.75rem;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger-color, #991b1b);
  border-radius: 4px;
}
.hunk {
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
}
.hunk-context {
  /* 0.7 matches the same opacity used for `.pane-eyebrow` and `.message-role` elsewhere, giving
     real headroom over the 4.5:1 contrast minimum. */
  opacity: 0.7;
  font-size: 0.85rem;
  margin: 0.15rem 0;
}
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling lives in style.css. */
.hunk-diff {
  margin: 0.35rem 0;
}
/* `.removed`/`.added`/`.marker` are owned by DiffText.vue (single source, see research.md R4/R9). */
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling lives in style.css. */
.full-preview pre {
  font-family: inherit;
}
</style>
