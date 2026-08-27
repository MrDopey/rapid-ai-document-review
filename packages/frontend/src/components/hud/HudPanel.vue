<script setup lang="ts">
import { onMounted } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';

const props = defineProps<{ selectedId: string | null }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
const store = useConversationsStore();

onMounted(() => {
  if (!store.loaded) void store.load();
});
</script>

<template>
  <nav class="hud-panel" aria-label="Conversations">
    <h2>Conversations</h2>
    <ul>
      <li v-for="conv in store.conversations" :key="conv.id" :style="{ paddingLeft: `${conv.branchDepth * 0.75}rem` }">
        <button
          type="button"
          class="conversation-row"
          :class="{ selected: conv.id === props.selectedId }"
          :aria-current="conv.id === props.selectedId ? 'true' : undefined"
          @click="emit('select', conv.id)"
        >
          <span class="name">{{ conv.name }}</span>
          <span class="badge status-badge" :data-status="conv.status">{{ conv.status }}</span>
          <span v-if="conv.isPrimary" class="badge primary-badge">Primary</span>
          <span v-if="conv.isStale" class="badge stale-badge">Stale</span>
          <span v-if="conv.pendingEditCount > 0" class="badge pending-badge">{{ conv.pendingEditCount }}</span>
          <span v-if="store.queueInfo[conv.id]" class="badge queue-badge">
            Queued #{{ store.queueInfo[conv.id]!.queuePosition }}
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.hud-panel {
  overflow-y: auto;
  height: 100%;
  padding: 0.5rem;
  text-align: left;
  border-right: 1px solid var(--border-color, #ddd);
}
.hud-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.conversation-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid transparent;
  background: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.conversation-row.selected {
  border-color: var(--border-color, #999);
  background: rgba(0, 0, 0, 0.05);
}
.conversation-row .name {
  font-weight: 600;
  margin-right: auto;
}
.badge {
  border-radius: 4px;
  padding: 0 0.35rem;
  font-size: 0.7rem;
  border: 1px solid currentColor;
}
.stale-badge {
  color: #b45309;
}
.pending-badge {
  color: #1d4ed8;
}
.queue-badge {
  color: #6b21a8;
}
</style>
