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
/* Canonical source for every conversation status/badge color shown across `HudPanel.vue`,
   `ConversationThreadBox.vue`, and `ConversationView.vue` — see `conversationStatusBadges.ts`'s own
   doc comment for the full rationale on why these live in one shared place. */
.stale-badge {
  color: var(--warning-color, #92400e);
}
/* Unlike `.stale-badge` above, Orphaned has no remedy action attached to it (the anchor just stays
   put at its last known position — see `anchorOrphaned`'s own doc comment in
   `conversationStatusBadges.ts`), so it's purely informational rather than an actionable warning —
   it therefore doesn't reuse the warning/amber used by Stale, which stays reserved for "action
   needed" states. It also doesn't reuse `.pending-badge`'s blue "active/informational" token below:
   Pending's proposed-edit count and Orphaned's anchor status are two different kinds of
   informational state, and sharing a color made them look confusingly identical. Orphaned instead
   gets its own neutral gray token pair — distinct from both Stale's actionable amber and Pending's
   informational-but-distinct blue. `.badge`'s shared `border: 1px solid currentColor` (see
   style.css) picks up this same gray for the border automatically. */
.orphaned-badge {
  color: var(--neutral-muted-color, #4b5563);
  background: var(--neutral-muted-bg, #d1d5db);
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
.pending-badge {
  /* Uses the same blue "active/informational" token pair as the `working` status badge below —
     the number of proposed changes is informational, not a warning, so it shares this token
     rather than the amber reserved for actionable states like Stale. `.orphaned-badge` above used
     to share this same blue pair too, but now uses its own neutral gray tokens so the two
     differently-meaning informational badges don't look identical. */
  color: var(--status-active-color, #1d4ed8);
  background: var(--status-active-bg, #dbeafe);
}
.queue-badge {
  color: var(--queue-color, #6b21a8);
}
</style>
