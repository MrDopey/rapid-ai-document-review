<script setup lang="ts">
import type { KeyboardShortcut } from '../../a11y/keymap-registry.js';

// Renders one scope's heading + entries as bare grid items (a multi-root/fragment component —
// Vue inserts these nodes as direct siblings in the parent, not inside a wrapper element) so every
// group's key-combo column is sized by the *same* shared grid (`.shortcut-list` in
// KeyboardShortcutsDialog.vue) instead of each group computing its own `max-content`
// independently. The `<dl>` below keeps `display: contents` so it stays out of the box tree
// entirely — its `<dt>`/`<dd>` children become grid items of that shared grid — while still being
// a real `<dl>` in the DOM for assistive tech.
defineProps<{
  scope: string;
  shortcuts: readonly KeyboardShortcut[];
}>();
</script>

<template>
  <h3>{{ scope }}</h3>
  <dl>
    <template v-for="shortcut in shortcuts" :key="shortcut.keys">
      <dt><kbd>{{ shortcut.keys }}</kbd></dt>
      <dd>{{ shortcut.description }}</dd>
    </template>
  </dl>
</template>

<style scoped>
/* `display: contents` removes the dl's own box so its dt/dd children lay out directly as items of
   the ancestor grid (defined once, in KeyboardShortcutsDialog.vue, on `.shortcut-list`) — this is
   what makes the key-combo column width shared across every group instead of per-group. */
dl {
  display: contents;
}
h3 {
  grid-column: 1 / -1;
  margin: 1rem 0 0.35rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.7;
}
h3:first-of-type {
  margin-top: 0;
}
dt {
  font-weight: 600;
  white-space: nowrap;
}
dd {
  margin: 0;
}
kbd {
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--panel-bg, #f7f7f8);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
}

/* On narrow viewports the shared grid collapses to a single column (see the container's own media
   query in KeyboardShortcutsDialog.vue); dt/dd fall into their own full-width rows, so let the key
   combo wrap instead of forcing nowrap. */
@media (max-width: 520px) {
  dt {
    white-space: normal;
  }
}
</style>
