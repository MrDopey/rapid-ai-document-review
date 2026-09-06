<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { render } from '../../render/markdown-pipeline.js';
import { domPurifySanitizer } from '../../render/sanitizer.js';
import { renderMermaidBlock } from '../../render/extensions/mermaid.js';

const props = defineProps<{ content: string }>();
const hostRef = ref<HTMLDivElement | null>(null);
const safeHtml = ref('');

async function hydrateMermaidBlocks(): Promise<void> {
  await nextTick();
  const host = hostRef.value;
  if (!host) return;
  const pending = Array.from(host.querySelectorAll<HTMLElement>('.mermaid-pending'));
  await Promise.all(
    pending.map(async (el) => {
      const source = el.textContent ?? '';
      const svg = await renderMermaidBlock(source);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-rendered';
      wrapper.innerHTML = svg;
      el.replaceWith(wrapper);
    }),
  );
}

watch(
  () => props.content,
  (content) => {
    safeHtml.value = domPurifySanitizer.sanitize(render(content));
    void hydrateMermaidBlocks();
  },
  { immediate: true },
);

// Synchronized scrolling (App.vue's "Sync scroll" toggle, composables/scrollSync.ts): App.vue
// wires this pane's own scrollable element (`hostRef` — it's `.preview-pane` itself, not a
// wrapper) together with DocumentCanvas.vue's, via `attachScrollSync`. Exposed as a getter (not
// the `hostRef` ref directly) so every read returns the live element, including across this
// component's own mount/unmount.
defineExpose({
  get scrollEl(): HTMLDivElement | null {
    return hostRef.value;
  },
});
</script>

<template>
  <div class="preview-container">
    <div class="preview-toolbar">
      <span class="pane-eyebrow">Preview</span>
    </div>
    <!-- A plain <div>'s implicit "generic" role does not support an author-supplied name — role="region"
         makes this a genuine labelled landmark so `aria-label` is actually exposed to assistive tech. -->
    <!-- eslint-disable vue/no-v-html -- safeHtml is DOMPurify-sanitized, see render/sanitizer.ts -->
    <div
      ref="hostRef"
      class="preview-pane text-wrap-safe"
      role="region"
      aria-label="Rendered document preview"
      v-html="safeHtml"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>

<style scoped>
.preview-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.preview-toolbar {
  display: flex;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border-bottom: 2px solid var(--border-color, #ddd);
  /* Same distinct-surface + visible-label treatment as Editor/HUD/transcript. */
  background: var(--panel-bg, #f7f7f8);
}
/* .pane-eyebrow's shared text styling now lives in style.css. */
/* This renders the exact same markdown, through the exact same `render()` pipeline, as
   MessageBubble.vue's `.message-text` — so it carries the same risk of an unbroken run (a long
   URL, identifier, or fenced-code line) overflowing the pane. `.text-wrap-safe`'s shared
   overflow-wrap/pre/code handling (applied via the template class) lives in style.css. */
.preview-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
  text-align: left;
}
</style>
