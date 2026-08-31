import type { EditHunk, PreviewEditResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { reconcile } from '../document/text-anchor.ts';
import type { EditOperation, StagedEditRow } from '../storage/storage-adapter.ts';

const DEFAULT_HUNK_CONTEXT_LINES = 3;

/**
 * How many full lines of surrounding document text to include before/after each hunk's edited
 * span (replaces the old fixed 80-character window, which could cut mid-word and gave no more
 * text for a long line than a short one). Read once at module-evaluation time, mirroring the
 * read-env-once approach `config.ts` uses for its own settings; `RADR_BE_HUNK_CONTEXT_LINES` lets
 * an operator override it. This is a cosmetic preview knob rather than a required operational
 * setting, so an unset, non-numeric, or non-positive value silently falls back to the default
 * instead of throwing.
 */
function readHunkContextLines(): number {
  const raw = process.env.RADR_BE_HUNK_CONTEXT_LINES;
  if (raw === undefined) return DEFAULT_HUNK_CONTEXT_LINES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HUNK_CONTEXT_LINES;
}

const HUNK_CONTEXT_LINES = readHunkContextLines();

/** Applies already-resolved, descending-offset patches to a string copy — never the live document
 * (GET /edits/:id/preview must never mutate anything; contracts/http-api.md). */
function applyPatches(text: string, patches: { from: number; to: number; insert: string }[]): string {
  let result = text;
  for (const patch of patches) {
    result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
  }
  return result;
}

/** Offsets of the start of every line in `text` (index 0 is always the start of the document). */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Index of the line containing `offset`, i.e. the largest line index whose start is `<= offset`.
 * `lineStarts` is sorted ascending, so a binary search suffices. */
function lineIndexForOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Line-based context window around an edited span `[from, to)`. Walks back from the line
 * containing `from` by `contextLines` complete lines (clamped to the start of the document) and
 * forward from the line containing `to` by `contextLines` complete lines (clamped to the end of
 * the document, whether or not it ends in a trailing newline) — never a raw character count, so a
 * long line contributes exactly as much text as a short one. `from`/`to` may fall on different
 * lines for a multi-line edit; each bound is computed independently from its own end of the span.
 */
function lineContextWindow(
  text: string,
  from: number,
  to: number,
  contextLines: number,
): { contextBefore: string; contextAfter: string } {
  const lineStarts = lineStartOffsets(text);
  const lastLineIndex = lineStarts.length - 1;

  const fromLine = lineIndexForOffset(lineStarts, from);
  const beforeStartLine = Math.max(0, fromLine - contextLines);
  const contextBefore = text.slice(lineStarts[beforeStartLine]!, from);

  const toLine = lineIndexForOffset(lineStarts, to);
  const afterEndLine = Math.min(lastLineIndex, toLine + contextLines);
  const afterEndOffset = afterEndLine + 1 <= lastLineIndex ? lineStarts[afterEndLine + 1]! : text.length;
  const contextAfter = text.slice(to, afterEndOffset);

  return { contextBefore, contextAfter };
}

/** Builds one hunk per operation. Reconciliation already guarantees a clean proposal's every
 * `old_string` occurs exactly once, so re-locating it here via `indexOf` is safe and lets each
 * hunk be built against its own operation index without threading that index through `Patch`
 * (which text-anchor.test.ts asserts an exact shape for). */
function buildHunks(operations: EditOperation[], currentText: string): EditHunk[] {
  return operations.map((op, index) => {
    const from = currentText.indexOf(op.old_string);
    const to = from + op.old_string.length;
    const { contextBefore, contextAfter } = lineContextWindow(currentText, from, to, HUNK_CONTEXT_LINES);
    return {
      operationIndex: index,
      contextBefore,
      removed: op.old_string,
      added: op.new_string,
      contextAfter,
    };
  });
}

/** Read-only reconciliation preview (FR-022): never applies anything, mirrors `EditService.apply`'s
 * reconciliation exactly so what the user previews is what `apply()` would actually do. */
export function previewStagedEdit(edit: StagedEditRow, currentText: string): PreviewEditResponse {
  const result = reconcile(edit.operations, currentText);

  if (result.outcome === 'conflict') {
    return {
      stagedEditId: edit.id,
      reconcilable: false,
      fullPreview: null,
      hunks: [],
      conflictDetail: result.detail,
    };
  }

  return {
    stagedEditId: edit.id,
    reconcilable: true,
    fullPreview: applyPatches(currentText, result.patches),
    hunks: buildHunks(edit.operations, currentText),
    conflictDetail: null,
  };
}
