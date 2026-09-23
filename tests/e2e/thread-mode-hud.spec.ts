import { test, expect } from '@playwright/test';

// Spec: 011-linear-thread-mode. Regression coverage for a real rendered-CSS-layout bug that no
// jsdom-based component test in this codebase can ever catch (jsdom performs no actual box-layout
// math — see `ThreadModeView.spec.ts`'s own doc comment on this). History, in order:
//  1. User report: "the thread's header and expand/collapse all doesn't fit with the thread" —
//     `.thread-mode-hud` used to paint itself as a flat, full-viewport-bleed strip with no visible
//     relationship to the narrower, centered, bordered `.thread-card` tree beneath it.
//  2. A fix for #1 made the HUD's own PAINTED box shrink to the thread tree's content-driven width
//     instead — for the common single-Thread case that read as "the HUD shrunk"/stopped covering
//     the viewport (a second, later user report), since canvas mode's own HUD area (`.hud-box` +
//     `.actions-group` inside `.toolbar`) always spans (nearly) the full toolbar row regardless of
//     how many conversations are open — it is never coupled to any content's own width.
// Root-cause fix for both, together: `.thread-mode-hud` stays a real, full-width painted bar
// (background + border, structurally the same role as canvas mode's own always-full-width
// `.toolbar`), and — instead of a separate centered/content-sized inner wrapper that had to be kept
// in sync with the tree's own width — its inner content now uses the SAME shared
// `.hud-bar-columns`/`.hud-bar-left`/`.hud-bar-right` split canvas mode's own toolbar uses
// (style.css), with the thread tree below (`.thread-mode-content`/`.thread-mode-list`) left-aligned/
// full-width like canvas's own `.panes` rather than centered. This spec asserts the HUD bar's width
// at a real rendered viewport width, since only a real browser layout engine can catch a regression
// in either direction (the outer bar shrinking again, or the left/right split silently collapsing).
test.describe('Thread mode — page-level HUD width (regression)', () => {
  test('the HUD bar spans the full viewport width, matching canvas mode, with the HUD list on the left and actions on the right', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    let canvasToolbarWidth = 0;
    await test.step('canvas mode: record the ground-truth full-width HUD toolbar', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Paste your document' })).toBeVisible();
      await page.getByLabel('Document content').fill('# Canvas doc\n\nHello world.');
      await page.getByRole('button', { name: 'Start reviewing' }).click();
      await expect(page.locator('.hud-box')).toBeVisible();

      const toolbarBox = await page.locator('.toolbar').boundingBox();
      if (!toolbarBox) throw new Error('canvas .toolbar has no bounding box');
      canvasToolbarWidth = toolbarBox.width;
      // Canvas mode's own toolbar row is always the full viewport width (minus the browser's own
      // scrollbar, if any) — this is this test's ground truth for "what a full-width HUD bar looks
      // like", confirmed independently against `App.vue`'s CSS during investigation.
      expect(canvasToolbarWidth).toBeGreaterThan(1400);
    });

    await test.step('create a Thread-mode document', async () => {
      await page.locator('.document-switcher-toggle').click();
      await page
        .locator('.document-switcher-create', { hasText: 'New threaded conversation' })
        .click();
      await expect(page.locator('.thread-mode-hud')).toBeVisible();
    });

    await test.step('the HUD bar itself spans the full viewport width, same as canvas mode', async () => {
      const hudBox = await page.locator('.thread-mode-hud').boundingBox();
      if (!hudBox) throw new Error('.thread-mode-hud has no bounding box');
      // Regression guard: before the fix, this bar had no background/no independent width of its
      // own reason to stay wide — the visible box (then `.thread-mode-hud-card`) shrank to the
      // (single, unbranched) thread's own ~640px content width instead of the viewport.
      expect(hudBox.width).toBeGreaterThan(1400);
      // Parity with canvas mode's own full-width toolbar bar (not merely "some" large number).
      expect(Math.abs(hudBox.width - canvasToolbarWidth)).toBeLessThan(5);
    });

    await test.step('the HUD list sits on the left, the Expand-all/Export-all/Done actions on the right — same split as canvas mode', async () => {
      const left = page.locator('.thread-mode-hud .hud-bar-left');
      const right = page.locator('.thread-mode-hud .hud-bar-right');
      const leftBox = await left.boundingBox();
      const rightBox = await right.boundingBox();
      if (!leftBox || !rightBox) throw new Error('missing hud-bar-left/hud-bar-right bounding box');
      // Left column sits to the left of the right column (mirrors canvas mode's own
      // `.hud-bar-left`/`.hud-bar-right` split).
      expect(leftBox.x).toBeLessThan(rightBox.x);
      await expect(left.locator('nav.hud-panel')).toBeVisible();
      await expect(right.getByRole('button', { name: /Expand all|Collapse all/ })).toBeVisible();
      await expect(right.getByRole('button', { name: 'Export all' })).toBeVisible();
      await expect(right.getByRole('button', { name: /Done \(\d+\)/ })).toBeVisible();
    });

    await test.step("the thread tree below is left-aligned/full-width, sharing the HUD bar's own left edge", async () => {
      const hudBox = await page.locator('.thread-mode-hud').boundingBox();
      const contentBox = await page.locator('.thread-mode-content').boundingBox();
      if (!hudBox || !contentBox) throw new Error('missing HUD/content bounding box');
      // Regression guard for the ORIGINAL complaint's replacement fix: the tree is no longer a
      // narrow, centered column independent of the HUD bar above it — it now shares the same left
      // edge as the HUD bar (both left-aligned within the same page padding), rather than a
      // separate `width: fit-content; margin: 0 auto` column that could drift out of alignment.
      expect(Math.abs(hudBox.x - contentBox.x)).toBeLessThan(5);
    });

    await test.step('after branching (a wider tree), the HUD bar is still full width', async () => {
      const textarea = page.locator('textarea[id^="thread-composer-"]').first();
      await textarea.fill('First message in the root thread.');
      await page.locator('.thread-send-button').first().click();
      await expect(page.locator('.thread-segment-message').first()).toBeVisible();
      // Fake sessions reply near-instantly, but give the reply a moment to land before selecting.
      await page.waitForTimeout(500);

      const firstMessage = page.locator('.thread-segment-message').first();
      await firstMessage.evaluate((el) => {
        const textEl = el.querySelector('.message-text') ?? el;
        const range = document.createRange();
        range.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
      await firstMessage.dispatchEvent('mouseup');
      await page.locator('.highlight-branch-button', { hasText: 'Branch from here' }).click();
      await expect(page.locator('.thread-mode-hud .conversation-row')).toHaveCount(2);

      const hudBox = await page.locator('.thread-mode-hud').boundingBox();
      if (!hudBox) throw new Error('missing bounding box');
      // The outer bar's width must stay decoupled from the tree's width in BOTH directions — this
      // is the actual regression this whole spec exists to catch (a fix that only handled the
      // narrow case, e.g. by hardcoding a width, would not necessarily also survive a wider tree).
      expect(hudBox.width).toBeGreaterThan(1400);
    });
  });
});
