<script setup lang="ts">
import type { ActionDescriptor } from '../../composables/conversationActions.js';

// Pure dumb renderer — never hardcodes which actions exist, only renders whatever list it's given
// (`HudPanel.vue` never mounts this at all; `ConversationThreadBox.vue`/`ConversationView.vue` each
// pass their own mix of shared + locally-defined descriptors — see each host's own template).
defineProps<{ actions: ActionDescriptor[] }>();
</script>

<template>
  <button
    v-for="a in actions"
    :key="a.key"
    type="button"
    class="action-button"
    :data-action="a.key"
    :disabled="a.disabled"
    :aria-disabled="a.ariaDisabled"
    :aria-pressed="a.pressed"
    :title="a.title"
    :aria-label="a.ariaLabel"
    :class="{ danger: a.danger }"
    @click="a.onClick"
  >
    {{ a.label }}
  </button>
</template>

<style scoped>
/* research.md §4: a real <button>, minimum 24x24px hit area — consolidated from the near-identical
   `.thread-action-button` rule this replaces in both `ConversationThreadBox.vue` and
   `ConversationView.vue`. */
.action-button {
  min-width: 24px;
  min-height: 24px;
  font-size: 0.7rem;
  padding: 0.15rem 0.55rem;
  color: var(--text-color, #111);
  background: var(--panel-bg-alt, #eef0f3);
  border: 1px solid var(--neutral-muted-color, #4b5563);
  border-radius: 4px;
  cursor: pointer;
}
.action-button:hover:not(:disabled) {
  background: var(--accent-color, #2563eb);
  border-color: var(--accent-color, #2563eb);
  color: var(--on-accent-color);
}
.action-button:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: 1px;
}
.action-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
/* Danger styling (e.g. Close/Archive) — consolidated from `.close-button` in both prior hosts. */
.action-button.danger {
  color: var(--danger-color, #b91c1c);
  border-color: var(--danger-color, #b91c1c);
}
.action-button.danger:hover:not(:disabled) {
  background: var(--danger-color, #b91c1c);
  border-color: var(--danger-color, #b91c1c);
  color: var(--on-accent-color);
}
/* Visual parity restoration for the one non-native-disabled toggle action ("Focus") — same cues
   `ConversationThreadBox.vue`'s pre-existing `.focus-button.is-focused`/`.focus-button.focus-
   disabled` rules gave it, now keyed off the generic `data-action`/`aria-pressed`/`aria-disabled`
   attributes every action already carries, rather than a per-action-name class. */
.action-button[data-action='focus'][aria-pressed='true'] {
  border-color: var(--accent-color, #2563eb);
  color: var(--accent-color, #2563eb);
}
.action-button[data-action='focus'][aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.55;
}
/* Make/Clear Primary (006-toolbar-reorg): same "pressed" visual cue as the Focus button above,
   keyed off the identical generic `data-action`/`aria-pressed` attributes — a Primary conversation's
   own button reads as "Clear Primary" (pressed) with the accent treatment. */
.action-button[data-action='primary'][aria-pressed='true'] {
  border-color: var(--accent-color, #2563eb);
  color: var(--accent-color, #2563eb);
}
</style>
