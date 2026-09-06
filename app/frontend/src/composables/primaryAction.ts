import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useConversationsStore } from '../stores/conversations.js';
import { ApiError } from '../transport/http-client.js';
import { useFocusTrap } from '../a11y/focus-manager.js';
import { PRIMARY_EXPLANATION } from './constants.js';
import type { ActionDescriptor } from './conversationActions.js';
import type { PrimaryWhenBusy } from '@rapid-ai-document-review/shared/contracts/http';

/** FR-029: the target/current-Primary-busy warning, offering exactly the three `whenBusy` choices
 *  — set only while a designation request for THIS composable's own conversation is awaiting the
 *  user's decision. */
export interface PrimaryBusyPrompt {
  conversationId: string;
  currentPrimaryId: string | null;
  busyConversationId: string;
}

export interface UsePrimaryAction {
  /** Rendered through `ConversationActionButtons.vue` alongside every other per-conversation
   *  action (Focus/Close/Branch/Archive) — see each host's own `actions` computed. */
  action: ComputedRef<ActionDescriptor>;
  busyPrompt: Ref<PrimaryBusyPrompt | null>;
  busyDialogOpen: ComputedRef<boolean>;
  /** Name of whichever conversation is currently the busy Primary blocking the switch — the busy
   *  dialog's own confirmation text names it explicitly ("X is still working…"). */
  busyConversationName: ComputedRef<string>;
  resolveBusyPrompt: (whenBusy: PrimaryWhenBusy) => Promise<void>;
  /** Kept separate from `ActionDescriptor` (no room for a persistent error message there) — same
   *  convention `useConversationBranchAction`'s own `error` ref already uses; each host renders its
   *  own inline banner wherever it renders `branchError`/`renameError`. */
  error: Ref<string | null>;
}

/**
 * Shared Make/Clear Primary designation action plus its busy-switch confirmation dialog state,
 * used by both `ConversationThreadBox.vue` (sidebar/canvas box) and `ConversationView.vue`
 * (focus/detail view) — 006-toolbar-reorg's per-row HUD button is gone (the HUD list is purely
 * informational now); this is its replacement, following the exact same
 * "composable takes a conversationId accessor, host owns where the result renders" shape as
 * `useConversationBranchAction`/`useConversationRename` in this same directory.
 *
 * `dialogEl` is supplied by the caller (not owned here), same convention `useConversationRename`'s
 * `nameInputEl` param already establishes — a template ref has to be a local binding the host's own
 * template can see, and this composable just wires `useFocusTrap` through it.
 *
 * Each host component instance gets its own independent busy-prompt/dialog state (never shared
 * across instances) — a conversation can simultaneously have a sidebar box AND an open detail
 * panel, and each one's own Make/Clear Primary button should only ever open/control its own dialog,
 * scoped right where the triggering button lives (mirroring how `ConversationView.vue`'s own
 * close-confirmation dialog is already scoped per-instance, not shared globally).
 */
export function usePrimaryAction(conversationId: () => string, dialogEl: Ref<HTMLElement | null>): UsePrimaryAction {
  const store = useConversationsStore();
  const conversation = computed(() => store.conversations.find((c) => c.id === conversationId()) ?? null);
  const isPrimary = computed(() => conversation.value?.isPrimary ?? false);

  const busyPrompt = ref<PrimaryBusyPrompt | null>(null);
  const error = ref<string | null>(null);
  const designating = ref(false);
  const busyDialogOpen = computed(() => busyPrompt.value !== null);

  // FR-043d: opening the busy-switch warning moves focus to its first choice; Escape (or Cancel)
  // returns focus to the button that triggered it.
  useFocusTrap(dialogEl, busyDialogOpen, { onEscape: () => void resolveBusyPrompt('cancel') });

  function conversationName(id: string | null): string {
    if (!id) return 'none';
    return store.conversations.find((c) => c.id === id)?.name ?? id;
  }
  const busyConversationName = computed(() => conversationName(busyPrompt.value?.busyConversationId ?? null));

  /** Issues (or re-issues, with an explicit choice) a designation request for this composable's own
   *  conversation. On `409 PRIMARY_TARGET_BUSY`, opens the three-choice warning instead of
   *  surfacing an error. */
  async function makePrimary(whenBusy?: PrimaryWhenBusy): Promise<void> {
    const id = conversationId();
    error.value = null;
    designating.value = true;
    try {
      const result = await store.designatePrimary(id, whenBusy);
      if (result.applied !== 'cancelled') busyPrompt.value = null;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRIMARY_TARGET_BUSY') {
        const details = (err.details ?? {}) as { currentPrimaryId?: string | null; busyConversationId?: string };
        busyPrompt.value = {
          conversationId: id,
          currentPrimaryId: details.currentPrimaryId ?? null,
          busyConversationId: details.busyConversationId ?? id,
        };
      } else {
        error.value = err instanceof Error ? err.message : 'Failed to designate Primary.';
      }
    } finally {
      designating.value = false;
    }
  }

  async function resolveBusyPrompt(whenBusy: PrimaryWhenBusy): Promise<void> {
    if (!busyPrompt.value) return;
    if (whenBusy === 'cancel') busyPrompt.value = null;
    await makePrimary(whenBusy);
  }

  async function clearPrimary(): Promise<void> {
    error.value = null;
    try {
      await store.clearPrimary(conversationId());
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to clear Primary.';
    }
  }

  /** Always rendered (never a bare disabled control with no explanation) — same convention every
   *  other action's `title` in this app follows. */
  const title = computed(() => {
    if (isPrimary.value) return `Clear Primary (${conversation.value?.name ?? ''}) — ${PRIMARY_EXPLANATION}`;
    if (conversation.value?.status === 'closed') return "Closed conversations can't be made Primary";
    if (conversation.value?.status === 'errored') return 'An errored conversation cannot be designated Primary';
    return `Make Primary — ${PRIMARY_EXPLANATION}`;
  });

  const disabled = computed(() => {
    if (designating.value) return true;
    if (isPrimary.value) return false;
    return conversation.value?.status === 'closed' || conversation.value?.status === 'errored';
  });

  function onClick(): void {
    if (isPrimary.value) {
      void clearPrimary();
    } else {
      void makePrimary();
    }
  }

  const action = computed<ActionDescriptor>(() => ({
    key: 'primary',
    label: isPrimary.value ? 'Clear Primary' : 'Make Primary',
    title: title.value,
    ariaLabel: title.value,
    disabled: disabled.value,
    pressed: isPrimary.value,
    onClick,
  }));

  return { action, busyPrompt, busyDialogOpen, busyConversationName, resolveBusyPrompt, error };
}
