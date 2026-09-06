<script setup lang="ts">
import { useEditsStore } from '../../stores/edits.js';
import { useBusyAction } from '../../composables/useBusyAction.js';

const props = defineProps<{ conversationId: string; disabled?: boolean }>();
const store = useEditsStore();
const { busy, run } = useBusyAction(() => store.dropRemaining(props.conversationId));

// Discarding every still-pending proposal in one click is destructive and has no undo, unlike
// "Accept remaining" (which only applies proposed edits) — so this button, unlike
// AcceptAllButton.vue, gates its action behind an explicit confirmation before it fires.
function onClick(): void {
  if (
    !window.confirm(
      'Drop all remaining proposed edits in this conversation? This cannot be undone.',
    )
  ) {
    return;
  }
  void run();
}
</script>

<template>
  <button type="button" class="drop-all-button" :disabled="disabled || busy" @click="onClick">
    {{ busy ? 'Dropping…' : 'Drop remaining' }}
  </button>
</template>

<style scoped>
/* Danger-toned, lower-emphasis treatment so this doesn't read as an equally-weighted peer of
   "Accept remaining" — the two are adjacent buttons for opposite-consequence actions. */
.drop-all-button {
  background: transparent;
  border-color: var(--danger-color, #b91c1c);
  color: var(--danger-color, #b91c1c);
}
.drop-all-button:hover:not(:disabled) {
  background: var(--danger-bg, #fef2f2);
}
</style>
