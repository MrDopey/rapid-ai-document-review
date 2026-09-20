/**
 * 011-linear-thread-mode (FR-005b/FR-005c, data-model.md's "Thread segment"): purely a
 * frontend-only, derived rendering concern — never sent to or stored by the backend. Given one
 * Thread's own message list plus every OTHER Thread in the same document (each carrying the id of
 * the message, within its own parent Thread, it was forked from), this computes the ordered
 * `ThreadSegment[]` a Thread's rendering splits into: every message that is some other Thread's
 * fork anchor ends a segment right there, and the final segment (ending at the Thread's actual
 * current tip) is the only one flagged `isTipSegment` — the only one `ThreadCard.vue` may mount a
 * composer on (FR-005c). Pure function: no API calls, no Vue reactivity of its own — callers
 * (`ThreadCard.vue`) wrap it in a `computed()` themselves.
 */

export interface ThreadSegmentMessage {
  id: string;
}

export interface ThreadSegmentSibling {
  id: string;
  forkedFromMessageId: string | null;
}

export interface ThreadSegment {
  threadId: string;
  startIndex: number;
  endIndex: number;
  isTipSegment: boolean;
  childBranchIds: string[];
}

export function useThreadSegments(
  threadId: string,
  messages: readonly ThreadSegmentMessage[],
  otherThreads: readonly ThreadSegmentSibling[],
): ThreadSegment[] {
  if (messages.length === 0) return [];

  // Only OTHER threads' fork anchors ever split THIS thread's own rendering — a thread never
  // splits on its own `forkedFromMessageId` (that names where it was forked FROM in its PARENT,
  // not a point within its own history).
  const siblings = otherThreads.filter((t) => t.id !== threadId);
  const boundaryMessageIds = new Set(
    siblings.map((t) => t.forkedFromMessageId).filter((id): id is string => id !== null),
  );

  const segments: ThreadSegment[] = [];
  let start = 0;
  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    const messageId = messages[i]!.id;
    if (!isLast && !boundaryMessageIds.has(messageId)) continue;

    segments.push({
      threadId,
      startIndex: start,
      endIndex: i,
      isTipSegment: isLast,
      childBranchIds: siblings.filter((t) => t.forkedFromMessageId === messageId).map((t) => t.id),
    });
    start = i + 1;
  }
  return segments;
}
