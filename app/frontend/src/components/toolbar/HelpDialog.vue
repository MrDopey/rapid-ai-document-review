<script setup lang="ts">
import { ref } from 'vue';
import { useFocusTrap } from '../../a11y/focus-manager.js';

const emit = defineEmits<{ (e: 'close'): void }>();

const rootEl = ref<HTMLElement | null>(null);

// Same lifecycle as KeyboardShortcutsDialog.vue: this component only exists in the DOM while the
// dialog is open (App.vue mounts/unmounts it via `v-if`), so "active" is simply "alive" —
// useFocusTrap's own onBeforeUnmount returns focus to the "Help" toolbar button that opened it.
useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });
</script>

<template>
  <div ref="rootEl" class="help-dialog" role="dialog" aria-modal="true" aria-label="Help">
    <header class="dialog-header">
      <h2>Help</h2>
      <button type="button" class="close-button" @click="emit('close')">Close</button>
    </header>

    <div class="help-body">
      <section class="help-section">
        <h3>Getting started</h3>
        <ul>
          <li>
            Type a message to a conversation to ask questions or request changes to the document.
          </li>
          <li>
            Highlight text in the document and click "Branch (Main)" (or press Alt+Shift+S) to get
            a reviewable edit proposal instead of a direct answer — the proposal shows up under
            "Proposed edits", where you can preview it and choose to accept or drop it before
            anything changes in the document. "Branch (New)" (Alt+Shift+C) starts the same focused
            conversation with an empty transcript instead.
          </li>
        </ul>
      </section>

      <section class="help-section">
        <h3>What does "Primary" mean?</h3>
        <p>
          Edits from a <strong>Primary</strong> conversation apply to the document automatically,
          with no review step.
        </p>
        <p>
          Conversations that are not Primary work differently: any edit they propose stays
          <strong>pending</strong> in that conversation's "Proposed edits" list until you preview
          it and explicitly choose <strong>Accept</strong> (to apply it) or <strong>Drop</strong>
          (to discard it). A Primary conversation skips that review step entirely, so only make a
          conversation Primary once you trust its edits to land without a second look.
        </p>
      </section>

      <section class="help-section">
        <h3>What does "branching" mean?</h3>
        <p>
          Branching creates a new conversation that continues from the <strong>current</strong>
          point in an existing conversation, as its own separate thread — so you can explore a
          different direction without altering the original. When branching from a text selection
          in the document, "Branch (New)" (Alt+Shift+C) starts that thread empty, while "Branch
          (Main)" (Alt+Shift+S) also sends the selection as its first message to restore context.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.help-dialog {
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1rem;
  width: 32rem;
  max-width: 90vw;
  max-height: 85vh;
  overflow: auto;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
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
.help-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.help-section h3 {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
}
.help-section p {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  line-height: 1.4;
}
.help-section p:last-child {
  margin-bottom: 0;
}
.help-section ul {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.85rem;
  line-height: 1.4;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

@media (max-width: 520px) {
  .help-dialog {
    width: 100%;
  }
}
</style>
