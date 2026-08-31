import { test, expect } from '@playwright/test';

// Spec: specs/004-history-diff-view (FR-001 through FR-008).
//
// A "Diff" action on a revision row (except the very first) opens a read-only modal comparing
// that revision against the one immediately before it, with additions/removals visually
// distinguished, and never mutates document/revision/proposal state. This mirrors us1.spec.ts's
// style/conventions (test.step, page.goto('/'), the debounce-driven revision-creation flow) and
// is intentionally self-contained (creates its own document) so it does not depend on run order
// with the other story specs.
//
// NOTE: this file is not yet wired into playwright.config.ts's `stories`/`a11y` projects
// (testMatch is /us[1-7]\.spec\.ts/ and /a11y\.spec\.ts/ respectively) — run it directly via
// `npx playwright test tests/e2e/history-diff.spec.ts` until that's updated. It is expected to
// fail end-to-end (red phase) until the Diff feature is implemented.

const MARKER_REMOVED = 'HISTORY-DIFF-MARKER: original sentence that will be replaced.';
const MARKER_ADDED = 'HISTORY-DIFF-MARKER: replacement sentence after the edit.';

test.describe('History — Diff view (FR-001..FR-008)', () => {
  test('Diff on v2 shows added/removed content and never mutates history; v1 has no Diff button', async ({
    page,
  }) => {
    await test.step('create a fresh document (revision 1)', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Paste your document' })).toBeVisible();
      await page.getByLabel('Document content').fill(`# History Diff Fixture\n\n${MARKER_REMOVED}\n`);
      await page.getByRole('button', { name: 'Start reviewing' }).click();
      await expect(page.locator('.toolbar h1')).toHaveText('History Diff Fixture');
    });

    await test.step('edit the document and wait for the debounce to create revision 2', async () => {
      const editor = page.locator('.editor-host .cm-content');
      await editor.click();
      const line = page.locator('.cm-line', { hasText: 'HISTORY-DIFF-MARKER: original sentence' });
      await line.scrollIntoViewIfNeeded();
      await line.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.type(MARKER_ADDED);

      // revisionDebounceMs is seeded to 2000ms for this e2e run (see playwright.config.ts).
      await page.waitForTimeout(3000);
      await page.reload();
      await expect(page.locator('.preview-pane')).toContainText('replacement sentence after the edit');
    });

    let historyEntryCountBeforeDiff = 0;

    await test.step('open History and confirm v1 has no Diff button', async () => {
      await page.getByRole('button', { name: 'History' }).click();
      const entries = page.locator('.history-entry');
      await expect(entries.first()).toBeVisible();
      historyEntryCountBeforeDiff = await entries.count();
      expect(historyEntryCountBeforeDiff).toBeGreaterThanOrEqual(2);

      const v1Entry = page.locator('.history-entry', { hasText: 'v1' }).last();
      await expect(v1Entry.getByRole('button', { name: 'Diff' })).toHaveCount(0);
    });

    await test.step('click Diff on v2 and see added/removed content distinguished', async () => {
      const v2Entry = page.locator('.history-entry', { hasText: 'v2' }).first();
      await v2Entry.getByRole('button', { name: 'Diff' }).click();

      const diffDialog = page.getByRole('dialog', { name: 'Compare revisions' });
      await expect(diffDialog).toBeVisible();

      // Regression guard: the dialog previously had no `max-height`, so inside
      // `.modal-overlay`'s viewport-centering flexbox a long document's diff could grow far
      // taller than the viewport and push the header/Close button off-screen with no scrollbar
      // to reach it. `.toBeVisible()` alone doesn't catch this (it doesn't require the element to
      // be within the viewport) — `.toBeInViewport()` does.
      await expect(diffDialog).toBeInViewport();
      await expect(diffDialog.getByRole('button', { name: 'Close' })).toBeInViewport();

      const added = diffDialog.locator('.added, ins');
      const removed = diffDialog.locator('.removed, del');
      await expect(added.first()).toBeVisible();
      await expect(removed.first()).toBeVisible();
      await expect(added).toContainText('replacement sentence after the edit');
      await expect(removed).toContainText('original sentence that will be replaced');
    });

    await test.step('close the diff view and confirm no mutation happened', async () => {
      await page.getByRole('button', { name: 'Close' }).click();
      await expect(page.getByRole('dialog', { name: 'Compare revisions' })).toHaveCount(0);

      // Still on the History tab, listing exactly the same revisions as before the diff was
      // opened (FR-005/FR-008: viewing a diff must never create or alter a revision).
      const entries = page.locator('.history-entry');
      await expect(entries).toHaveCount(historyEntryCountBeforeDiff);
    });
  });
});
