/**
 * 011-linear-thread-mode, `DoneThreadsPanel.vue`'s column-per-done-thread redesign: given a done
 * Thread, walks `parentId` upward to the root, returning the ordered (root-first) ancestor chain —
 * each ancestor's own messages pre-sliced up to and including the point the NEXT thread down the
 * chain (its child, moving toward the target) forked from — plus the target thread's own full,
 * unsliced message list. Pure/testable — no store or component coupling; `DoneThreadColumn.vue`
 * supplies `findThread`/`messagesFor` as thin closures over `useThreadStore()`.
 *
 * "Ancestor" here always means an ancestor of the ORIGINAL `threadId` passed in, never the target
 * itself — the target's own messages are returned separately (`ownMessages`, always the FULL list,
 * never sliced), matching the settled design: only an ancestor's trailing (post-fork) messages
 * belong to a sibling path and get cut; the thing the reviewer actually opened Done view to read
 * never does.
 */

export interface AncestorChainThread {
  id: string;
  name: string;
  parentId: string | null;
  /** The message id, within this thread's own PARENT, this thread was forked from — `null` for a
   *  root thread (data-model.md's `forkedFromMessageId`, same field `useThreadSegments.ts` reads). */
  forkedFromMessageId: string | null;
}

export interface AncestorChainEntry<TMessage> {
  threadId: string;
  threadName: string;
  /** This ancestor's own messages, sliced up to and including the message the next thread down the
   *  chain forked from. Falls back to this ancestor's full message list when that boundary message
   *  can't be found among its (possibly not-yet-loaded) messages — defensive only; real data always
   *  has the fork anchor inside its own parent's history. */
  messages: TMessage[];
}

export interface AncestorChain<TMessage> {
  /** Root-first. Empty when `threadId` itself is a root thread (no ancestors). */
  ancestors: AncestorChainEntry<TMessage>[];
  /** The target thread's own full (unsliced) message list. Empty (with `ancestors` also empty) when
   *  `threadId` can't be resolved via `findThread` at all. */
  ownMessages: TMessage[];
}

export function buildAncestorChain<TMessage extends { id: string }>(
  threadId: string,
  findThread: (id: string) => AncestorChainThread | null,
  messagesFor: (id: string) => readonly TMessage[],
): AncestorChain<TMessage> {
  const target = findThread(threadId);
  if (!target) return { ancestors: [], ownMessages: [] };

  // Walk parentId upward, child-first. `visited` guards against a corrupt/cyclic parentId chain —
  // defensive only, real data is always a tree — rather than looping forever.
  const ancestorsChildFirst: AncestorChainThread[] = [];
  const visited = new Set([target.id]);
  let cursor = target.parentId;
  while (cursor && !visited.has(cursor)) {
    const parent = findThread(cursor);
    if (!parent) break;
    ancestorsChildFirst.push(parent);
    visited.add(parent.id);
    cursor = parent.parentId;
  }
  const ancestorsRootFirst = ancestorsChildFirst.reverse();
  const chainRootFirst = [...ancestorsRootFirst, target];

  const ancestors: AncestorChainEntry<TMessage>[] = ancestorsRootFirst.map((ancestor, index) => {
    // The NEXT thread down the chain (this ancestor's child, one step closer to the target) is
    // what actually forked off this ancestor — its `forkedFromMessageId` is the boundary this
    // ancestor's own messages get sliced at.
    const next = chainRootFirst[index + 1]!;
    const boundaryId = next.forkedFromMessageId;
    const messages = messagesFor(ancestor.id);
    const boundaryIndex = boundaryId ? messages.findIndex((m) => m.id === boundaryId) : -1;
    const sliced = boundaryIndex === -1 ? messages.slice() : messages.slice(0, boundaryIndex + 1);
    return { threadId: ancestor.id, threadName: ancestor.name, messages: sliced };
  });

  return { ancestors, ownMessages: messagesFor(target.id).slice() };
}
