<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import DoneThreadColumn from './DoneThreadColumn.vue';

/**
 * 011-linear-thread-mode (FR-008/FR-009, User Story 3): the "done"/history view — every Thread
 * with `doneAt !== null`, in whichever document is currently active, laid out as one side-by-side,
 * read-only column per done thread (`DoneThreadColumn.vue`). Replaces the flat name+Reopen `<ul>`
 * this used to be: a done Thread's own branch relationships are now directly readable here (full
 * ancestor lineage, oldest first, up to this thread's own fork point) rather than only inspectable
 * by reopening it back into the default list.
 */
const emit = defineEmits<{ (e: 'close'): void; (e: 'reopened', threadId: string): void }>();

const store = useThreadStore();

const doneThreads = computed(() =>
  store.threads
    .filter((t) => t.doneAt !== null)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')),
);

/** The actual `store.reopen` call — and the `reopened` relay once it resolves — deliberately live
 *  HERE, not in `DoneThreadColumn.vue` itself, and `reopeningIds`/`reopenErrors` are threaded down
 *  as plain props rather than owned by each column. This component is never removed by the
 *  mutation `store.reopen` causes (only its `v-for`-mapped `DoneThreadColumn` children are, as they
 *  drop out of `doneThreads` above) — see `DoneThreadColumn.vue`'s own doc comment for the exact
 *  race this sidesteps: emitting `reopened` from a component that's *itself* about to be unmounted
 *  by that same mutation loses the race almost every time (Vue's `emit()` is a silent no-op once
 *  `instance.isUnmounted`), because the unmount's reactive flush is already queued by the time this
 *  component's own post-`await` continuation resumes. */
const reopeningIds = ref<ReadonlySet<string>>(new Set());
const reopenErrors = reactive<Record<string, string>>({});

async function onColumnReopen(threadId: string): Promise<void> {
  delete reopenErrors[threadId];
  reopeningIds.value = new Set(reopeningIds.value).add(threadId);
  try {
    await store.reopen(threadId);
    emit('reopened', threadId);
  } catch (err) {
    reopenErrors[threadId] = err instanceof Error ? err.message : 'Failed to reopen thread.';
  } finally {
    const next = new Set(reopeningIds.value);
    next.delete(threadId);
    reopeningIds.value = next;
  }
}
</script>

<template>
  <aside class="done-threads-panel dialog-box" aria-label="Done threads">
    <header class="done-threads-header">
      <h2>Done threads</h2>
      <button type="button" aria-label="Close done threads" @click="emit('close')">✕</button>
    </header>
    <p v-if="doneThreads.length === 0" class="done-threads-empty">No done threads yet.</p>
    <div v-else class="done-threads-columns">
      <DoneThreadColumn
        v-for="t in doneThreads"
        :key="t.id"
        :thread-id="t.id"
        :reopening="reopeningIds.has(t.id)"
        :reopen-error="reopenErrors[t.id] ?? null"
        @reopen="onColumnReopen"
      />
    </div>
  </aside>
</template>

<style scoped>
.done-threads-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  width: min(1400px, 95vw);
  max-height: 85vh;
}
.done-threads-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
}
.done-threads-header h2 {
  font-size: 1rem;
  margin: 0;
}
.done-threads-empty {
  color: var(--neutral-muted-color, #4b5563);
  font-size: 0.85rem;
}
/* One `.done-thread-column` per done thread, flowing left to right — each column is its own fixed
   width (see that file's own CSS) and independently vertically scrollable, so this row only ever
   needs to scroll horizontally when there are more done threads than fit the viewport at once. */
.done-threads-columns {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 0.75rem;
  min-height: 0;
  flex: 1 1 auto;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}
</style>
