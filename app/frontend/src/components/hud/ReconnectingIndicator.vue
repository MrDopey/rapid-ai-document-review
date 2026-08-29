<script setup lang="ts">
defineProps<{ reconnecting: boolean }>();
</script>

<template>
  <div v-if="reconnecting" class="reconnecting-indicator" role="status" aria-live="polite">
    Reconnecting…
  </div>
</template>

<style scoped>
.reconnecting-indicator {
  position: fixed;
  top: 0.5rem;
  right: 0.5rem;
  padding: 0.25rem 0.75rem;
  /* Dedicated bg/text pair (style.css's --reconnect-bg/--reconnect-text) rather than
     `--warning-color` + literal `white`: this badge's fill and text need to swap which end is
     dark and which is light between color schemes (dark-amber fill + white text in light mode,
     bright-amber fill + dark text in dark mode), whereas `--warning-color` is tuned for plain
     warning *text on a panel surface* and moves the opposite direction between schemes. */
  background: var(--reconnect-bg, #92400e);
  color: var(--reconnect-text, white);
  border-radius: 999px;
  font-size: 0.8rem;
  z-index: 1000;
}
</style>
