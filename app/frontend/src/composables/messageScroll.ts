/**
 * Shared "scroll so this message's own TOP edge is visible" helper, used by both
 * `ConversationThreadBox.vue` (sidebar) and `ConversationView.vue` (focus/detail view) — see each
 * call site's own doc comment for exactly when it's invoked (a newly-arrived message / a message
 * transitioning from collapsed to expanded).
 *
 * Deliberately NOT `Element.scrollIntoView`'s bare default: a plain `block: 'end'`/`'nearest'` (or
 * the old behaviour of scrolling the whole list to its bottom) can leave a long message's *tail*
 * in view instead of its beginning, which is exactly the UX bug this fixes. `block: 'start'` aligns
 * the message's own top edge with its scrollable ancestor's top edge instead.
 *
 * `headerEl`, when given, accounts for a sticky header that overlaps the top of the scrollable
 * area (`ConversationThreadBox.vue`'s `.thread-header`, `position: sticky; top: 0`) — without it, a
 * plain `block: 'start'` scroll would land the message exactly at the scrollport's top edge, which
 * is *underneath* the sticky header, hiding the very thing this is meant to reveal. `scroll-margin-
 * top`, set here (in JS, from the header's own live rendered height, rather than a guessed fixed
 * CSS value — this header's height varies with rename errors/branch-lineage/wrapped buttons) is the
 * browser-native way to tell `scrollIntoView` "leave this much room above the target" — it's
 * respected across every scrollable ancestor in the chain, not just the nearest one, which matters
 * here since `ConversationThreadBox.vue` itself doesn't scroll — its ancestor canvas
 * (`DocumentCanvas.vue`) does. `ConversationView.vue`'s own scrollable `.message-list` has no such
 * overlapping header, so it omits `headerEl` entirely (offset 0).
 */
export function scrollMessageTopIntoView(
  container: HTMLElement | null | undefined,
  messageId: string,
  headerEl?: HTMLElement | null,
): void {
  if (!container) return;
  const target = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!target) return;
  target.style.scrollMarginTop = headerEl ? `${headerEl.getBoundingClientRect().height}px` : '0px';
  target.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
