<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useThreadStore } from '../../stores/thread.js';
import ThreadCard from './ThreadCard.vue';
import DoneThreadsPanel from './DoneThreadsPanel.vue';

/**
 * 011-linear-thread-mode (FR-002/FR-003/FR-008): the top-level view App.vue mounts in
 * place of the canvas Preview/Canvas/History grid whenever the active document's
 * `documentType === 'thread'` — a single top-down, vertically-ordered list of Threads. No control
 * anywhere in this view creates a new independent top-level Thread (FR-003) — the only compose
 * affordance in the whole mode is `ThreadComposer.vue`, mounted per-Thread on that Thread's own
 * current tip segment (`ThreadCard.vue`).
 */
const store = useThreadStore();
const doneOpen = ref(false);

onMounted(() => {
  if (!store.loaded) void store.load();
});

/** The default list shows only active Threads (`doneAt === null`) — done ones are reachable
 *  only via `DoneThreadsPanel.vue` (FR-008). A Thread is rendered as its own top-level entry here
 *  only when it has no active parent to nest under — ordinarily just the single root thread
 *  (FR-003), except when a parent has been marked done: FR-011 requires its still-active
 *  descendants to keep appearing in the default list, so a done thread's active children are
 *  promoted to top-level entries of their own rather than disappearing along with it. */
const activeThreads = computed(() => store.threads.filter((t) => t.doneAt === null));
const topLevelThreadIds = computed(() => {
  const activeIds = new Set(activeThreads.value.map((t) => t.id));
  return activeThreads.value
    .filter((t) => !t.parentId || !activeIds.has(t.parentId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => t.id);
});

const doneCount = computed(() => store.threads.filter((t) => t.doneAt !== null).length);
</script>

<template>
  <div class="thread-mode-view">
    <div class="thread-mode-toolbar">
      <span class="thread-mode-title">Threads</span>
      <button type="button" class="thread-mode-done-toggle" @click="doneOpen = true">
        Done ({{ doneCount }})
      </button>
    </div>

    <p v-if="store.loaded && topLevelThreadIds.length === 0" class="thread-mode-empty">
      No active threads.
    </p>

    <div class="thread-mode-list">
      <ThreadCard v-for="id in topLevelThreadIds" :key="id" :thread-id="id" />
    </div>

    <Transition name="modal">
      <div v-if="doneOpen" class="modal-overlay" @click.self="doneOpen = false">
        <DoneThreadsPanel @close="doneOpen = false" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.thread-mode-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
  overflow-y: auto;
}
.thread-mode-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.thread-mode-title {
  font-size: 1.1rem;
  font-weight: 600;
}
.thread-mode-empty {
  color: var(--neutral-muted-color, #4b5563);
}
.thread-mode-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
