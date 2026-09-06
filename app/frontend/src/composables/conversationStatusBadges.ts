import { computed, type ComputedRef } from 'vue';
import { useConversationsStore } from '../stores/conversations.js';

/** One rendered status/warning pill. `dataStatus` is only ever set on the primary status badge
 *  (`conv.status`) — that's the one badge whose color is looked up via a `[data-status="…"]` CSS
 *  attribute selector (see `ConversationStatusBadges.vue`'s own `<style>`); `stale`/`orphaned`
 *  badges are unconditional (their color never varies by any further sub-state), so they carry no
 *  `dataStatus` of their own. `ariaLabel` mirrors the (rare) case where the accessible name needs
 *  to be the fuller `title` text rather than the badge's own short visible label — currently only
 *  the orphaned-anchor badge, matching `ConversationThreadBox.vue`'s pre-existing behavior. */
export interface StatusBadge {
  key: string;
  className: string;
  dataStatus?: string;
  label: string;
  title?: string;
  ariaLabel?: string;
}

/** 'compact' omits the pending-proposal-count/queue-position badges below (currently unused —
 *  every existing call site wants the full set, see each badge's own doc comment — but kept as an
 *  explicit opt-out rather than baking "always show everything" in, in case a future, denser
 *  surface needs the reduced set without duplicating this composable). Defaults to 'full'. */
export type StatusBadgeVariant = 'full' | 'compact';

export interface ConversationStatusBadges {
  badges: ComputedRef<StatusBadge[]>;
  /** `conversation.isPrimary` computed once here rather than each of
   *  `ConversationView.vue`/`ConversationThreadBox.vue`/`HudPanel.vue` deriving it independently for
   *  their own `.is-primary` class binding — see each consumer's own `--primary-indicator-shadow`
   *  usage in its `<style scoped>` block. */
  isPrimary: ComputedRef<boolean>;
}

/** The same three status pills render identically across `HudPanel.vue` (topnav),
 *  `ConversationThreadBox.vue` (sidebar/canvas box), and `ConversationView.vue` (focus/detail
 *  view): the primary `conversation.status` badge (always present), a `Stale` badge
 *  (`conversation.isStale`), and an `Orphaned` badge (`conversation.anchorOrphaned`). One
 *  shared composable is the single source for all three surfaces, so they can never drift apart.
 *
 *  The pending-proposal-count and queue-position badges (`conv.pendingEditCount`,
 *  `store.queueInfo`) are gated by `variant` (see `StatusBadgeVariant` above) so every consumer of
 *  this composable can show the same information, with no separate copy of this logic to keep in
 *  sync.
 *
 *  Two values are pinned as canonical and must not vary per surface: the "Stale" tooltip always
 *  uses the fuller text naming the "Refresh + Send" remedy (strictly more informative regardless of
 *  which surface renders it, even one with no composer of its own), and the closed-status color is
 *  always `--danger-color` (never a separate `--status-closed-color`). See
 *  `ConversationStatusBadges.vue`'s own doc comment for the color rule itself. */
export function useConversationStatusBadges(
  conversationId: () => string,
  variant: StatusBadgeVariant = 'full',
): ConversationStatusBadges {
  const store = useConversationsStore();
  const conversation = computed(() => store.conversations.find((c) => c.id === conversationId()) ?? null);
  const isPrimary = computed(() => conversation.value?.isPrimary ?? false);

  const badges = computed<StatusBadge[]>(() => {
    const conv = conversation.value;
    if (!conv) return [];
    const list: StatusBadge[] = [
      { key: 'status', className: 'status-badge', dataStatus: conv.status, label: conv.status },
    ];
    if (conv.isStale) {
      list.push({
        key: 'stale',
        className: 'stale-badge',
        label: 'Stale',
        title:
          'Stale: the document has changed since this conversation last saw it. Use "Refresh + Send" to update its context before sending.',
      });
    }
    // FR-011/SC-006: the conversation stays visible at its last known anchor position rather than
    // disappearing or moving once its highlighted text has been edited or removed — this badge is
    // the visual flag for that state.
    if (conv.anchorOrphaned) {
      const orphanedText =
        'This conversation was originally attached to a specific highlighted passage, but that text has since been edited or removed.';
      list.push({
        key: 'orphaned',
        className: 'orphaned-badge',
        label: 'Orphaned',
        title: orphanedText,
        ariaLabel: orphanedText,
      });
    }
    // specs/006-archivable-main-conversation FR-010/research.md §6: distinguishes a closed former
    // Main from the current Main (never `status: 'closed'`) and from any other closed conversation
    // when browsing conversation history. Keyed off kind+status only (not `isCurrentMain`) — the two
    // conditions are naturally exclusive since the current Main is never closed.
    if (conv.kind === 'main' && conv.status === 'closed') {
      list.push({ key: 'archived-main', className: 'archived-main-badge', label: 'Archived Main' });
    }
    if (variant === 'full' && conv.pendingEditCount > 0) {
      list.push({ key: 'pending', className: 'pending-badge', label: String(conv.pendingEditCount) });
    }
    const queue = variant === 'full' ? store.queueInfo[conv.id] : undefined;
    if (queue) {
      list.push({ key: 'queue', className: 'queue-badge', label: `Queued #${queue.queuePosition}` });
    }
    return list;
  });

  return { badges, isPrimary };
}
