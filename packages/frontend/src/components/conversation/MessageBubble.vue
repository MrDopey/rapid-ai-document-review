<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { render } from '../../render/markdown-pipeline.js';
import { domPurifySanitizer } from '../../render/sanitizer.js';
import type { ConversationMessageState } from '../../stores/conversations.js';

const props = defineProps<{ message: ConversationMessageState }>();
const settings = useSettingsStore();

// All agent-produced (and, defensively, user-authored) content passes the sanitizer before
// touching the DOM (FR-008a, Constitution Principle VI) — same pipeline as document Markdown.
const safeText = computed(() => domPurifySanitizer.sanitize(render(props.message.text)));
const safeReasoning = computed(() =>
  props.message.reasoning ? domPurifySanitizer.sanitize(render(props.message.reasoning)) : '',
);
</script>

<template>
  <article class="message-bubble" :data-role="message.role" :aria-busy="message.streaming">
    <header class="message-role">{{ message.role === 'user' ? 'You' : 'Assistant' }}</header>

    <details v-if="message.reasoning" class="reasoning" :open="settings.thinkingVisible">
      <summary>Reasoning</summary>
      <div class="reasoning-content" v-html="safeReasoning"></div>
    </details>

    <div class="message-text" v-html="safeText"></div>
  </article>
</template>

<style scoped>
.message-bubble {
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  margin-bottom: 0.5rem;
  text-align: left;
}
.message-bubble[data-role='user'] {
  background: rgba(37, 99, 235, 0.08);
}
.message-bubble[data-role='assistant'] {
  background: rgba(0, 0, 0, 0.04);
}
.message-role {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.7;
  margin-bottom: 0.25rem;
}
.reasoning {
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  opacity: 0.85;
}
.reasoning summary {
  cursor: pointer;
}
.message-text :deep(p:first-child) {
  margin-top: 0;
}
.message-text :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
