<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { diffLines, type Change } from 'diff';
import { useDocumentStore } from '../../stores/document.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import DiffText from './DiffText.vue';
import { groupParts } from './collapseUnchanged.js';
import { diffContextLinesFromEnv } from '../../composables/diffContextConfig.js';
import { useCollapsedDiffGroups } from '../../composables/collapsedDiffView.js';

const props = defineProps<{ revision: number; previousRevision: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useDocumentStore();

const loading = ref(true);
const error = ref<string | null>(null);
const previousText = ref<string | null>(null);
const currentText = ref<string | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const view = ref<'unified' | 'side-by-side'>('unified');

// Same collapsed-by-default context-window view as DiffViewer.vue (see collapsedDiffView.ts) —
// reset on every fresh `load()` since a new revision pair's groups don't line up with the old ones.
const diffParts = computed<Change[] | null>(() => {
  if (previousText.value === null || currentText.value === null) return null;
  return diffLines(previousText.value, currentText.value);
});

const {
  focusedView,
  isGroupVisible,
  expandGroup,
  resetExpanded,
  groups: diffGroups,
} = useCollapsedDiffGroups(diffParts, diffContextLinesFromEnv);

useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  previousText.value = null;
  currentText.value = null;
  resetExpanded();
  try {
    const [previous, current] = await Promise.all([
      store.exportRevision(props.previousRevision),
      store.exportRevision(props.revision),
    ]);
    previousText.value = previous;
    currentText.value = current;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load revisions to compare.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([() => props.revision, () => props.previousRevision], load);

const identical = computed(
  () => diffParts.value !== null && !diffParts.value.some((part) => part.added || part.removed),
);
</script>

<template>
  <div
    ref="rootEl"
    class="revision-diff-viewer dialog-box"
    role="dialog"
    aria-label="Compare revisions"
    aria-modal="true"
  >
    <header class="diff-header">
      <div class="diff-header-left">
        <span class="pane-eyebrow">Compare v{{ previousRevision }} → v{{ revision }}</span>
        <div class="view-toggle" role="tablist" aria-label="Diff view">
          <button
            id="revision-diff-tab-unified"
            type="button"
            role="tab"
            :aria-selected="view === 'unified'"
            aria-controls="revision-diff-panel-unified"
            @click="view = 'unified'"
          >
            Unified
          </button>
          <button
            id="revision-diff-tab-side-by-side"
            type="button"
            role="tab"
            :aria-selected="view === 'side-by-side'"
            aria-controls="revision-diff-panel-side-by-side"
            @click="view = 'side-by-side'"
          >
            Side by side
          </button>
        </div>
        <label v-if="!identical" class="focus-toggle">
          <input v-model="focusedView" type="checkbox" />
          Focus on changes
        </label>
      </div>
      <button type="button" class="close-button" @click="emit('close')">Close</button>
    </header>

    <p v-if="loading">Loading revisions…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>

    <template v-else>
      <div
        id="revision-diff-panel-unified"
        role="tabpanel"
        aria-labelledby="revision-diff-tab-unified"
        tabindex="0"
        :hidden="view !== 'unified'"
      >
        <p v-if="identical">No differences found.</p>
        <div v-else-if="!focusedView" class="diff-body text-wrap-safe-pre">
          <DiffText :parts="diffParts ?? []" side="unified" />
        </div>
        <div v-else class="diff-body text-wrap-safe-pre">
          <template v-for="(group, i) in diffGroups" :key="i">
            <DiffText v-if="isGroupVisible(group, i)" :parts="groupParts(group)" side="unified" />
            <button v-else type="button" class="collapsed-marker" @click="expandGroup(i)">
              ⋯ {{ group.lines.length }} unchanged line{{ group.lines.length === 1 ? '' : 's' }} ⋯
            </button>
          </template>
        </div>
      </div>

      <div
        id="revision-diff-panel-side-by-side"
        role="tabpanel"
        aria-labelledby="revision-diff-tab-side-by-side"
        tabindex="0"
        :hidden="view !== 'side-by-side'"
      >
        <p v-if="identical">No differences found.</p>
        <div v-else-if="!focusedView" class="side-by-side-columns">
          <pre
            class="diff-column-left text-wrap-safe-pre"
          ><DiffText :parts="diffParts ?? []" side="left" /></pre>
          <pre
            class="diff-column-right text-wrap-safe-pre"
          ><DiffText :parts="diffParts ?? []" side="right" /></pre>
        </div>
        <div v-else class="side-by-side-columns">
          <template v-for="(group, i) in diffGroups" :key="i">
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
  </div>
</template>

<style scoped>
/* Inside `.modal-overlay`'s viewport-centering flexbox, a long document's diff could grow taller
   than the viewport with nothing to cap it, pushing the header/close button and most of the diff
   off-screen with no scrollbar to reach them — `overflow: auto` only takes effect once a
   max-height/height exists for content to overflow against, hence the explicit `max-height` below.
   Background/color/border-radius/box-shadow live in style.css's shared `.dialog-box` class
   (applied via the template class above); only the width/max-width/max-height/padding/overflow
   specific to this dialog stay here. */
.revision-diff-viewer {
  padding: 1rem;
  width: 48rem;
  max-width: 90vw;
  max-height: 85vh;
  overflow: auto;
}
/* `.diff-header`, `.diff-header-left`, `.view-toggle button[aria-selected='true']`,
   `.focus-toggle`, `.collapsed-marker`, `.collapsed-marker--full-row`, `.side-by-side-columns`,
   and `.diff-column-left`/`.diff-column-right` are shared with DiffViewer.vue and now live in
   style.css. */
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling lives in style.css. */
.diff-body {
  font-family: inherit;
}
/* `.removed`/`.added`/`.marker` are owned by DiffText.vue (single source, see research.md R4/R9). */
</style>
