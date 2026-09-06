<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { diffLines, type Change } from 'diff';
import { useDocumentStore } from '../../stores/document.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import DiffText from './DiffText.vue';
import { splitIntoLines, groupByContext, groupParts, type DiffGroup } from './collapseUnchanged.js';
import { diffContextLinesFromEnv } from '../../composables/diffContextConfig.js';

const props = defineProps<{ revision: number; previousRevision: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useDocumentStore();

const loading = ref(true);
const error = ref<string | null>(null);
const previousText = ref<string | null>(null);
const currentText = ref<string | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const view = ref<'unified' | 'side-by-side'>('unified');
// Same collapsed-by-default context-window view as DiffViewer.vue (see collapseUnchanged.ts) —
// reset on every fresh `load()` since a new revision pair's groups don't line up with the old ones.
const focusedView = ref(true);
const expandedGroupIndexes = ref<Set<number>>(new Set());

function expandGroup(index: number): void {
  expandedGroupIndexes.value = new Set(expandedGroupIndexes.value).add(index);
}
function isGroupVisible(group: DiffGroup, index: number): boolean {
  return group.type === 'visible' || expandedGroupIndexes.value.has(index);
}
// Toggling focus off and back on should return to the default collapsed state, not remember
// which groups a prior look at the full document happened to expand.
watch(focusedView, () => {
  expandedGroupIndexes.value = new Set();
});

useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  previousText.value = null;
  currentText.value = null;
  expandedGroupIndexes.value = new Set();
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

const diffParts = computed<Change[] | null>(() => {
  if (previousText.value === null || currentText.value === null) return null;
  return diffLines(previousText.value, currentText.value);
});

const identical = computed(
  () => diffParts.value !== null && !diffParts.value.some((part) => part.added || part.removed),
);
const diffGroups = computed(() =>
  groupByContext(splitIntoLines(diffParts.value ?? []), diffContextLinesFromEnv),
);
</script>

<template>
  <div
    ref="rootEl"
    class="revision-diff-viewer"
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
          <pre class="diff-column-left text-wrap-safe-pre"><DiffText :parts="diffParts ?? []" side="left" /></pre>
          <pre class="diff-column-right text-wrap-safe-pre"><DiffText :parts="diffParts ?? []" side="right" /></pre>
        </div>
        <div v-else class="side-by-side-columns">
          <template v-for="(group, i) in diffGroups" :key="i">
            <template v-if="isGroupVisible(group, i)">
              <pre class="diff-column-left text-wrap-safe-pre"><DiffText :parts="groupParts(group)" side="left" /></pre>
              <pre class="diff-column-right text-wrap-safe-pre"><DiffText :parts="groupParts(group)" side="right" /></pre>
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
/* Fix: matches the same modal-dialog pattern already used by HelpDialog.vue,
   KeyboardShortcutsDialog.vue, and EditsList.vue's `:deep(.diff-viewer)` override (background,
   border-radius, width/max-width, max-height, box-shadow) — this component previously had none of
   those, so it rendered with no visible chrome and, critically, no `max-height`: inside
   `.modal-overlay`'s viewport-centering flexbox, a long document's diff could grow taller than the
   viewport with nothing to cap it, pushing the header/close button and most of the diff off-screen
   with no scrollbar to reach them (`overflow: auto` only takes effect once a max-height/height
   exists for content to overflow against). */
.revision-diff-viewer {
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1rem;
  width: 48rem;
  max-width: 90vw;
  max-height: 85vh;
  overflow: auto;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin: -1rem -1rem 0.75rem;
  padding: 0.5rem 1rem;
  background: var(--panel-bg, #f7f7f8);
  border-bottom: 2px solid var(--border-color, #ddd);
  border-radius: 8px 8px 0 0;
  /* Sticky within `.revision-diff-viewer` (the scrolling dialog body) — see DiffViewer.vue's
     matching rule for why `top` mirrors this element's own negative margin. */
  position: sticky;
  top: -1rem;
  z-index: 1;
}
.diff-header-left {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.view-toggle button[aria-selected='true'] {
  font-weight: 600;
  text-decoration: underline;
}
.focus-toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
}
.collapsed-marker {
  display: block;
  width: 100%;
  font-family: inherit;
  font-size: 0.85rem;
  text-align: center;
  padding: 0.35rem;
  margin: 0.25rem 0;
  color: var(--neutral-muted-color, #4b5563);
  background: var(--panel-bg, #f7f7f8);
  border: 1px dashed var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
}
.collapsed-marker--full-row {
  grid-column: 1 / -1;
}
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling now lives in
   style.css (previously missing `overflow-wrap` here, a real sub-bug). */
.diff-body {
  font-family: inherit;
}
/* `.removed`/`.added`/`.marker` are owned by DiffText.vue (single source, see research.md R4/R9). */
.side-by-side-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.diff-column-left,
.diff-column-right {
  font-family: inherit;
  overflow: auto;
  margin: 0;
  min-width: 0;
}
</style>
