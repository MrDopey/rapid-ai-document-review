import type {
  ConflictDetail,
  ConflictDetailOperation,
  EditOperation,
} from '@rapid-ai-document-review/shared/domain';

export type { ConflictDetail, ConflictDetailOperation, EditOperation };

export interface Patch {
  from: number;
  to: number;
  insert: string;
}

export type ReconcileResult =
  { outcome: 'clean'; patches: Patch[] } | { outcome: 'conflict'; detail: ConflictDetail };

interface ResolvedRange {
  index: number;
  from: number;
  to: number;
  insert: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let fromIndex = 0;
  for (;;) {
    const at = haystack.indexOf(needle, fromIndex);
    if (at === -1) break;
    count += 1;
    fromIndex = at + 1; // count overlapping occurrences too — still "not exactly one"
  }
  return count;
}

function findSingleOccurrence(haystack: string, needle: string): number {
  return haystack.indexOf(needle);
}

function rangesOverlap(a: ResolvedRange, b: ResolvedRange): boolean {
  return a.from < b.to && b.from < a.to;
}

/**
 * Anchored find/replace reconciliation (research R4). Automerge text merges never fail, so
 * "conflict" is defined at this layer: an old_string that doesn't resolve to exactly one
 * unambiguous, non-overlapping range in the current document text.
 */
export function reconcile(operations: EditOperation[], currentText: string): ReconcileResult {
  const resolved: ResolvedRange[] = [];
  const conflicts: ConflictDetailOperation[] = [];

  operations.forEach((op, index) => {
    const occurrences = countOccurrences(currentText, op.old_string);
    if (occurrences === 1) {
      const from = findSingleOccurrence(currentText, op.old_string);
      resolved.push({ index, from, to: from + op.old_string.length, insert: op.new_string });
    } else {
      conflicts.push({
        index,
        reason: occurrences === 0 ? 'not_found' : 'ambiguous',
        occurrences,
      });
    }
  });

  // Overlap check only applies among ranges that individually resolved.
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      if (rangesOverlap(a, b)) {
        if (!conflicts.some((c) => c.index === a.index)) {
          conflicts.push({ index: a.index, reason: 'overlapping', occurrences: 1 });
        }
        if (!conflicts.some((c) => c.index === b.index)) {
          conflicts.push({ index: b.index, reason: 'overlapping', occurrences: 1 });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => a.index - b.index);
    return { outcome: 'conflict', detail: { operations: conflicts } };
  }

  // Descending offset order so earlier offsets stay valid as each splice is applied.
  const patches: Patch[] = resolved
    .sort((a, b) => b.from - a.from)
    .map((r) => ({ from: r.from, to: r.to, insert: r.insert }));

  return { outcome: 'clean', patches };
}
