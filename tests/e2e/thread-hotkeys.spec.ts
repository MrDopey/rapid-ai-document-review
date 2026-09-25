import { test, expect } from '@playwright/test';
import { createThreadDocument, sendThreadMessage, branchFromFirstMessage } from './test-utils.js';

// Spec: 011-linear-thread-mode. Regression coverage for a keyboard-dispatch bug no jsdom-based
// component test caught in practice (fix commit 0d2bec3 says it was "verified live via Playwright
// against a running dev server" in addition to its own unit/component tests — no e2e spec was
// ever committed for it).
test.describe('Thread mode — Ctrl+Alt+J/K hotkeys reachable from the composer (0d2bec3)', () => {
  test('Ctrl+Alt+J cycles the active thread while focus is inside a Thread composer textarea', async ({
    page,
  }) => {
    await test.step('two threads exist: the root and a branch off it', async () => {
      await createThreadDocument(page);
      await sendThreadMessage(page, 'First message in the root thread.');
      await branchFromFirstMessage(page);
      await expect(page.locator('.thread-mode-hud .conversation-row')).toHaveCount(2);
    });

    let activeBefore = '';
    await test.step('establish a known active thread, then focus a composer textarea and press Ctrl+Alt+J', async () => {
      // `threadFocus.activeThreadId` (ThreadModeView.vue) starts `null` — no `--active` class
      // exists yet until a HUD row is actually clicked once.
      await page.locator('.thread-mode-hud .conversation-row').first().click();
      await expect(page.locator('.thread-card-header--active')).toHaveCount(1);
      activeBefore = (await page.locator('.thread-card-header--active').textContent()) ?? '';
      expect(activeBefore).not.toBe('');

      const composer = page.locator('textarea[id^="thread-composer-"]').first();
      await composer.click();
      await expect(composer).toBeFocused();

      await page.keyboard.press('Control+Alt+j');
    });

    await test.step('the active thread actually changed — the hotkey was not a silent no-op', async () => {
      // Regression guard: before the fix, `HudPanel.vue`'s `onGlobalKeydown` never threaded the
      // binding's own `composerExempt` flag through to `isEditingContext`, so this keypress was
      // swallowed by the blanket "any textarea is an editing context" rule and nothing happened —
      // the composer is Thread mode's single most common real-world focus target, unlike canvas
      // mode which has a separate already-composer-exempt fallback hotkey.
      await expect(async () => {
        const activeAfter =
          (await page.locator('.thread-card-header--active').first().textContent()) ?? '';
        expect(activeAfter).not.toBe(activeBefore);
      }).toPass({ timeout: 5_000 });
    });
  });
});
