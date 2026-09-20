import { useThreadSegments, type ThreadSegmentSibling } from './useThreadSegments.js';

/**
 * 011-linear-thread-mode (Thread mode's own HUD/focus mechanism): the minimal shape this module
 * needs out of `stores/thread.ts` — kept narrow (rather than importing the full store type) so
 * `buildThreadTreeOrder` stays a pure, independently-testable function against plain fixtures,
 * exactly like `conversationLayout.ts`'s own `ConversationLayoutInput` does for canvas mode.
 */
export interface ThreadTreeOrderSource {
  threads: readonly (ThreadSegmentSibling & {
    id: string;
    parentId: string | null;
    doneAt: string | null;
    createdAt: string;
  })[];
  messagesFor(threadId: string): readonly { id: string }[];
}

export interface ThreadTreeOrderEntry {
  id: string;
  /** Recursion depth — 0 for a top-level Thread, +1 per branch level, matching `ThreadCard.vue`'s
   *  own `depth` prop exactly (both walk the same active-child structure the same way). */
  depth: number;
}

/**
 * The exact left-to-right, top-to-bottom traversal order `ThreadModeView.vue`/`ThreadCard.vue`
 * already render the whole document's Thread tree in — factored out here (rather than
 * reimplemented) so `threadFocusState.ts`'s Ctrl+Alt+J/K cycling can never disagree with what's
 * actually on screen:
 *
 *  - Top-level entries are exactly `ThreadModeView.vue`'s own `topLevelThreadIds` (every active
 *    Thread with no active parent, i.e. a genuine root or a done thread's promoted active child —
 *    FR-011), sorted by `createdAt`.
 *  - Recursing into a Thread, its own active children are visited in the same order
 *    `ThreadCard.vue` renders its `.thread-branches` column: grouped by the segment (message) they
 *    forked from, in message order (`useThreadSegments`'s own segment order), and within one
 *    segment's group, in `threads` array order (mirroring `ThreadCard.vue`'s
 *    `activeChildIds`, which filters `segment.childBranchIds` — itself built from the same
 *    `threads`-array-order `siblings` list — without re-sorting it).
 *
 * A done thread's own (inactive) subtree is never visited, matching `ThreadCard.vue` never
 * rendering it inline (only reachable via `DoneThreadsPanel.vue`, out of scope for this HUD).
 */
export function buildThreadTreeOrder(store: ThreadTreeOrderSource): ThreadTreeOrderEntry[] {
  const activeThreads = store.threads.filter((t) => t.doneAt === null);
  const activeIds = new Set(activeThreads.map((t) => t.id));
  const topLevelIds = activeThreads
    .filter((t) => !t.parentId || !activeIds.has(t.parentId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => t.id);

  // Same shape `ThreadCard.vue`'s own `siblingAnchors` computed builds, in the same `threads`
  // array order — the one input `useThreadSegments` needs beyond a single Thread's own messages.
  const siblingAnchors: ThreadSegmentSibling[] = store.threads.map((t) => ({
    id: t.id,
    forkedFromMessageId: t.forkedFromMessageId,
  }));

  const entries: ThreadTreeOrderEntry[] = [];
  const visited = new Set<string>();

  function visit(threadId: string, depth: number): void {
    // Defends against a malformed/cyclical parent chain (shouldn't occur — this is UI ordering
    // code, not data-integrity enforcement) the same way `conversationLayout.ts#resolveAnchorRoot`
    // guards its own walk.
    if (visited.has(threadId)) return;
    visited.add(threadId);
    entries.push({ id: threadId, depth });

    const messages = store.messagesFor(threadId);
    const segments = useThreadSegments(threadId, messages, siblingAnchors);
    for (const segment of segments) {
      for (const childId of segment.childBranchIds) {
        if (activeIds.has(childId)) visit(childId, depth + 1);
      }
    }
  }

  for (const id of topLevelIds) visit(id, 0);
  return entries;
}
