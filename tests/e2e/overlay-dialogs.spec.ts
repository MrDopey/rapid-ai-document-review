import { test, expect } from '@playwright/test';
import {
  focusExclusively,
  closeAllFocusedPanels,
  assertElementOnTop,
  openAppDialog,
} from './test-utils.js';

// Canvas mode. Regression coverage for historical `App.vue` overlay bugs no jsdom-based component
// test could catch (real stacking/closability/sizing, not just DOM presence).
async function openCanvasDocWithFocusedMain(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill('# Overlay-dialogs fixture\n\nHello world.');
    await page.getByRole('button', { name: 'Start reviewing' }).click();
  } else {
    // A document already exists from an earlier spec in this shared-DB run, but it may be a
    // Thread-mode one (no `.preview-pane` at all) — always create a fresh CANVAS document
    // explicitly via the switcher rather than assuming whatever's currently active is one.
    await page.locator('.document-switcher-toggle').click();
    await page.locator('.document-switcher-create', { hasText: '+ New document' }).click();
  }
  await expect(page.locator('.preview-pane')).toBeVisible();
  await focusExclusively(page, page.locator('.conversation-row', { hasText: 'Main' }), 'Main');
}

test.describe('Canvas mode — overlay dialog stacking/closability/sizing (regression)', () => {
  test('Shortcuts and System prompt dialogs stack above the focused-conversation overlay (989c87b/8d3e7a2)', async ({
    page,
  }) => {
    await openCanvasDocWithFocusedMain(page);
    await expect(page.locator('.conversation-detail-overlay')).toBeVisible();

    // Dark-mode regression guard: `--z-overlay-blocking`/`--z-overlay-detail` are plain custom
    // properties (style.css), not values that vary by `prefers-color-scheme` — but the bug this
    // test guards against (stacking) is exactly the kind of thing that could regress in only one
    // scheme if a future dark-mode-specific override ever touched z-index or `isolation`/opacity
    // on either layer. Run the same on-top check in both, live, without reloading (`page.
    // emulateMedia` flips which half of style.css's dark-mode block applies), matching
    // `a11y.spec.ts`'s own dual-scheme convention.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });

      for (const ariaLabel of ['Keyboard shortcuts', 'System prompt'] as const) {
        await test.step(`[${scheme}] ${ariaLabel} dialog paints on top, not underneath the focused panel`, async () => {
          const overlay = await openAppDialog(page, ariaLabel);
          // Regression guard: before `--z-overlay-blocking` (style.css), these dialogs shared
          // `--z-overlay` (50) — BELOW `--z-overlay-detail` (55, `.conversation-detail-overlay`) —
          // so the focused panel painted on top, making the dialog's own Close button unclickable.
          await assertElementOnTop(page, overlay.getByRole('button', { name: 'Close' }));
          await overlay.getByRole('button', { name: 'Close' }).click();
          await expect(overlay).toHaveCount(0);
        });
      }
    }
  });

  test('Shortcuts dialog only lists bindings reachable from canvas mode (9ec6967)', async ({
    page,
  }) => {
    await openCanvasDocWithFocusedMain(page);
    const overlay = await openAppDialog(page, 'Keyboard shortcuts');
    // Regression guard: before mode-filtering, canvas mode's dialog also listed Thread mode's own
    // 'Thread list' scope, which has no reachable binding at all from this view tree (App.vue only
    // ever mounts one of the two HudPanel instances at a time).
    await expect(overlay.getByRole('heading', { name: 'Thread list' })).toHaveCount(0);
    await expect(overlay.getByRole('heading', { name: 'Conversation list' })).toBeVisible();
  });

  test("a dialog's title bar stays visible while its content scrolls (fb25f74)", async ({
    page,
  }) => {
    await openCanvasDocWithFocusedMain(page);
    const overlay = await openAppDialog(page, 'Keyboard shortcuts');
    const header = overlay.locator('.dialog-header');
    await expect(header).toBeVisible();
    const beforeScroll = await header.boundingBox();

    await overlay
      .locator('.keyboard-shortcuts-dialog, [class*="dialog"]')
      .first()
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });

    // Regression guard: before `.dialog-header` was made `position: sticky`, scrolling long
    // dialog content scrolled the title/Close button off-screen with no way back to them short of
    // scrolling back up manually.
    const afterScroll = await header.boundingBox();
    if (!beforeScroll || !afterScroll) throw new Error('missing bounding box');
    await expect(header).toBeInViewport();
    expect(Math.abs(afterScroll.y - beforeScroll.y)).toBeLessThan(3);
  });

  test('closing the last focused conversation panel actually dismisses the overlay (cae0bba)', async ({
    page,
  }) => {
    await openCanvasDocWithFocusedMain(page);
    await expect(page.locator('.conversation-detail-overlay')).toBeVisible();

    await closeAllFocusedPanels(page);

    // Regression guard: before the fix, closing the only focused panel auto-refocused the "next"
    // conversation in the app-wide list whenever more than one conversation existed, so the
    // overlay (gated on the focused set being non-empty) could never actually be dismissed this
    // way.
    await expect(page.locator('.conversation-detail-overlay')).toHaveCount(0);
  });

  test('the focused-conversation overlay never bleeds into the Preview pane once History narrows Canvas (5aacdab)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openCanvasDocWithFocusedMain(page);
    await expect(page.locator('.conversation-detail-overlay')).toBeVisible();

    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.locator('.history-drawer')).toBeVisible();

    const previewBox = await page.locator('.preview-pane').boundingBox();
    const overlayBox = await page.locator('.conversation-detail-overlay').boundingBox();
    if (!previewBox || !overlayBox) throw new Error('missing bounding box');

    // Regression guard: the overlay used to have `flex-shrink: 0` inside a grid column pinned to
    // Canvas only, so it refused to shrink below 480px and visually overlapped Preview's own
    // column once History's reserved width narrowed Canvas below that. Assert no horizontal
    // overlap between the two panes' real rendered boxes.
    expect(overlayBox.x).toBeGreaterThanOrEqual(previewBox.x + previewBox.width - 1);
  });
});
