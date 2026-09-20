import { computed, nextTick, ref, type Ref } from 'vue';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { ApiError } from '../transport/http-client.js';

export interface ConversationRename {
  isEditingName: Ref<boolean>;
  nameDraft: Ref<string>;
  renameError: Ref<string | null>;
  renameSaving: Ref<boolean>;
  startEditingName: () => Promise<void>;
  cancelEditingName: () => void;
  saveName: () => Promise<void>;
}

/**
 * The minimal shape this composable needs out of whichever store owns the conversation/Thread being
 * renamed — kept narrow (rather than importing a specific store type) so the SAME composable can
 * drive both canvas mode's `useConversationsStore()` and Thread mode's `useThreadStore()`, matching
 * this codebase's established "narrow accessor, not a whole store" convention
 * (`threadTreeOrder.ts`'s own `ThreadTreeOrderSource`, `agentErrorBanner.ts`'s `status` getter).
 */
export interface ConversationRenameSource {
  find: () => ConversationDto | null;
  rename: (id: string, name: string) => Promise<unknown>;
}

/**
 * Shared click-to-edit conversation-title rename affordance, used by `ConversationThreadBox.vue`,
 * `ConversationView.vue`, and `ThreadCard.vue` (011-linear-thread-mode parity fix — a Thread's own
 * name can be renamed exactly the same way a canvas conversation's can), following the same
 * "one action per slot" convention every other per-conversation action in this app uses: an inline
 * `<input>` replaces the plain-text title, save on Enter/blur, cancel on Escape (constitution's "UI
 * Conventions": no confirmation dialog for a reversible, single-field text edit). Mirrors
 * `useConversationBranchAction`'s shape (`conversationActions.ts`) — a composable taking a
 * conversationId accessor and returning the draft ref/save/cancel/start functions, consumed
 * identically by every host.
 *
 * `nameInputEl` is supplied by the caller (rather than owned here) — each host still declares its
 * own `ref<HTMLInputElement | null>(null)` for the `ref="nameInputEl"` template binding (a template
 * ref has to be a local binding the host's own template can see), and this composable just focuses/
 * selects through it. `source.find` already closes over whichever id the caller cares about (e.g.
 * `() => store.conversations.find((c) => c.id === props.conversationId) ?? null`), so there's no
 * separate `conversationId` parameter here.
 */
export function useConversationRename(
  nameInputEl: Ref<HTMLInputElement | null>,
  source: ConversationRenameSource,
): ConversationRename {
  const conversation = computed(() => source.find());

  const isEditingName = ref(false);
  const nameDraft = ref('');
  const renameError = ref<string | null>(null);
  const renameSaving = ref(false);

  async function startEditingName(): Promise<void> {
    if (!conversation.value) return;
    nameDraft.value = conversation.value.name;
    renameError.value = null;
    isEditingName.value = true;
    await nextTick();
    nameInputEl.value?.focus();
    nameInputEl.value?.select();
  }

  function cancelEditingName(): void {
    isEditingName.value = false;
    renameError.value = null;
  }

  async function saveName(): Promise<void> {
    if (!isEditingName.value || !conversation.value) return;
    const trimmed = nameDraft.value.trim();
    if (!trimmed) {
      // FR: empty-name validation — rejected inline, editing stays open so the user can fix it
      // (matching `branchError`'s inline-message convention in `conversationActions.ts`) rather
      // than silently reverting.
      renameError.value = 'Name cannot be empty';
      return;
    }
    if (trimmed === conversation.value.name) {
      // No-op edit (e.g. blur with nothing changed): close without a network round trip.
      isEditingName.value = false;
      renameError.value = null;
      return;
    }
    renameSaving.value = true;
    try {
      await source.rename(conversation.value.id, trimmed);
      isEditingName.value = false;
      renameError.value = null;
    } catch (err) {
      renameError.value =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to rename conversation.';
    } finally {
      renameSaving.value = false;
    }
  }

  return {
    isEditingName,
    nameDraft,
    renameError,
    renameSaving,
    startEditingName,
    cancelEditingName,
    saveName,
  };
}
