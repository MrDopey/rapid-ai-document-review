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

export interface ConversationStatusBadges {
  badges: ComputedRef<StatusBadge[]>;
}

/** Bug fix (ConversationView.vue never rendered a Stale/Orphaned-anchor badge — see the badge list
 *  below): the exact same three status pills `HudPanel.vue` (topnav) and `ConversationThreadBox.vue`
 *  (sidebar/canvas box) already each hand-duplicated — the primary `conversation.status` badge
 *  (always present), a `Stale` badge (`conversation.isStale`), and an `Orphaned anchor` badge
 *  (`conversation.anchorOrphaned`, previously only on `ConversationThreadBox.vue`) — consolidated
 *  into one shared composable so all three surfaces render identically and can never drift apart
 *  again. Deliberately excludes `pendingEditCount`/`queueInfo` — those stay `HudPanel.vue`-only
 *  counters, out of scope here (see that component's own template).
 *
 *  Deviation from the two pre-existing copies of this logic: the "Stale" tooltip differed between
 *  `HudPanel.vue` (the fuller text, naming the "Refresh + Send" remedy) and
 *  `ConversationThreadBox.vue` (a shorter sentence with no remedy named) — they were not actually
 *  identical, despite both describing the same state. The fuller `HudPanel.vue` wording is kept as
 *  the one canonical string here, since it's strictly more informative regardless of which surface
 *  renders it (even a surface with no composer of its own still benefits from knowing what fixes
 *  it). Likewise, `HudPanel.vue`'s `status-badge[data-status='closed']` color
 *  (`--status-closed-color`) differed from `ConversationThreadBox.vue`'s/`ConversationView.vue`'s
 *  own (`--danger-color`, per a documented "color-consistency fix" in `ConversationView.vue`) — the
 *  more recently, deliberately fixed `--danger-color` value is kept as canonical here too. See
 *  `ConversationStatusBadges.vue`'s own doc comment for the color rule itself. */
export function useConversationStatusBadges(conversationId: () => string): ConversationStatusBadges {
  const store = useConversationsStore();
  const conversation = computed(() => store.conversations.find((c) => c.id === conversationId()) ?? null);

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
        'Orphaned anchor: the highlighted text this conversation was anchored to has since been edited or removed.';
      list.push({
        key: 'orphaned',
        className: 'orphaned-badge',
        label: 'Orphaned anchor',
        title: orphanedText,
        ariaLabel: orphanedText,
      });
    }
    return list;
  });

  return { badges };
}
