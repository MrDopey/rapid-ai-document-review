<script setup lang="ts">
import { computed, ref } from 'vue';
import { KEYBOARD_SHORTCUTS } from '../../a11y/keymap-registry.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import ShortcutGroup from './ShortcutGroup.vue';

const emit = defineEmits<{ (e: 'close'): void }>();

const rootEl = ref<HTMLElement | null>(null);

// This component only ever exists in the DOM while the dialog is open (App.vue mounts/unmounts it
// via `v-if`, same pattern as DiffViewer.vue) — so "active" is simply "for as long as this
// component instance is alive"; useFocusTrap's own onBeforeUnmount handles returning focus to the
// "Keyboard shortcuts" toolbar button that triggered it.
useFocusTrap(rootEl, () => true, { onEscape: () => emit('close') });

// Group the flat registry by scope, preserving the order scopes first appear in — reused verbatim
// from a11y/keymap-registry.ts (the single source of truth for every shortcut) rather than
// re-deriving the list here.
const groups = computed(() => {
  const byScope = new Map<string, (typeof KEYBOARD_SHORTCUTS)[number][]>();
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    const list = byScope.get(shortcut.scope);
    if (list) {
      list.push(shortcut);
    } else {
      byScope.set(shortcut.scope, [shortcut]);
    }
  }
  return Array.from(byScope.entries(), ([scope, shortcuts]) => ({ scope, shortcuts }));
});
</script>

<template>
  <div
    ref="rootEl"
    class="keyboard-shortcuts-dialog dialog-box"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
  >
    <header class="dialog-header">
      <h2>Keyboard shortcuts</h2>
      <button type="button" class="close-button" @click="emit('close')">Close</button>
    </header>

    <!-- A single shared grid spanning every group (rather than one <dl> grid per group) so the
         key-combo column's `max-content` width is computed once, across the whole shortcut list,
         instead of independently per group — see ShortcutGroup.vue for how each group's heading
         and dt/dd pairs become items of *this* grid. -->
    <div class="shortcut-list">
      <ShortcutGroup
        v-for="group in groups"
        :key="group.scope"
        :scope="group.scope"
        :shortcuts="group.shortcuts"
      />
    </div>
  </div>
</template>

<style scoped>
/* Background/color/border-radius/box-shadow now live in style.css's shared `.dialog-box` class
   (applied via the template class above); only this dialog's own width/max-width/max-height/
   padding/overflow stay here. */
.keyboard-shortcuts-dialog {
  padding: 1rem;
  width: 48rem;
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
.shortcut-list {
  display: grid;
  /* Key-combo column is sized to its own content (never wider than the longest kbd across *every*
     group, since this single grid now spans the whole list), so it never eats space the
     description column needs; the description column absorbs everything else. */
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: baseline;
  column-gap: 1rem;
  row-gap: 0.5rem;
}

/* On narrow viewports a fixed two-column key-combo/description layout gets cramped, so switch the
   shared grid to a single fluid column: dt/dd fall into their own full-width rows (grid
   auto-flow), i.e. each key combo stacks directly above its description instead of squeezing side
   by side. (ShortcutGroup.vue has the matching `dt { white-space: normal }` override.) */
@media (max-width: 520px) {
  .keyboard-shortcuts-dialog {
    width: 100%;
  }
  .shortcut-list {
    grid-template-columns: 1fr;
    row-gap: 0.2rem;
  }
}
</style>
