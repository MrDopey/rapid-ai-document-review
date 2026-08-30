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
.revision-diff-viewer {
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
