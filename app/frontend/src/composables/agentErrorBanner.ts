import { ref, watch, type Ref } from 'vue';
import type { ConversationStatus } from '@rapid-ai-document-review/shared/contracts/http';

export interface AgentErrorBanner {
  /** Purely a local UI affordance — the underlying `status` (and its HUD/badge reflection) stays
   *  `'errored'` until a retry actually succeeds; this only lets the reviewer clear the banner out
   *  of the way in the meantime. */
  errorDismissed: Ref<boolean>;
  dismissError: () => void;
}

/**
 * Shared "dismissible agent-turn-error banner" state, factored out of `ConversationView.vue` (its
 * original, canvas-mode-only home) so `ThreadCard.vue` can show the exact same Retry/Dismiss banner
 * for a Thread's own failed agent turn (011-linear-thread-mode parity fix: `conversation_status_changed`
 * is emitted identically for a thread-kind conversation as for a canvas one, but Thread mode never
 * listened for it before this fix, so a failed turn there had no visible error and no way to retry).
 *
 * `status` is a getter (not a `Ref`/`ComputedRef`) so each caller can hand in its own already-reactive
 * accessor (`() => conversation.value?.status` / `() => thread.value?.status`) without this module
 * needing to know which store/prop it came from — same "narrow accessor, not a whole store" shape as
 * `threadTreeOrder.ts`'s own `ThreadTreeOrderSource`.
 */
export function useAgentErrorBanner(
  status: () => ConversationStatus | undefined,
): AgentErrorBanner {
  const errorDismissed = ref(false);

  function dismissError(): void {
    errorDismissed.value = true;
  }

  // Reset whenever a *new* error arrives (not merely re-observed), so a previous dismissal doesn't
  // hide a later, different failure.
  watch(status, (current, previous) => {
    if (current === 'errored' && previous !== 'errored') errorDismissed.value = false;
  });

  return { errorDismissed, dismissError };
}
