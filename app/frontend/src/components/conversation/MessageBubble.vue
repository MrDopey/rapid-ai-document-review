<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { render } from '../../render/markdown-pipeline.js';
import { domPurifySanitizer } from '../../render/sanitizer.js';
import type { ConversationMessageState } from '../../stores/conversations.js';

const props = defineProps<{ message: ConversationMessageState; seed?: boolean }>();
const settings = useSettingsStore();

// All agent-produced (and, defensively, user-authored) content passes the sanitizer before
// touching the DOM (FR-008a, Constitution Principle VI) — same pipeline as document Markdown.
const safeText = computed(() => domPurifySanitizer.sanitize(render(props.message.text)));
const safeReasoning = computed(() =>
  props.message.reasoning ? domPurifySanitizer.sanitize(render(props.message.reasoning)) : '',
);
</script>

<template>
  <!-- FR-007c: `data-role` stays the real message role even for a seed card (e.g. tests select
       `.message-bubble[data-role="user"]`); `seed` only changes how it's presented. -->
  <article
    class="message-bubble"
    :class="{ 'seed-card': seed }"
    :data-role="message.role"
    :aria-busy="message.streaming"
  >
    <header class="message-role">
      {{ seed ? 'Context — discussing this excerpt' : message.role === 'user' ? 'You' : 'Assistant' }}
    </header>

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
  background: var(--user-bubble-bg, rgba(37, 99, 235, 0.08));
}
.message-bubble[data-role='assistant'] {
  background: var(--assistant-bubble-bg, rgba(0, 0, 0, 0.04));
}
/* FR-007c: the branch-seed message is still technically `data-role="user"` (see the template
   comment above) but is presented as a distinct system/context card, not a user chat bubble. */
.message-bubble.seed-card {
  background: var(--seed-bg, #f3f4f6);
  border: 1px dashed var(--seed-border, #9ca3af);
}
.message-role {
  font-size: 0.75rem;
  font-weight: 600;
  /* Contrast fix: a flat opacity reduction on inherited text color is background-dependent and
     measured well under 4.5:1 in dark mode. `--neutral-muted-color` is a real token already
     validated to clear 4.5:1 against panel/bubble backgrounds in both schemes (see style.css) —
     use it directly instead, same as the seed-card variant already did. */
  color: var(--neutral-muted-color, #4b5563);
  margin-bottom: 0.25rem;
}
/* Fix 5: embedded Markdown headings (e.g. a branch-seed excerpt's own section heading) must not
   render at full document size inside a ~350px-wide chat bubble — that crowds out the message. */
.message-text :deep(h1) {
  font-size: 1.1rem;
}
.message-text :deep(h2) {
  font-size: 1rem;
}
.message-text :deep(h3),
.message-text :deep(h4),
.message-text :deep(h5),
.message-text :deep(h6) {
  font-size: 0.95rem;
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
