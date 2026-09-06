import type { Change } from 'diff';

/** One rendered line's worth of diff parts, in order (a line may contain a mix of unchanged/
 *  added/removed parts, e.g. "unchanged Xline unchanged"). Trailing `\n` stays attached to the
 *  last part of each line so re-joining every line's `parts` reproduces the original diff exactly
 *  — collapsing is purely a rendering concern, never a data transformation. */
export interface DiffLine {
  parts: Change[];
}

export type DiffGroup =
  | { type: 'visible'; lines: DiffLine[] }
  | { type: 'collapsed'; lines: DiffLine[] };

/** Splits a word- or line-level `Change[]` diff (from the `diff` package) into per-line groups.
 *  A single `Change` can span several lines (e.g. a long unchanged run) or be shorter than one
 *  (a single changed word) — this re-chunks by actual line breaks regardless of how the original
 *  diff happened to segment the text. */
export function splitIntoLines(parts: Change[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let current: Change[] = [];
  for (const part of parts) {
    if (part.value === '') continue;
    const pieces = part.value.split(/(?<=\n)/); // keep each line's trailing \n attached
    for (const piece of pieces) {
      if (piece === '') continue;
      current.push({ ...part, value: piece });
      if (piece.endsWith('\n')) {
        lines.push({ parts: current });
        current = [];
      }
    }
  }
  if (current.length > 0) lines.push({ parts: current });
  return lines;
}

/**
 * Groups diff lines into contiguous "visible" (within `contextLines` of a changed line) and
 * "collapsed" (unchanged, and too far from any change to matter) runs — the same context-window
 * idea as a classic unified diff, applied to a whole-document diff so a reviewer isn't stuck
 * scrolling past long unchanged stretches to find what actually changed. A `contextLines` of 0
 * still keeps every changed line itself, collapsing only the fully-unchanged runs between them.
 */
export function groupByContext(lines: DiffLine[], contextLines: number): DiffGroup[] {
  const hasChange = lines.map((line) => line.parts.some((p) => p.added || p.removed));
  const keep = lines.map(() => false);
  for (let i = 0; i < lines.length; i++) {
    if (!hasChange[i]) continue;
    const from = Math.max(0, i - contextLines);
    const to = Math.min(lines.length - 1, i + contextLines);
    for (let j = from; j <= to; j++) keep[j] = true;
  }

  const groups: DiffGroup[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const visible = keep[i];
    while (i < lines.length && keep[i] === visible) i++;
    groups.push({ type: visible ? 'visible' : 'collapsed', lines: lines.slice(start, i) });
  }
  return groups;
}

/** Flattens a group's per-line parts back into one `Change[]`, for handing to `DiffText`. */
export function groupParts(group: DiffGroup): Change[] {
  return group.lines.flatMap((line) => line.parts);
}
