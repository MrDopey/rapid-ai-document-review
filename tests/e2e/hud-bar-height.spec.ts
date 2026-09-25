import { test, expect, type Page } from '@playwright/test';
import { createThreadDocument } from './test-utils.js';

// Regression coverage for the `.actions-group` column-split fix (Canvas: 2 → 3 columns; Thread:
// 1 → 2 columns) that stopped a single tall button stack from overflowing the HUD bar's vertical
// space. jsdom performs no real box-layout math (see `thread-mode-hud.spec.ts`'s own doc comment on
// this), so only a real rendered viewport can catch the HUD bar growing taller again.
//
// Why the whole bar, not `.hud-bar-left`/`.hud-bar-right` individually: `.hud-bar-columns` uses
// `align-items: stretch` (style.css), and flex items default to `min-height: auto` — a stretched
// item can be grown up to match a taller sibling but never shrunk below its own content's height.
// So whichever side's content is taller sets the row's height, and BOTH columns are stretched to
// match it: measuring `.hud-bar-right`'s own rendered height against `.hud-bar-left`'s would always
// read as equal, even in the pre-fix single-button-column layout (verified: both measured 155px
// pre-fix, both measured 127px/97px post-fix) — it can never catch a regression by construction.
// The bar's OWN total height is what actually matters: the HUD bar is pinned above the
// document/thread tree on every screen size, so its vertical space is a premium, and a taller
// `.actions-group` doesn't just grow `.hud-bar-right` — it forces `.hud-bar-left` to stretch to
// match, padding it with dead space it isn't using.
const HEIGHT_BUFFER_PX = 5;

async function assertHudBarHeightWithinBuffer(page: Page, scope: string, baselinePx: number) {
  const bar = page.locator(scope);
  const barBox = await bar.boundingBox();
  if (!barBox) throw new Error(`missing ${scope} bounding box`);

  expect(
    barBox.height,
    `${scope} is ${barBox.height}px tall, more than its recorded baseline of ${baselinePx}px ` +
      `(+${HEIGHT_BUFFER_PX}px buffer) — HUD vertical space is a premium (it stays pinned above the ` +
      'document/thread tree), and growing it further also forces .hud-bar-left to stretch to match, ' +
      "padding it with dead space it isn't using. Rebalance the .actions-group column split " +
      '(App.vue/ThreadModeView.vue) instead of letting the bar grow; if the growth is intentional, ' +
      "update this test's recorded baseline.",
  ).toBeLessThanOrEqual(baselinePx + HEIGHT_BUFFER_PX);
}

test.describe('HUD bar height (regression)', () => {
  test('canvas mode: .toolbar stays within its recorded baseline height', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Paste your document' })).toBeVisible();
    await page.getByLabel('Document content').fill('# Canvas doc\n\nHello world.');
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.hud-box')).toBeVisible();

    // Recorded post-fix (3-column Global Actions split) at 1440x900, Desktop Chrome.
    await assertHudBarHeightWithinBuffer(page, '.toolbar', 184);
  });

  test('thread mode: .thread-mode-hud stays within its recorded baseline height', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await createThreadDocument(page);

    // Recorded post-fix (2-column actions split) at 1440x900, Desktop Chrome.
    await assertHudBarHeightWithinBuffer(page, '.thread-mode-hud', 118.1875);
  });
});
