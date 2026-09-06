<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import ConversationView from './ConversationView.vue';

// One instance of this component renders per id in App.vue's `focusedConversationIds` set. Each
// instance owns its own `ConversationView`, its own close button, and its own `useFocusTrap`
// registration — but `active` (passed down from App.vue, true only for whichever conversation was
// most recently interacted with) is what actually turns Tab-trapping/Escape on for *this*
// instance; every other simultaneously-open panel renders with its trap inactive. This reuses
// `focus-manager.ts`'s existing `activeTraps` LIFO stack as-is (no new stack semantics needed)
// since App.vue guarantees at most one panel ever has `active: true` at once.
// `atFocusCap`/`maxFocused`: App.vue's own live focus-cap state, passed straight through to
// `ConversationView.vue`'s "Branch" button — this panel is purely a pass-through here, same as its
// `select`/`branch-created` emit relays below. Defaults match `ConversationView.vue`'s own (never
// at cap) so existing tests that mount this panel directly without them (e.g.
// MessageBubble.spec.ts) are unaffected.
const props = withDefaults(
  defineProps<{
    conversationId: string;
    active: boolean;
    atFocusCap?: boolean;
    maxFocused?: number;
  }>(),
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
//
// `getPreferredInitialFocus`: prefer this panel's own composer textarea over the default
// first-focusable element ("Close full view", per DOM order — see the template below) — this both
// fixes the pre-existing bug where activating a panel focused the close button instead of the
// composer, and is what makes the cycle-focused-conversations hotkey (App.vue's
// `cycleFocusedConversation`, fired from Ctrl+Alt+H/L/N or the Arrow variants) land the user back in
// the newly-active panel's composer, ready to keep typing, rather than needing an extra Tab press.
//
// `restoreFocusOnExit: false` — this panel's `active` prop is a SELECTION signal among possibly
// several simultaneously-mounted sibling panels (the multi-focus overlay), not an open/close
// signal: going from `active: true` to `false` normally means "a different, still-open sibling
// just became active," never "this dialog is closing." The default restore-on-exit behavior (give
// focus back to whatever had it before this activated) is wrong here — see `restoreFocusOnExit`'s
// own doc comment in focus-manager.ts for the full race this avoids (a stale `previouslyFocused`
// pointing into a co-existing sibling panel, whose refocusing silently flips `lastInteractedId`
// right back and undoes the very switch that just happened).
useFocusTrap(dialogEl, () => props.active, {
  onEscape: () => emit('close'),
  getPreferredInitialFocus: () =>
    dialogEl.value?.querySelector<HTMLElement>(`#composer-${props.conversationId}`) ?? null,
  restoreFocusOnExit: false,
});

const name = computed(
  () => store.conversations.find((c) => c.id === props.conversationId)?.name ?? 'Conversation',
);
</script>

<template>
  <Transition name="modal" appear>
    <div
      ref="dialogEl"
      class="conversation-detail-dialog dialog-box"
      role="dialog"
      aria-modal="true"
      :aria-label="`${name} — full view`"
      @focusin="emit('interact')"
      @mousedown.capture="emit('interact')"
    >
      <button
        type="button"
        class="close-detail-button"
        aria-label="Close full view"
        @click="emit('close')"
      >
        ×
      </button>
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
  </Transition>
</template>

<style scoped>
/* This panel is one flex item among possibly several inside App.vue's `.conversation-detail-overlay`
   row — sized to a comfortable reading width rather than centered/full-width, since more than one
   may be visible side by side. */
/* Background/color/border-radius/box-shadow now live in style.css's shared `.dialog-box` class
   (applied via the template class above); only this dialog's own layout/sizing stays here. */
.conversation-detail-dialog {
  position: relative;
  /* `flex-shrink: 0` (this panel's old behavior) refused to ever render narrower than 480px, even
     when `.conversation-detail-overlay`'s own box (pinned to Canvas's live grid column — see
     `conversationOverlayStyle`'s doc comment in App.vue) is narrower than that — e.g. Canvas's
     column commonly measures well under 480px at ordinary laptop widths (~1280-1440px) once
     History is open and reserves its own fixed-width column. A flex child that refuses to shrink
     doesn't get clipped by the row's own `overflow-x: auto` in that case — a centered flex/grid
     item wider than its scroll container paints its *start-edge* overflow unclipped by default
     (only the end-edge overflow is what `overflow-x: auto` actually makes reachable via
     scrolling) — so the excess width bled straight out the *left* edge, visibly overlapping
     whatever renders to Canvas's left (Preview, or Preview+Editor). Allowing this to shrink (down
     to 0, overriding the flex-item default `min-width: auto` floor, which would otherwise still
     block shrinking below the message list's own intrinsic content width) instead keeps the panel
     fully inside the overlay's actual box — narrower than the usual 480px only when the container
     genuinely doesn't have that much room, never overlapping a neighboring pane. */
  flex: 0 1 min(480px, 92vw);
  min-width: 0;
  width: min(480px, 92vw);
  padding: 1.25rem 1rem 1rem;
  max-height: 100%;
  overflow: auto;
  text-align: left;
}
.close-detail-button {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  width: 1.75rem;
  height: 1.75rem;
  line-height: 1;
  padding: 0;
  /* `--z-raised` (style.css `:root`) — this only needs to beat this dialog's own unstyled (auto)
     content directly below it in the same stacking context; `.conversation-detail-dialog` (the
     dialog itself, `position: relative`) already establishes its own via this button's own
     `position: absolute`, so this can never collide with any app-level overlay's z-index. */
  z-index: var(--z-raised, 1);
}
/* `ConversationView.vue`'s own header-actions "Close"/"Request review" button is the last cell of
   a 3-column grid that reaches all the way to this dialog's own content edge (1rem in from the
   dialog's border, per this dialog's own padding) — directly underneath this floating "×" button
   (0.4rem in, 1.75rem wide) with no gap between the two distinct controls. Reserving extra
   clearance on the header only (rather than widening the whole dialog's padding, which would also
   shrink the message-list/composer for no reason) keeps them visually and functionally separate. */
.conversation-detail-dialog :deep(.conversation-header) {
  padding-right: 2.75rem;
}
</style>
