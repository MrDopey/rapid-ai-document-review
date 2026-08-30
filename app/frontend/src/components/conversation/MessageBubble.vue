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
const safeText = computed(() => domPurifySanitizer.sanitize(render(props.message.text ?? '')));
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
/* Fix: rendered Markdown (linkify'd URLs, long fenced-code lines, or any other unbroken run of
   text) has no natural break point, so without this it overflowed straight past the bubble's box
   instead of wrapping to fit — same failure shape, and same fix, as `.error-banner-message` in
   ConversationView.vue. `.message-bubble`/`.message-list` are plain block boxes here (not flex/grid
   items), so — unlike that flex-item case — no `min-width: 0` is needed to let anything shrink;
   `overflow-wrap` alone is what's missing, and it's inherited by every descendant (links, list
   items, blockquotes, …) so linkify'd `<a>` text wraps too. */
.message-text {
  overflow-wrap: break-word;
}
/* Fenced code blocks: `<pre>` (and inline `<code>`) come from markdown-it with the browser's
   default `white-space: pre` and no break points, so a long code line — or an inline code span —
   overflowed the bubble the same way long prose did. `pre-wrap` wraps at normal break
   opportunities first; `overflow-wrap: break-word` (also set directly on `code` for the inline
   case) additionally breaks an unbroken run — e.g. a long hash/identifier — that has none.
   `overflow-x: auto` is kept as a fallback so an unbreakable run still scrolls inside the code
   block rather than escaping it. */
.message-text :deep(pre) {
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.message-text :deep(code) {
  overflow-wrap: break-word;
  word-break: break-word;
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
