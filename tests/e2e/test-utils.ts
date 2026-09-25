import { expect, type Page, type Locator, type APIRequestContext } from '@playwright/test';

/**
 * daf1db6 ("feat: multi-document support") removed the old singleton `GET/PATCH /api/document`
 * endpoint in favor of `/api/documents/:documentId` — every e2e spec that used to hit the old path
 * needs a document id threaded through first. Mirrors the frontend document store's own
 * convention for resolving "the active document" (`stores/document.ts`'s `load()`): whichever
 * document is `isActive`, falling back to the first one if none is flagged active yet (e.g. right
 * after a fresh backend start, before any document has ever been fetched/switched to).
 */
export async function getActiveDocumentId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/documents');
  const body = (await response.json()) as { documents: { id: string; isActive: boolean }[] };
  const active = body.documents.find((d) => d.isActive) ?? body.documents[0];
  if (!active) throw new Error('No document exists yet');
  return active.id;
}

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
export async function focusExclusively(
  page: Page,
  row: Locator,
  expectedHeaderText: string,
): Promise<void> {
  await closeAllFocusedPanels(page);
  await row.click();
  await expect(page.locator('.conversation-header h2')).toHaveText(expectedHeaderText, {
    timeout: 10_000,
  });
}

/**
 * Playwright backfill (013): creates a fresh Thread-mode document via the document switcher,
 * mirroring `thread-mode-hud.spec.ts`'s own inline setup steps. Navigates to `/` first, so this
 * assumes no unsaved state the caller needs to preserve.
 */
export async function createThreadDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill('# Thread fixture\n\nHello world.');
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.preview-pane')).toBeVisible();
  }
  await page.locator('.document-switcher-toggle').click();
  await page.locator('.document-switcher-create', { hasText: 'New threaded conversation' }).click();
  await expect(page.locator('.thread-mode-hud')).toBeVisible();
}

/**
 * Playwright backfill (013): fills and sends a message via whichever `ThreadComposer.vue` textarea
 * is currently open at a thread/branch's tip (`textarea[id^="thread-composer-"]` — the same
 * selector `thread-mode-hud.spec.ts` uses), then waits for it to render as a sent message.
 */
export async function sendThreadMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea[id^="thread-composer-"]').first();
  const sendButton = page.locator('.thread-send-button').first();
  // A just-created Thread document's composer can still be finishing its own initial mount for a
  // moment after `.thread-mode-hud` itself becomes visible (the HUD and the root thread's own
  // `ThreadCard`/composer load on separate async paths) — retry the fill if the send button
  // hasn't picked up the typed text yet (`:disabled="!draft.trim() || ..."`, ThreadComposer.vue),
  // rather than assuming one `fill()` always lands in the final, stable textarea instance.
  await expect(async () => {
    await textarea.fill(text);
    await expect(sendButton).toBeEnabled({ timeout: 1_000 });
    await sendButton.click({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('.thread-segment-message', { hasText: text })).toBeVisible();
  // FakeAgentSession's reply is near-instant but not synchronous — give it a moment to land
  // before a caller selects text for branching (see `branchFromFirstMessage`'s own doc comment on
  // why the tip message matters), matching `thread-mode-hud.spec.ts`'s own convention.
  await page.waitForTimeout(500);
}

/**
 * Playwright backfill (013): selects the full text of the FIRST rendered thread message and
 * clicks "Branch from here" (`HighlightBranchMenu.vue`), mirroring `thread-mode-hud.spec.ts`'s own
 * selection+branch steps. Deliberately `.first()`, not `.last()`: `ThreadCard.vue`'s
 * `canBranchFromSelection` refuses to offer "Branch from here" (only "Quote" instead) for a
 * selection on the thread's own TIP message — by the time this runs, `FakeAgentSession`'s
 * near-instant reply has usually already landed, making the assistant reply (not the message this
 * helper means to branch from) the new tip. Waits for the branch to actually mount (a second
 * `.conversation-row` in the HUD) before returning, since the click itself resolves before the new
 * thread finishes loading.
 */
export async function branchFromFirstMessage(page: Page): Promise<void> {
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
}

/**
 * Playwright backfill (013): generalizes the ad hoc `document.elementFromPoint` stacking check
 * already used inline in `history-diff.spec.ts` — asserts that the real topmost painted element at
 * `point` (default: the center of `target`'s own bounding box) is `target` itself or nested inside
 * it. `toBeVisible()`/`toBeInViewport()` alone don't catch a z-index/stacking regression: both pass
 * even when a *different*, unrelated element is actually painted on top at that pixel.
 */
export async function assertElementOnTop(
  page: Page,
  target: Locator,
  point?: { x: number; y: number },
): Promise<void> {
  const box = point ?? (await target.boundingBox());
  if (!box) throw new Error('assertElementOnTop: target has no bounding box');
  const { x, y } = 'width' in box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : box;
  const topElementHandle = await page.evaluateHandle(
    ({ x, y }) => document.elementFromPoint(x, y),
    { x, y },
  );
  const targetHandle = await target.elementHandle();
  const isOnTop = await page.evaluate(
    ([topEl, targetEl]) => !!topEl && !!targetEl && targetEl.contains(topEl),
    [topElementHandle, targetHandle],
  );
  expect(
    isOnTop,
    `expected ${await target.evaluate((el) => el.className)} to be on top at (${x}, ${y})`,
  ).toBe(true);
}

/**
 * Playwright backfill (013): clicks whichever `App.vue` toolbar icon button opens a given
 * page-level dialog (Keyboard shortcuts / Help / System prompt — all share the same
 * `.modal-overlay.blocking-overlay` wrapper, `--z-overlay-blocking` tier, style.css), then waits
 * for that overlay to actually mount.
 */
export async function openAppDialog(
  page: Page,
  ariaLabel: 'Keyboard shortcuts' | 'Help' | 'System prompt',
): Promise<Locator> {
  await page.getByRole('button', { name: ariaLabel }).click();
  const overlay = page.locator('.modal-overlay.blocking-overlay');
  await expect(overlay).toBeVisible();
  return overlay;
}
