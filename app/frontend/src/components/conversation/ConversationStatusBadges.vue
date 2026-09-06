<script setup lang="ts">
import { useConversationStatusBadges } from '../../composables/conversationStatusBadges.js';

const props = defineProps<{ conversationId: string }>();
const { badges } = useConversationStatusBadges(() => props.conversationId);
</script>

<template>
  <span
    v-for="b in badges"
    :key="b.key"
    class="badge"
    :class="b.className"
    :data-status="b.dataStatus"
    :title="b.title"
    :aria-label="b.ariaLabel"
    >{{ b.label }}</span
  >
</template>

<style scoped>
/* Color rules moved verbatim here from `HudPanel.vue` and `ConversationThreadBox.vue` (both had
   their own copy of these exact same rules) — see `conversationStatusBadges.ts`'s own doc comment
   for the two spots where the two pre-existing copies actually differed (the Stale tooltip text,
   and the closed-status color) and which value was kept as canonical. */
.stale-badge {
  color: var(--warning-color, #92400e);
}
.orphaned-badge {
  color: var(--warning-color, #92400e);
  background: var(--warning-bg, #fef3c7);
}
.status-badge[data-status='idle'] {
  color: var(--neutral-muted-color, #4b5563);
}
.status-badge[data-status='working'] {
  color: var(--status-active-color, #1d4ed8);
}
.status-badge[data-status='errored'] {
  color: var(--danger-color, #b91c1c);
}
.status-badge[data-status='closed'] {
  color: var(--danger-color, #b91c1c);
}
/* Parity fix: pending-proposal-count/queue-position badge colors, moved verbatim here from
   `HudPanel.vue` — see `conversationStatusBadges.ts`'s own doc comment for why these two are now
   part of this shared composable's output instead of `HudPanel.vue`-only markup. */
.pending-badge {
  color: var(--status-active-color, #1d4ed8);
}
.queue-badge {
  color: var(--queue-color, #6b21a8);
}
</style>
