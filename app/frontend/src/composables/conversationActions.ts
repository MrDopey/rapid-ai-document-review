import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useConversationsStore } from '../stores/conversations.js';
import { ApiError } from '../transport/http-client.js';
import { focusCapBranchTooltip } from './focusConfig.js';

/**
 * One rendered action button, consumed by `ConversationActionButtons.vue`'s dumb `v-for` renderer.
 * `disabled` maps to the button's native `disabled` attribute (a real, unclickable block — used for
 * "Branch", which must never let a click reach the API once server-computed `canBranch` is false or
 * the live focus cap has no free slot). `ariaDisabled`/`pressed` are deliberately separate,
 * non-native attributes for toggle-style actions (currently only "Focus") that must stay keyboard-
 * reachable/clickable even while visually flagged as "won't do anything right now" — see
 * `ConversationThreadBox.vue`'s pre-existing `focus-button` doc comment for why that one was never a
 * native `disabled` control.
 */
export interface ActionDescriptor {
  key: string;
  label: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** aria-disabled only (independent of `disabled`) — see the interface doc comment above. */
  ariaDisabled?: boolean;
  /** aria-pressed, for a toggle-style action (currently only "Focus"). */
  pressed?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export interface UseConversationBranchActionOptions {
  /** Live "no free slot to auto-focus a new branch into" condition — a function (not a plain
   *  boolean) since both call sites pass through a prop that can change after this composable is
   *  first set up. */
  atFocusCap: () => boolean;
  maxFocused: () => number;
  /** Fired once branch creation actually succeeds, carrying the new conversation's id up to the
   *  host — mirrors the pre-existing `branch-created` emit both `ConversationThreadBox.vue` and
   *  `ConversationView.vue` already had. */
  onBranchCreated: (id: string) => void;
}

export interface ConversationBranchAction {
  action: ComputedRef<ActionDescriptor>;
  branching: Ref<boolean>;
  /** Kept separate from `ActionDescriptor` (which has no room for a persistent error message) —
   *  both existing call sites render their own inline error banner in a different place in their
   *  own template (an inline `span` in `ConversationThreadBox.vue`'s actions row, a top-level
   *  `.error-banner` in `ConversationView.vue`), so the host still owns where this renders. */
  error: Ref<string | null>;
}

/**
 * Shared "Branch this conversation" action descriptor, used by both `ConversationThreadBox.vue` and
 * `ConversationView.vue`: the same disabled-reason priority (server-computed `canBranch` first,
 * then the live focus-cap check) and tooltip/aria-label wording for both.
 */
export function useConversationBranchAction(
  conversationId: () => string,
  options: UseConversationBranchActionOptions,
): ConversationBranchAction {
  const store = useConversationsStore();
  const conversation = computed(
    () => store.conversations.find((c) => c.id === conversationId()) ?? null,
  );
  const branching = ref(false);
  const error = ref<string | null>(null);

  async function branchThisConversation(): Promise<void> {
    // Defense in depth (not just relying on the button's own native `disabled`): a click can only
    // ever reach here through `ActionDescriptor.onClick`, so this guard is what actually keeps
    // branch creation blocked for every one of `disabled`'s own reasons, regardless of how the host
    // renders the button.
    if (
      !conversation.value ||
      !conversation.value.canBranch ||
      branching.value ||
      options.atFocusCap()
    )
      return;
    error.value = null;
    branching.value = true;
    try {
      const branched = await store.branch({ parentConversationId: conversation.value.id });
      options.onBranchCreated(branched.id);
    } catch (err) {
      error.value =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to branch this conversation.';
    } finally {
      branching.value = false;
    }
  }

  /** Disabled-reason priority: the server-computed `canBranch` (closed/max-depth) wins over the "at
   *  focus cap" reason — the shared cap tooltip only applies once `canBranch` isn't the active
   *  reason. */
  const title = computed(() => {
    if (!conversation.value?.canBranch) return 'Maximum conversation depth reached';
    if (options.atFocusCap()) return focusCapBranchTooltip(options.maxFocused());
    return 'Branch this conversation';
  });
  const ariaLabel = computed(() => {
    if (!conversation.value?.canBranch)
      return 'Branch this conversation (maximum conversation depth reached)';
    if (options.atFocusCap())
      return `Branch this conversation (${focusCapBranchTooltip(options.maxFocused())})`;
    return 'Branch this conversation';
  });

  const action = computed<ActionDescriptor>(() => ({
    key: 'branch',
    label: 'Branch',
    title: title.value,
    ariaLabel: ariaLabel.value,
    disabled: !conversation.value?.canBranch || branching.value || options.atFocusCap(),
    onClick: () => void branchThisConversation(),
  }));

  return { action, branching, error };
}

export interface ConversationBulkToggleAction {
  action: ComputedRef<ActionDescriptor>;
}

/**
 * Shared "Expand all"/"Collapse all" bulk-toggle action descriptor, used by both
 * `ConversationThreadBox.vue` and `ConversationView.vue`. Reads/writes
 * `conversationsStore.expandedByMessage` (see that store's own doc comment) via `conversationId`
 * alone rather than a host-owned local ref — both components can be mounted at once for the same
 * conversation, so a local ref per host would let the two silently diverge; this way both hosts'
 * bulk toggle acts on the exact one state both of them render from.
 *
 * Bug fix: this control used to be hidden outright (via a `visible` flag gated on
 * `messages.length > 1`) whenever a conversation had 0 or 1 messages, which made the control
 * appear/disappear as messages streamed in — surprising, and against the constitution's "always
 * shown" convention for the other per-conversation actions in this same row. It's now always
 * rendered and always enabled, regardless of message count — clicking it with 0 or 1 messages is
 * simply a harmless no-op/single-message toggle (`toggleAllMessages` below already handles any
 * message count correctly).
 */
export function useBulkToggleAction(conversationId: () => string): ConversationBulkToggleAction {
  const store = useConversationsStore();
  const messages = computed(() => store.messagesFor(conversationId()));
  const expandedByMessage = computed(() => store.expandedByMessage[conversationId()] ?? {});
  const anyCollapsed = computed(() => messages.value.some((m) => !expandedByMessage.value[m.id]));
  const label = computed(() => (anyCollapsed.value ? 'Expand all' : 'Collapse all'));

  function toggleAllMessages(): void {
    const nextExpanded = anyCollapsed.value;
    const entries: Record<string, boolean> = {};
    for (const message of messages.value) {
      entries[message.id] = nextExpanded;
    }
    store.setMessagesExpanded(conversationId(), entries);
  }

  const action = computed<ActionDescriptor>(() => ({
    key: 'bulk-toggle',
    label: label.value,
    ariaLabel: `${label.value} messages in this conversation`,
    onClick: toggleAllMessages,
  }));

  return { action };
}
