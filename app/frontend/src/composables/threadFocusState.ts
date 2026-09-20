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

  /** The whole active tree, in on-screen left-to-right/top-to-bottom order — see
   *  `buildThreadTreeOrder`'s own doc comment for exactly what "order" means here. Recomputed live
   *  from the (reactive) thread store, same convention as `ThreadCard.vue`'s own
   *  `siblingAnchors`/`segments` computeds. */
  const orderedEntries = computed<ThreadTreeOrderEntry[]>(() => buildThreadTreeOrder(store));
  const orderedThreadIds = computed(() => orderedEntries.value.map((e) => e.id));

  /** A plain cursor jump — used both by a HUD row click (Thread mode's `toggle-focus` handler,
   *  since there is no real multi-focus set to toggle membership in — see `ThreadModeView.vue`'s
   *  own doc comment on that decision) and as the target of `cycleByOffset` below. */
  function jumpTo(threadId: string): void {
    activeThreadId.value = threadId;
  }

  /** Moves `activeThreadId` to the thread `offset` positions away from the current one within
   *  `orderedThreadIds` (wrapping around) — mirrors `HudPanel.vue`'s own `cycleByOffset` exactly,
   *  kept here too (rather than relying solely on `HudPanel.vue`'s copy, which independently
   *  computes the same result over the `items` list `ThreadModeView.vue` hands it) so this
   *  traversal/wrap behavior is directly unit-testable without mounting a component. */
  function cycleByOffset(offset: number): void {
    const list = orderedThreadIds.value;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((id) => id === activeThreadId.value);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length;
    activeThreadId.value = list[nextIndex]!;
  }

  return {
    activeThreadId,
    orderedEntries,
    orderedThreadIds,
    jumpTo,
    cycleByOffset,
  };
}
