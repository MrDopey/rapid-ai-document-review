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
// The fix restores `.thread-mode-hud` as a real full-width painted bar (background + border,
// structurally the same role as canvas mode's own always-full-width `.toolbar`), while a plain,
// unstyled inner wrapper (`.thread-mode-hud-inner`) centers the actual HudPanel/action row so it
// still visually lines up with the thread tree beneath it. This spec asserts BOTH halves at a real
// rendered viewport width, since only a real browser layout engine can catch a regression in
// either direction (outer bar shrinking again, or the inner alignment silently being dropped).
test.describe('Thread mode — page-level HUD width (regression)', () => {
  test('the HUD bar spans the full viewport width, matching canvas mode, while its content row aligns with the thread tree', async ({
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

    await test.step('the HUD content row still lines up with the (narrow, single-thread) tree below it', async () => {
      const innerBox = await page.locator('.thread-mode-hud-inner').boundingBox();
      const contentBox = await page.locator('.thread-mode-content').boundingBox();
      if (!innerBox || !contentBox) throw new Error('missing inner HUD/content bounding box');
      // The original complaint's fix: the HUD's own content (not the bar behind it) should be a
      // modest, content-sized row — dramatically narrower than the full-width bar it sits inside —
      // not a flat strip spanning the viewport.
      expect(innerBox.width).toBeLessThan(500);
      // Both `.thread-mode-hud-inner` and `.thread-mode-content` use the exact same `width:
      // fit-content; margin: 0 auto` formula within siblings of the same overall width, so even
      // though their own content-driven widths differ, they share the same horizontal CENTER —
      // i.e. the HUD's controls visibly sit directly above the thread card beneath them, which is
      // the actual fix for "doesn't fit with the thread" (equal widths was never the property that
      // mattered; a shared center axis is).
      const innerCenter = innerBox.x + innerBox.width / 2;
      const contentCenter = contentBox.x + contentBox.width / 2;
      expect(Math.abs(innerCenter - contentCenter)).toBeLessThan(5);
    });

    await test.step('after branching (a wider tree), the HUD bar is still full width and still tracks the wider content', async () => {
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
      await expect(page.locator('.thread-mode-hud-inner .conversation-row')).toHaveCount(2);

      const hudBox = await page.locator('.thread-mode-hud').boundingBox();
      const innerBox = await page.locator('.thread-mode-hud-inner').boundingBox();
      const contentBox = await page.locator('.thread-mode-content').boundingBox();
      if (!hudBox || !innerBox || !contentBox) throw new Error('missing bounding box');
      // The outer bar's width must stay decoupled from the tree's width in BOTH directions — this
      // is the actual regression this whole spec exists to catch (a fix that only handled the
      // narrow case, e.g. by hardcoding a width, would not necessarily also survive a wider tree).
      expect(hudBox.width).toBeGreaterThan(1400);
      // The tree grew noticeably wider than the single-thread case above; the HUD's own content row
      // keeps sharing its horizontal center with it regardless.
      const innerCenter = innerBox.x + innerBox.width / 2;
      const contentCenter = contentBox.x + contentBox.width / 2;
      expect(Math.abs(innerCenter - contentCenter)).toBeLessThan(5);
    });
  });
});
