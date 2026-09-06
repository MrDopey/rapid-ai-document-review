import { test, expect } from '@playwright/test';

const XSS_PAYLOAD = '<script>window.__xss_fired = true;</script>';
const MERMAID_BLOCK = '```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[End]\n```';

test.describe('US1 — create and edit a document with tracked history', () => {
  test('paste, edit+sync, debounce, restore, undo/redo, export, sanitizer', async ({
    page,
    context,
  }) => {
    await test.step('paste creates the document', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Paste your document' })).toBeVisible();
      await page.getByLabel('Document content').fill(
        `# Review Doc\n\nOriginal paragraph.\n\n${MERMAID_BLOCK}\n\n${XSS_PAYLOAD}`,
      );
      await page.getByRole('button', { name: 'Start reviewing' }).click();
      await expect(page.locator('.toolbar h1')).toHaveText('Review Doc');
    });

    await test.step('sanitizer strips the XSS payload from the DOM', async () => {
      const preview = page.locator('.preview-pane');
      await expect(preview).toBeVisible();
      const html = await preview.innerHTML();
      expect(html).not.toContain('<script>');
      const fired = await page.evaluate(() => (window as unknown as { __xss_fired?: boolean }).__xss_fired);
      expect(fired).toBeUndefined();
    });

    await test.step('mermaid diagram renders with readable labels', async () => {
      const svg = page.locator('.mermaid-rendered svg');
      await expect(svg).toBeVisible({ timeout: 10_000 });
      await expect(svg).toContainText('Start');
      await expect(svg).toContainText('Decision');
    });

    await test.step('clicking empty space below text still focuses the editor', async () => {
      const host = page.locator('.editor-host');
      const box = await host.boundingBox();
      if (!box) throw new Error('no bounding box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
      await page.keyboard.type('CLICKED-AT-BOTTOM');
      await expect(page.locator('.editor-host .cm-content')).toContainText('CLICKED-AT-BOTTOM');
      // Undo it so it doesn't interfere with later content assertions.
      await page.keyboard.press('Control+z');
      await expect(page.locator('.editor-host .cm-content')).not.toContainText('CLICKED-AT-BOTTOM');
    });

    await test.step('typed indentation does not compound across lines', async () => {
      const editor = page.locator('.editor-host .cm-content');
      await editor.click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('  first');
      await page.keyboard.press('Enter');
      await page.keyboard.type('  second');
      const lines = await page.locator('.editor-host .cm-line').allTextContents();
      expect(lines.find((l) => l.includes('first'))).toBe('  first');
      expect(lines.find((l) => l.includes('second'))).toBe('  second');
      // Clean up: undo the two typed lines.
      await page.keyboard.press('Control+z');
      await expect(editor).not.toContainText('second');
    });

    await test.step('edit in one tab syncs to a second connected tab', async () => {
      const editor = page.locator('.editor-host .cm-content');
      await editor.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Appended by tab one.');

      const page2 = await context.newPage();
      await page2.goto('/');
      await expect(page2.locator('.preview-pane')).toContainText('Appended by tab one.', {
        timeout: 10_000,
      });
      await page2.close();
    });

    await test.step('an edit made while PATCH is failing is retried, not lost', async () => {
      let failuresLeft = 3;
      await page.route('**/api/document', async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return route.abort('failed');
        }
        return route.continue();
      });

      const editor = page.locator('.editor-host .cm-content');
      await editor.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' RETRY-MARKER');
      await expect
        .poll(
          async () => {
            const res = await page.request.get('/api/document');
            const body = await res.json();
            return body.content as string;
          },
          { timeout: 15_000, intervals: [500] },
        )
        .toContain('RETRY-MARKER');

      await page.unroute('**/api/document');
    });

    await test.step('debounce creates a manual revision after inactivity', async () => {
      // revisionDebounceMs is seeded to 2000ms for this e2e run (see playwright.config.ts)
      await page.waitForTimeout(3000);
      await page.reload();
      const historyButton = page.getByRole('button', { name: 'History' });
      await historyButton.click();
      const entries = page.locator('.history-entry');
      await expect(entries.first()).toBeVisible();
      // At least creation + one manual_debounce; the exact count depends on how many debounce
      // windows elapsed across the several edits made in the steps above.
      expect(await entries.count()).toBeGreaterThanOrEqual(2);
    });

    let contentBeforeRestore = '';

    await test.step('restore an earlier revision', async () => {
      contentBeforeRestore = await page.locator('.editor-host').innerText();
      const oldestEntry = page.locator('.history-entry').last();
      await oldestEntry.getByRole('button', { name: 'Restore' }).click();
      // c92bf3f: Restore now opens a confirmation dialog (role="alertdialog") before actually
      // restoring — click through it to exercise the full restore flow.
      const restoreDialog = page.getByRole('alertdialog', { name: 'Restore revision' });
      await expect(restoreDialog).toBeVisible();
      await restoreDialog.getByRole('button', { name: 'Restore' }).click();
      await expect(restoreDialog).not.toBeVisible();
      await expect(page.locator('.preview-pane')).not.toContainText('Appended by tab one.');
    });

    await test.step('undo/redo works in the editor', async () => {
      await page.getByRole('button', { name: 'History' }).click(); // close panel
      const editor = page.locator('.editor-host .cm-content');
      await editor.click();
      await page.keyboard.type('undo-redo-probe');
      await expect(editor).toContainText('undo-redo-probe');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(editor).not.toContainText('undo-redo-probe');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
      await expect(editor).toContainText('undo-redo-probe');
    });

    await test.step('export downloads the current Markdown', async () => {
      await page.getByRole('button', { name: 'History' }).click(); // reopen panel
      const downloadLink = page.locator('.history-entry').first().getByRole('link', { name: 'Download' });
      const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
      const path = await download.path();
      expect(path).toBeTruthy();
    });

    void contentBeforeRestore;
  });
});
