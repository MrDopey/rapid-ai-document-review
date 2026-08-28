import type { EditHunk, PreviewEditResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { reconcile } from '../document/text-anchor.ts';
import type { EditOperation, StagedEditRow } from '../storage/storage-adapter.ts';

const HUNK_CONTEXT_CHARS = 80;

/** Applies already-resolved, descending-offset patches to a string copy — never the live document
 * (GET /edits/:id/preview must never mutate anything; contracts/http-api.md). */
function applyPatches(text: string, patches: { from: number; to: number; insert: string }[]): string {
  let result = text;
  for (const patch of patches) {
    result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
  }
  return result;
}

/** Builds one hunk per operation. Reconciliation already guarantees a clean proposal's every
 * `old_string` occurs exactly once, so re-locating it here via `indexOf` is safe and lets each
 * hunk be built against its own operation index without threading that index through `Patch`
 * (which text-anchor.test.ts asserts an exact shape for). */
function buildHunks(operations: EditOperation[], currentText: string): EditHunk[] {
  return operations.map((op, index) => {
    const from = currentText.indexOf(op.old_string);
    const to = from + op.old_string.length;
    return {
      operationIndex: index,
      contextBefore: currentText.slice(Math.max(0, from - HUNK_CONTEXT_CHARS), from),
      removed: op.old_string,
      added: op.new_string,
      contextAfter: currentText.slice(to, to + HUNK_CONTEXT_CHARS),
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
