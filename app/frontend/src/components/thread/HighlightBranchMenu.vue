<script setup lang="ts">
/**
 * 011-linear-thread-mode (FR-005/FR-005a/FR-007): a small selection popover, positioned near
 * the reviewer's current text selection, offering "Branch from here". `ThreadCard.vue` owns
 * deciding WHEN this renders at all — it's mounted only while there's an active, non-empty
 * selection inside a message that isn't the Thread's actual current tip message (FR-007's "anchor
 * must be strictly earlier than the tip", enforced here at the UI layer as well as by the backend's
 * own `ANCHOR_IS_TIP` check) — this component itself only renders the button and reports the
 * click, carrying no selection-detection logic of its own.
 */
defineProps<{ x: number; y: number; highlightedText: string; pending?: boolean }>();
const emit = defineEmits<{ (e: 'branch'): void; (e: 'dismiss'): void }>();
</script>

<template>
  <div
    class="highlight-branch-menu"
    role="menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @mousedown.stop
  >
    <button
      type="button"
      class="highlight-branch-button"
      :disabled="pending"
      @click="emit('branch')"
    >
      {{ pending ? 'Branching…' : 'Branch from here' }}
    </button>
    <button
      type="button"
      class="highlight-branch-dismiss"
      aria-label="Dismiss"
      @click="emit('dismiss')"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
.highlight-branch-menu {
  position: fixed;
  z-index: var(--z-overlay, 20);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.35rem;
  background: var(--panel-bg, #f7f7f8);
  border: 1px solid var(--neutral-muted-color, #4b5563);
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  transform: translate(-50%, -100%);
}
.highlight-branch-button {
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  white-space: nowrap;
}
.highlight-branch-dismiss {
  font-size: 0.7rem;
  padding: 0.1rem 0.3rem;
  color: var(--neutral-muted-color, #4b5563);
  background: none;
  border: none;
  cursor: pointer;
}
</style>
