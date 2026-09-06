<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import { httpClient } from '../../transport/http-client.js';

const emit = defineEmits<{ (e: 'close'): void }>();

const rootEl = ref<HTMLElement | null>(null);
const systemPrompt = ref<string | null>(null);
const error = ref<string | null>(null);

useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

onMounted(async () => {
  try {
    const dto = await httpClient.getSystemPrompt();
    systemPrompt.value = dto.systemPrompt;
  } catch {
    error.value = 'Failed to load the system prompt.';
  }
});
</script>

<template>
  <div
    ref="rootEl"
    class="system-prompt-dialog dialog-box"
    role="dialog"
    aria-modal="true"
    aria-label="System prompt"
  >
    <header class="dialog-header">
      <h2>System prompt</h2>
      <button type="button" class="close-button" @click="emit('close')">Close</button>
    </header>

    <p class="system-prompt-note">
      Read-only: this is the instructions the AI reviewer is given at the start of every
      conversation.
    </p>

    <p v-if="error" class="system-prompt-error">{{ error }}</p>
    <pre v-else-if="systemPrompt" class="system-prompt-text">{{ systemPrompt }}</pre>
    <p v-else class="system-prompt-loading">Loading…</p>
  </div>
</template>

<style scoped>
.system-prompt-dialog {
  padding: 1rem;
  width: 40rem;
  max-width: 90vw;
  max-height: 85vh;
  overflow: auto;
}
.dialog-header {
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
.dialog-header h2 {
  margin: 0;
  font-size: 1rem;
}
.system-prompt-note {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--muted-text, #666);
}
.system-prompt-text {
  margin: 0;
  padding: 0.75rem;
  background: var(--panel-bg, #f7f7f8);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 0.8rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.system-prompt-error {
  font-size: 0.85rem;
  color: var(--error-text, #b00020);
}
.system-prompt-loading {
  font-size: 0.85rem;
  color: var(--muted-text, #666);
}

@media (max-width: 520px) {
  .system-prompt-dialog {
    width: 100%;
  }
}
</style>
