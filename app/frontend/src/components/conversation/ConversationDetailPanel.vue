<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import ConversationView from './ConversationView.vue';

// 005-canvas-conversation-threads (multi-focus overlay): one instance of this component renders
// per id in App.vue's `focusedConversationIds` set (replacing the single, App.vue-owned
// `.conversation-detail-overlay`/`.conversation-detail-dialog` pair that could only ever show one
// conversation at a time). Each instance owns its own `ConversationView`, its own close button, and
// its own `useFocusTrap` registration — but `active` (passed down from App.vue, true only for
// whichever conversation was most recently interacted with) is what actually turns Tab-trapping/
// Escape on for *this* instance; every other simultaneously-open panel renders with its trap
// inactive. This reuses `focus-manager.ts`'s existing `activeTraps` LIFO stack as-is (no new stack
// semantics needed) since App.vue guarantees at most one panel ever has `active: true` at once.
// `atFocusCap`/`maxFocused` (005-canvas-conversation-threads, branch-cap parity): App.vue's own
// live focus-cap state, passed straight through to `ConversationView.vue`'s "Branch" button — this
// panel is purely a pass-through here, same as its `select`/`branch-created` emit relays below.
// Defaults match `ConversationView.vue`'s own (never at cap) so existing tests that mount this
// panel directly without them (e.g. MessageBubble.spec.ts) are unaffected.
const props = withDefaults(
  defineProps<{ conversationId: string; active: boolean; atFocusCap?: boolean; maxFocused?: number }>(),
  { atFocusCap: false, maxFocused: 3 },
);
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'interact'): void;
  // Passes through `ConversationView.vue`'s own internal navigation (e.g. "Request review"
  // switching to the newly created review conversation, FR-036) — App.vue's handler swaps this
  // panel's own slot from `conversationId` to the new id (a `replaceFocus`, not a plain add), so a
  // panel that navigates internally doesn't need a free focus slot to keep showing something.
  (e: 'select', conversationId: string): void;
  // Passes through `ConversationView.vue`'s "Branch" button result — App.vue's handler adds the
  // new branch to the focus set (never replacing this panel's own conversation) only if there's a
  // free slot under the live focus cap; see `ConversationView.vue`'s `branch-created` doc comment.
  (e: 'branch-created', conversationId: string): void;
}>();

const store = useConversationsStore();
const dialogEl = ref<HTMLElement | null>(null);

// `() => props.active` (a getter, not a wrapped computed) so `useFocusTrap`'s internal `watch`
// always reads the current prop value directly — no separate ref to keep in sync.
useFocusTrap(dialogEl, () => props.active, { onEscape: () => emit('close') });

const name = computed(() => store.conversations.find((c) => c.id === props.conversationId)?.name ?? 'Conversation');
</script>

<template>
  <div
    ref="dialogEl"
    class="conversation-detail-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="`${name} — full view`"
    @focusin="emit('interact')"
    @mousedown.capture="emit('interact')"
  >
    <button type="button" class="close-detail-button" aria-label="Close full view" @click="emit('close')">×</button>
    <!-- `ConversationView.vue`'s own `select` emit must still reach App.vue — see the `select`
         emit's doc comment above. -->
    <ConversationView
      :conversation-id="conversationId"
      :at-focus-cap="atFocusCap"
      :max-focused="maxFocused"
      @select="emit('select', $event)"
      @branch-created="emit('branch-created', $event)"
    />
  </div>
</template>

<style scoped>
/* US4/T031 fix, extended for multi-focus: this panel is one flex item among possibly several
   inside App.vue's `.conversation-detail-overlay` row — sized to a comfortable reading width
   rather than centered/full-width, since more than one may be visible side by side. */
.conversation-detail-dialog {
  position: relative;
  flex: 0 0 auto;
  width: min(480px, 92vw);
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1.25rem 1rem 1rem;
  max-height: 100%;
  overflow: auto;
  text-align: left;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.close-detail-button {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  width: 1.75rem;
  height: 1.75rem;
  line-height: 1;
  padding: 0;
  z-index: 1;
}
/* Fix (overlapping close controls): `ConversationView.vue`'s own header-actions "Close"/"Request
   review" button is the last cell of a 3-column grid that reaches all the way to this dialog's own
   content edge (1rem in from the dialog's border, per this dialog's own padding) — which put it
   directly underneath this floating "×" button (0.4rem in, 1.75rem wide) with no gap between the
   two distinct controls. Reserving extra clearance on the header only (rather than widening the
   whole dialog's padding, which would also shrink the message-list/composer for no reason) keeps
   them visually and functionally separate. */
.conversation-detail-dialog :deep(.conversation-header) {
  padding-right: 2.75rem;
}
</style>
