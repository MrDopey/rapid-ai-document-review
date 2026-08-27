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
  background: #b45309;
  color: white;
  border-radius: 999px;
  font-size: 0.8rem;
  z-index: 1000;
}
</style>
