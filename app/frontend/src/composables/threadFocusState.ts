import { computed, ref } from 'vue';
import { useThreadStore } from '../stores/thread.js';
import { buildThreadTreeOrder, type ThreadTreeOrderEntry } from './threadTreeOrder.js';

/**
 * 011-linear-thread-mode: Thread mode's own equivalent of `focusPanelState.ts` — but Thread mode
 * has no "N floating detail panels" concept to manage (every Thread/branch is already rendered
 * inline, always, by `ThreadCard.vue`; see `ThreadModeView.vue`'s own top doc comment), so there is
 * nothing here to reveal/hide. "Focus" in Thread mode means something simpler: a single
 * `activeThreadId` cursor position (this feature's HUD-list analog of `focusPanelState.ts`'s
 * `lastInteractedId`) that Ctrl+Alt+J/K moves over the tree in the exact same left-to-right,
 * top-to-bottom order the tree itself renders in (`threadTreeOrder.ts`'s `buildThreadTreeOrder`,
 * shared rather than reimplemented so the two can never disagree).
 *
 * Deliberately owns no DOM behavior of its own (no `scrollIntoView`, no CSS class toggling) — same
 * split as `App.vue`'s own `scrollBoxIntoView`, which lives in the component wiring this state up
 * (`ConversationDetailPanel`s), not in `focusPanelState.ts` itself. `ThreadModeView.vue` is this
 * composable's one caller, and owns the actual scroll-into-view + `.thread-card--active` highlight
 * side effect (a `watch` on `activeThreadId`).
 */
export function useThreadFocusState() {
  const store = useThreadStore();

  const activeThreadId = ref<string | null>(null);

  /** Set by `jumpTo`'s own `hotkey` option, read by `ThreadModeView.vue`'s `activeThreadId` watcher
   *  to decide how aggressively to scroll the newly-active `ThreadCard` into view: a genuine
   *  keyboard-driven jump (Ctrl+Alt+1..9/J/K/H/L, all of which end up going through `cycleByOffset`/
   *  `jumpToIndex` below) centers the target, since the user has no other visual cue for where focus
   *  just landed; a HUD row click (`jumpTo` called with no `hotkey` option, from a mouse click the
   *  user could already see land) only nudges the viewport the minimum amount needed. Deliberately a
   *  plain ref, not part of the `jumpTo` call's return value — the watcher reacts asynchronously to
   *  `activeThreadId` itself changing, so it needs this recorded somewhere it can still read it by
   *  the time it runs. */
  const wasHotkeyJump = ref(false);

  /** The whole active tree, in on-screen left-to-right/top-to-bottom order — see
   *  `buildThreadTreeOrder`'s own doc comment for exactly what "order" means here. Recomputed live
   *  from the (reactive) thread store, same convention as `ThreadCard.vue`'s own
   *  `siblingAnchors`/`segments` computeds. */
  const orderedEntries = computed<ThreadTreeOrderEntry[]>(() => buildThreadTreeOrder(store));
  const orderedThreadIds = computed(() => orderedEntries.value.map((e) => e.id));

  /** A plain cursor jump — used both by a HUD row click (Thread mode's `toggle-focus` handler,
   *  since there is no real multi-focus set to toggle membership in — see `ThreadModeView.vue`'s
   *  own doc comment on that decision) and as the target of `cycleByOffset` below. `opts.hotkey`
   *  (see `wasHotkeyJump` above) distinguishes the two callers — omitted (falsy) for a plain row
   *  click, `true` for every keyboard-driven caller. */
  function jumpTo(threadId: string, opts?: { hotkey?: boolean }): void {
    activeThreadId.value = threadId;
    wasHotkeyJump.value = opts?.hotkey === true;
  }

  /** Moves `activeThreadId` to the thread `offset` positions away from the current one within
   *  `orderedThreadIds` (wrapping around) — mirrors `HudPanel.vue`'s own `cycleByOffset` exactly,
   *  kept here too (rather than relying solely on `HudPanel.vue`'s copy, which independently
   *  computes the same result over the `items` list `ThreadModeView.vue` hands it) so this
   *  traversal/wrap behavior is directly unit-testable without mounting a component. Always a
   *  keyboard-driven caller (Ctrl+Alt+J/K, or Ctrl+Alt+H/L via `ThreadModeView.vue`'s exposed
   *  `cycleByOffset`) — see `jumpTo`'s `hotkey` option above. */
  function cycleByOffset(offset: number): void {
    const list = orderedThreadIds.value;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((id) => id === activeThreadId.value);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length;
    jumpTo(list[nextIndex]!, { hotkey: true });
  }

  /** Thread mode's own equivalent of App.vue's Ctrl+Alt+1..9 numbered-jump for canvas
   *  conversations (`onGlobalKeydown`'s `focus-toggle-<N>` handling there, which indexes into
   *  `orderedVisibleConversations`): jumps straight to the thread at `index` (0-based; `N - 1` for
   *  a 1-based Ctrl+Alt+<N> keypress) within `orderedThreadIds` — the exact same tree/DFS order the
   *  HUD list renders and `cycleByOffset` above traverses, so numbered-jump and J/K cycling can
   *  never disagree about "which thread is Nth". A no-op (matching canvas mode's own out-of-range
   *  no-op) when `index` is out of range, e.g. fewer than N threads currently visible. Always a
   *  keyboard-driven caller — see `jumpTo`'s `hotkey` option above. */
  function jumpToIndex(index: number): void {
    const id = orderedThreadIds.value[index];
    if (id) jumpTo(id, { hotkey: true });
  }

  return {
    activeThreadId,
    wasHotkeyJump,
    orderedEntries,
    orderedThreadIds,
    jumpTo,
    cycleByOffset,
    jumpToIndex,
  };
}
