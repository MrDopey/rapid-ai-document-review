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
</script>

<template>
  <div class="preview-container">
    <div class="preview-toolbar">
      <span class="pane-eyebrow">Preview</span>
    </div>
    <!-- A plain <div>'s implicit "generic" role does not support an author-supplied name — role="region"
         makes this a genuine labelled landmark so `aria-label` is actually exposed to assistive tech. -->
    <div ref="hostRef" class="preview-pane" role="region" aria-label="Rendered document preview" v-html="safeHtml"></div>
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
  /* Fix 2/6: same distinct-surface + visible-label treatment as Editor/HUD/transcript. */
  background: var(--panel-bg, #f7f7f8);
}
.pane-eyebrow {
  text-transform: uppercase;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  opacity: 0.6;
}
.preview-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
  text-align: left;
}
</style>
