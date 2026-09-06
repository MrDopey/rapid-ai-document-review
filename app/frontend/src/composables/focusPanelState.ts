import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useConversationsStore } from '../stores/conversations.js';
import { orderConversationsByAnchor } from '../components/canvas/conversationLayout.js';

/**
 * Multi-panel focus-set state machine: up to `focusCap` conversations may have an open detail panel
 * (`ConversationDetailPanel.vue`, one instance per id) simultaneously. `lastInteractedId` is a
 * separate "last-interacted" scalar: it backs `HudPanel.vue`'s Make-Primary/Clear-Primary targeting
 * *and* is the one signal that decides which single panel's `useFocusTrap` is active at any given
 * moment (every other simultaneously-open panel renders with its own trap inactive — see
 * `ConversationDetailPanel.vue`).
 *
 * `focusCap` is passed in (App.vue derives it from its own `.panes`-width `ResizeObserver` via
 * `useFocusCap`) rather than owned here, since it depends on viewport layout this composable has no
 * business knowing about.
 */
export function useFocusPanelState(focusCap: Ref<number> | ComputedRef<number>) {
  const conversationsStore = useConversationsStore();

  const focusedConversationIds = ref<Set<string>>(new Set());
  const lastInteractedId = ref<string | null>(null);

  const atFocusCap = computed(() => focusedConversationIds.value.size >= focusCap.value);

  function isFocused(id: string): boolean {
    return focusedConversationIds.value.has(id);
  }

  /** Adds `id` to the focused set if there's room under the live cap; a no-op (never auto-evicts
   *  the oldest focused conversation) if already at `focusCap` — matching every caller's own
   *  disabled-looking affordance for that same condition. */
  function focusConversation(id: string): void {
    if (isFocused(id)) {
      lastInteractedId.value = id;
      return;
    }
    if (focusedConversationIds.value.size >= focusCap.value) return;
    const next = new Set(focusedConversationIds.value);
    next.add(id);
    focusedConversationIds.value = next;
    lastInteractedId.value = id;
  }

  function unfocusConversation(id: string): void {
    if (!isFocused(id)) return;
    const next = new Set(focusedConversationIds.value);
    next.delete(id);
    focusedConversationIds.value = next;
    lastInteractedId.value = id;
    // Closing a conversation's focus panel is also the one moment an untouched branch placeholder
    // (created but never sent to, no draft left behind) gets cleaned up rather than left as
    // permanent clutter — see `discardIfEmpty`'s doc comment. Fire-and-forget: the panel itself has
    // already closed above regardless of outcome, and this is a no-op for every conversation that
    // isn't an eligible empty branch.
    void conversationsStore.discardIfEmpty(id);
  }

  /** `ConversationDetailPanel.vue`'s own `close` emit (Escape, or its "×" button) routes here
   *  instead of straight to `unfocusConversation` — deliberately, not merely a rename: an explicit
   *  *toggle-off* (Ctrl+Alt+<N>, or clicking "Focus" again on an already-focused row/box — both call
   *  `unfocusConversation` via `toggleFocus` above) is the user choosing to un-focus one specific
   *  conversation and nothing else, and must stay a plain, silent removal — auto-opening a
   *  different panel right after would be a surprising, uninvited side effect nobody asked for.
   *  Dismissing the panel itself (Escape/"×") reads differently: with no *other* panel left open,
   *  it leaves the user looking at an abruptly empty canvas with nothing focused at all — the
   *  "closing a tab" convention here is to land on a neighboring tab, not on a blank window. So only
   *  this entry point auto-advances to the next conversation (`orderConversationsByAnchor`'s same
   *  HUD/canvas order used everywhere else), and only when the panel just closed was the *only* one
   *  open — closing one of several simultaneously-focused panels leaves the rest exactly as they
   *  were, same as `unfocusConversation` alone always has. */
  function closeFocusedConversation(id: string): void {
    const wasOnlyFocused = isFocused(id) && focusedConversationIds.value.size === 1;
    unfocusConversation(id);
    if (!wasOnlyFocused) return;
    const byId = new Map(conversationsStore.conversations.map((c) => [c.id, c]));
    const ordered = orderConversationsByAnchor(conversationsStore.conversations, byId);
    const closedIndex = ordered.findIndex((c) => c.id === id);
    const nextConversation =
      closedIndex === -1 ? ordered[0] : (ordered[(closedIndex + 1) % ordered.length] ?? ordered[0]);
    // Guards the "this was the only conversation that exists at all" case, where the only
    // candidate is the one that just closed — nothing else to focus.
    if (nextConversation && nextConversation.id !== id) focusConversation(nextConversation.id);
  }

  /** The one toggle every Focus click (HudPanel row, ConversationThreadBox's Focus/Close buttons)
   *  calls: remove if present, else add if there's room. */
  function toggleFocus(id: string): void {
    if (isFocused(id)) unfocusConversation(id);
    else focusConversation(id);
  }

  /** Atomically swaps one focused conversation for another — used for "cursor" moves that should
   *  keep showing exactly one thing in that slot rather than adding a second panel: HudPanel's
   *  Ctrl+Alt+J/K cycling, and `ConversationView.vue`'s own internal navigation (e.g. "Request
   *  review" switching to the newly created review conversation, FR-036) reaching this via
   *  `ConversationDetailPanel.vue`'s `select` emit. Removing `oldId` first means this never has to
   *  consult the cap — the net size never grows. */
  function replaceFocus(oldId: string | null, newId: string): void {
    if (oldId === newId) {
      lastInteractedId.value = newId;
      return;
    }
    if (oldId === null || !isFocused(oldId)) {
      focusConversation(newId);
      return;
    }
    const next = new Set(focusedConversationIds.value);
    next.delete(oldId);
    next.add(newId);
    focusedConversationIds.value = next;
    lastInteractedId.value = newId;
  }

  /** Clicking the overlay's own backdrop (never a specific panel) closes every currently-focused
   *  conversation at once, the closest multi-panel equivalent of the old single-overlay's
   *  backdrop-dismiss. */
  function closeAllFocused(): void {
    const closedIds = [...focusedConversationIds.value];
    focusedConversationIds.value = new Set();
    lastInteractedId.value = null;
    // Same cleanup as `unfocusConversation` above, for every panel this backdrop-dismiss just closed.
    for (const id of closedIds) void conversationsStore.discardIfEmpty(id);
  }

  // Display order for the overlay's panels: always re-derived by filtering `HudPanel.vue`'s own
  // root-anchor ordering down to whichever ids are currently focused (never a separately maintained
  // order) — see `orderConversationsByAnchor`'s own doc comment in conversationLayout.ts for why
  // this is shared rather than reimplemented here.
  const orderedFocusedConversations = computed(() => {
    const byId = new Map(conversationsStore.conversations.map((c) => [c.id, c]));
    const focused = conversationsStore.conversations.filter((c) =>
      focusedConversationIds.value.has(c.id),
    );
    return orderConversationsByAnchor(focused, byId);
  });

  return {
    focusedConversationIds,
    lastInteractedId,
    atFocusCap,
    orderedFocusedConversations,
    focusConversation,
    unfocusConversation,
    closeFocusedConversation,
    toggleFocus,
    replaceFocus,
    closeAllFocused,
  };
}
