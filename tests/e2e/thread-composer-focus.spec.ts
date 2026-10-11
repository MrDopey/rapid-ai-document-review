import { test, expect } from '@playwright/test';
import { createThreadDocument } from './test-utils.js';

// Bug report: "in the threaded conversation view, when I type a message, hit enter, the agent
// returns a message to the conversation, but then I lost my focus on the conversation."
// `ThreadComposer.vue`'s textarea carried `:disabled="disabled || sending"`, and the send request
// stays in flight for the agent's ENTIRE turn (backend `conversationService.send` awaits the turn's
// own run before POST /send resolves) — so the textarea sat `disabled` for as long as the reviewer
// was watching the reply stream in. Disabling a focused element makes the browser blur it (focus
// drops to `<body>`), and nothing re-focused the textarea once `sending` flipped back to `false`,
// so after every agent reply the reviewer had to click back into the composer before typing their
// follow-up. `tests/component/ThreadComposer.spec.ts` covers the disabled-state logic at the
// component level; only a real browser proves the focus survives a genuine send -> agent-reply
// round trip, same rationale as `thread-hotkeys.spec.ts`'s own doc comment.
test.describe('Thread mode — composer keeps focus across send + agent reply', () => {
  test('focus stays in the composer after Enter, through the agent reply, with no click-back', async ({
    page,
  }) => {
    const composer = page.locator('textarea[id^="thread-composer-"]').first();

    await test.step('a thread document exists and the composer is focused', async () => {
      await createThreadDocument(page);
      await composer.click();
      await expect(composer).toBeFocused();
    });

    await test.step('type a message and send it with Enter', async () => {
      await page.keyboard.type('Please summarize the document.');
      await page.keyboard.press('Enter');
      await expect(
        page.locator('.thread-segment-message', { hasText: 'Please summarize the document.' }),
      ).toBeVisible();
    });

    await test.step('the agent reply arrives and the in-flight state clears', async () => {
      // The FakeAgentSession reply is the second message in the thread's own tip segment.
      await expect(page.locator('.thread-segment-message')).toHaveCount(2, { timeout: 30_000 });
      // `sending` has flipped back to `false` — the button's label returned to 'Send'.
      await expect(page.locator('.thread-send-button')).toHaveText('Send');
    });

    await test.step('focus is STILL in the composer — no click-back needed', async () => {
      // The regression assertion: before the fix the browser had blurred the disabled textarea
      // on the way in, and `<body>` is where `document.activeElement` sits here now.
      await expect(composer).toBeFocused();
    });

    await test.step('a follow-up can be typed immediately', async () => {
      // Pure keystrokes — if focus had been lost, this text would land nowhere and the send
      // button would never enable.
      await page.keyboard.type('Thanks, one more detail please.');
      await expect(page.locator('.thread-send-button')).toBeEnabled();
    });
  });
});
