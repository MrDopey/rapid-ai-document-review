import { computed, type ComputedRef } from 'vue';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useConversationsStore, type ConversationMessageState } from '../stores/conversations.js';

export interface ConversationContinuity {
  /** The parent conversation this one was branched from, if any (see `ConversationThreadBox.vue`'s
   *  `parentConversation` doc comment — this can only name the parent conversation as a whole,
   *  never a specific message within it, since no message-level fork-point field exists in the
   *  domain model beyond `forkedFromMessageId`). */
  parentConversation: ComputedRef<ConversationDto | null>;
  /** Read-only continuity context for a freshly-created, zero-message branch: the parent's last
   *  user message and last assistant message, up to and including `forkedFromMessageId`. Shared
   *  verbatim between `ConversationThreadBox.vue` (sidebar) and `ConversationView.vue` (focus/
   *  detail view) so both render identical continuity context — see each call site's own doc
   *  comment for why this only ever surfaces two borrowed messages, never this conversation's own. */
  continuityMessages: ComputedRef<ConversationMessageState[]>;
}

/**
 * Shared continuity-context logic, extracted from `ConversationThreadBox.vue` so
 * `ConversationView.vue`'s focus/detail view can render the exact same parent-continuity messages
 * the sidebar box does (bug fix: this had never been ported to the focus view, so a branch's
 * continuity context silently disappeared once its detail panel was opened). Relies on the
 * parent conversation's messages already being loaded into `store.messagesByConversation` — true
 * in practice because `DocumentCanvas.vue` mounts a `ConversationThreadBox` (which unconditionally
 * `loadDetail`s itself) for every conversation, parent included, regardless of focus state.
 */
export function useConversationContinuity(conversationId: () => string): ConversationContinuity {
  const store = useConversationsStore();
  const conversation = computed(() => store.conversations.find((c) => c.id === conversationId()) ?? null);
  const messages = computed(() => store.messagesFor(conversationId()));

  const parentConversation = computed<ConversationDto | null>(() =>
    conversation.value?.parentId
      ? (store.conversations.find((c) => c.id === conversation.value?.parentId) ?? null)
      : null,
  );

  const continuityMessages = computed<ConversationMessageState[]>(() => {
    const conv = conversation.value;
    if (!conv || messages.value.length > 0 || !conv.forkedFromMessageId) return [];
    const parentMessages = store.messagesFor(conv.parentId ?? '');
    const forkIndex = parentMessages.findIndex((m) => m.id === conv.forkedFromMessageId);
    if (forkIndex === -1) return [];
    const upToFork = parentMessages.slice(0, forkIndex + 1);
    const lastUser = [...upToFork].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...upToFork].reverse().find((m) => m.role === 'assistant');
    const result: ConversationMessageState[] = [];
    for (const m of upToFork) {
      if (m === lastUser || m === lastAssistant) result.push(m);
    }
    return result;
  });

  return { parentConversation, continuityMessages };
}
