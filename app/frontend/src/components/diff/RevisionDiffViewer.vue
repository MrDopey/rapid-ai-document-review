<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { diffLines, type Change } from 'diff';
import { useDocumentStore } from '../../stores/document.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';

const props = defineProps<{ revision: number; previousRevision: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useDocumentStore();

const loading = ref(true);
const error = ref<string | null>(null);
const previousText = ref<string | null>(null);
const currentText = ref<string | null>(null);
const rootEl = ref<HTMLElement | null>(null);

useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  previousText.value = null;
  currentText.value = null;
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
      <span class="pane-eyebrow">Compare v{{ previousRevision }} → v{{ revision }}</span>
      <button type="button" class="close-button" @click="emit('close')">Close</button>
    </header>

    <p v-if="loading">Loading revisions…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="identical">No differences found.</p>
    <div v-else class="diff-body text-wrap-safe-pre">
      <template v-for="(part, i) in diffParts" :key="i">
        <del v-if="part.removed" class="removed">{{ part.value }}</del>
        <ins v-else-if="part.added" class="added">{{ part.value }}</ins>
        <span v-else>{{ part.value }}</span>
      </template>
    </div>
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
}
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling now lives in
   style.css (previously missing `overflow-wrap` here, a real sub-bug). */
.diff-body {
  font-family: inherit;
}
.removed {
  color: var(--danger-color, #991b1b);
  background: var(--danger-bg, #fee2e2);
  text-decoration: line-through;
}
.added {
  color: var(--success-color, #065f46);
  background: var(--success-bg, #d1fae5);
  text-decoration: none;
}
</style>
