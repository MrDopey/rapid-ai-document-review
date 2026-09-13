import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation, StagedEditRow } from '../../src/storage/storage-adapter.js';

/**
 * `preview.ts` reads `RADR_BE_HUNK_CONTEXT_LINES` exactly once, at module-evaluation time (same
 * pattern `config.ts` uses — see `config.test.ts`), so every case here sets `process.env` *before*
 * a fresh dynamic `import()`, guarded by `vi.resetModules()`.
 */
describe('preview.ts line-based hunk context', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RADR_BE_HUNK_CONTEXT_LINES;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function makeEdit(operations: EditOperation[]): StagedEditRow {
    return {
      id: 'edit-1',
      documentId: 'doc-1',
      conversationId: 'conv-1',
      piToolCallId: 'tool-call-1',
      sourceRevision: 1,
      summary: 'test edit',
      operations,
      status: 'pending',
      autoApplied: false,
      appliedRevision: null,
      supersedesId: null,
      conflictDetail: null,
      replacementAttempt: 0,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
  }

  it('defaults to 3 lines of context before and after when the env var is unset', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = ['l0', 'l1', 'l2', 'l3', 'TARGET', 'l5', 'l6', 'l7', 'l8'].join('\n');

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.reconcilable).toBe(true);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.contextBefore).toBe('l1\nl2\nl3\n');
    expect(result.hunks[0]!.contextAfter).toBe('\nl5\nl6\nl7\n');
  });

  it('honors RADR_BE_HUNK_CONTEXT_LINES=1 to shrink the window', async () => {
    process.env.RADR_BE_HUNK_CONTEXT_LINES = '1';
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = ['l0', 'l1', 'l2', 'l3', 'TARGET', 'l5', 'l6', 'l7', 'l8'].join('\n');

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.hunks[0]!.contextBefore).toBe('l3\n');
    expect(result.hunks[0]!.contextAfter).toBe('\nl5\n');
  });

  it('honors RADR_BE_HUNK_CONTEXT_LINES=5 to grow the window', async () => {
    process.env.RADR_BE_HUNK_CONTEXT_LINES = '5';
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = ['l0', 'l1', 'l2', 'l3', 'TARGET', 'l5', 'l6', 'l7', 'l8'].join('\n');

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    // Only 4 lines exist before/after TARGET — fewer than the configured 5 — so the window
    // clamps to what's actually there rather than padding or erroring.
    expect(result.hunks[0]!.contextBefore).toBe('l0\nl1\nl2\nl3\n');
    expect(result.hunks[0]!.contextAfter).toBe('\nl5\nl6\nl7\nl8');
  });

  it.each(['abc', '0', '-2', '', ' '])(
    'falls back to the default of 3 when RADR_BE_HUNK_CONTEXT_LINES=%p is invalid',
    async (invalid) => {
      process.env.RADR_BE_HUNK_CONTEXT_LINES = invalid;
      const { previewStagedEdit } = await import('../../src/edit/preview.js');
      const doc = ['l0', 'l1', 'l2', 'l3', 'TARGET', 'l5', 'l6', 'l7', 'l8'].join('\n');

      const result = previewStagedEdit(
        makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
        doc,
      );

      expect(result.hunks[0]!.contextBefore).toBe('l1\nl2\nl3\n');
      expect(result.hunks[0]!.contextAfter).toBe('\nl5\nl6\nl7\n');
    },
  );

  it('returns what exists (no padding, no error) when the edit is near the start of the document', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = ['TARGET', 'l1', 'l2', 'l3', 'l4'].join('\n');

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.hunks[0]!.contextBefore).toBe('');
    expect(result.hunks[0]!.contextAfter).toBe('\nl1\nl2\nl3\n');
  });

  it('returns what exists (no padding, no error) when the edit is near the end of the document', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = ['l0', 'l1', 'l2', 'l3', 'TARGET'].join('\n');

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.hunks[0]!.contextBefore).toBe('l1\nl2\nl3\n');
    expect(result.hunks[0]!.contextAfter).toBe('');
  });

  it('handles an edit that itself spans multiple lines', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = ['p0', 'p1', 'p2', 'X2', 'X3', 'n0', 'n1', 'n2'].join('\n');

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'X2\nX3', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.hunks[0]!.contextBefore).toBe('p0\np1\np2\n');
    expect(result.hunks[0]!.contextAfter).toBe('\nn0\nn1\nn2');
  });

  it('handles a document with no trailing newline where the edit is on the final line', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = 'l0\nl1\nTARGET';

    expect(doc.endsWith('\n')).toBe(false);

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.hunks[0]!.contextBefore).toBe('l0\nl1\n');
    expect(result.hunks[0]!.contextAfter).toBe('');
  });

  it('returns intentHunks with empty context when reconciliation fails', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = 'Something completely different.';

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.reconcilable).toBe(false);
    expect(result.intentHunks).toHaveLength(1);
    expect(result.intentHunks![0]!.operationIndex).toBe(0);
    expect(result.intentHunks![0]!.removed).toBe('TARGET');
    expect(result.intentHunks![0]!.added).toBe('REPLACED');
    expect(result.intentHunks![0]!.contextBefore).toBe('');
    expect(result.intentHunks![0]!.contextAfter).toBe('');
  });

  it('reconciles against sourceText when provided and sets alreadyApplied: true', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const sourceText = 'l0\nl1\nl2\nTARGET\nl4\nl5\nl6\nl7\nl8';
    const currentText = 'l0\nl1\nl2\nREPLACED\nl4\nl5\nl6\nl7\nl8'; // after apply

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      currentText,
      sourceText,
    );

    expect(result.reconcilable).toBe(true);
    expect(result.alreadyApplied).toBe(true);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.removed).toBe('TARGET');
    expect(result.hunks[0]!.added).toBe('REPLACED');
  });

  it('does not set alreadyApplied when sourceText is not provided', async () => {
    const { previewStagedEdit } = await import('../../src/edit/preview.js');
    const doc = 'l0\nl1\nTARGET\nl3';

    const result = previewStagedEdit(
      makeEdit([{ old_string: 'TARGET', new_string: 'REPLACED' }]),
      doc,
    );

    expect(result.reconcilable).toBe(true);
    expect(result.alreadyApplied).toBeUndefined();
  });
});
