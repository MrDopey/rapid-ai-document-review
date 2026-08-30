import { expect, type Page, type Locator } from '@playwright/test';

/**
 * 005-canvas-conversation-threads (multi-focus overlay): closes every conversation detail panel
 * currently open. A HUD row/Focus-button click is now a toggle against a `focusedConversationIds`
 * set (add if absent, remove if present) rather than a single-scalar "replace" — so several
 * conversations' detail panels can be open at once (up to a cap), and an action that auto-opens a
 * new one (e.g. branching) never closes whatever was already open on its own. This is the shared
 * primitive behind `focusExclusively` below; call it on its own right before an action that will
 * auto-open a panel (branching) when the test needs that to be the *only* panel open afterward.
 */
export async function closeAllFocusedPanels(page: Page): Promise<void> {
  while ((await page.locator('.close-detail-button').count()) > 0) {
    await page.locator('.close-detail-button').first().click();
  }
}

/**
 * 005-canvas-conversation-threads (multi-focus overlay): a HUD/conversation-row click now toggles
 * that conversation's own focus (add if not already focused, remove if it is) rather than
 * replacing whichever single conversation used to be "selected" — so several conversations' detail
 * panels can be open simultaneously (up to a cap), each its own `.conversation-header h2`. Most of
 * this app's pre-existing e2e coverage assumes exactly one detail panel is open at a time — this
 * closes every currently-open panel first, then opens exactly `row`, keeping that single-panel
 * assumption true regardless of what an earlier step (or an app-side auto-open, e.g. branching)
 * left open.
 */
export async function focusExclusively(page: Page, row: Locator, expectedHeaderText: string): Promise<void> {
  await closeAllFocusedPanels(page);
  await row.click();
  await expect(page.locator('.conversation-header h2')).toHaveText(expectedHeaderText, { timeout: 10_000 });
}
