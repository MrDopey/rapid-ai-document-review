import { test, expect } from '@playwright/test';

// The backend runs with PI_FAKE_SESSIONS=1 (playwright.config.ts) since no live model provider
// credential is available in this environment (quickstart.md: agent scenarios otherwise fail
// with AGENT_UNAVAILABLE). FakeAgentSession (app/backend/src/pi/fake-agent-session.ts) is a
// deterministic stand-in exercised through the real send -> ConcurrencyLimiter -> PiService ->
// EventBridge -> EventHub -> WS -> UI path — only the literal model call is replaced.
const DOC_CONTENT = '# US2 Fixture Document\n\nThis document exists to exercise the Main conversation.';

test.describe('US2 — ask the main conversation about the document', () => {
  test('send message to Main, streamed response, reasoning toggle, SC-001', async ({ page }) => {
    let pasteStartedAt = 0;

    await test.step('a document exists (paste one if this run does not have one yet)', async () => {
      await page.goto('/');
      const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
      if (await pasteHeading.isVisible().catch(() => false)) {
        await page.getByLabel('Document content').fill(DOC_CONTENT);
        pasteStartedAt = Date.now();
        await page.getByRole('button', { name: 'Start reviewing' }).click();
      }
      await expect(page.locator('.toolbar h1')).toBeVisible();
    });

    await test.step('Main is visible in the HUD and selected by default (FR-009)', async () => {
      await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
      await expect(page.locator('.conversation-header h2')).toHaveText('Main', { timeout: 10_000 });
    });

    await test.step('ask Main a question -> a streamed, grounded answer appears (FR-010, SC-001)', async () => {
      const composer = page.getByLabel('Message Main');
      await composer.fill('What is this document about?');

      const sc001Start = pasteStartedAt || Date.now();
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      // The user's own message is recorded and rendered too (ConversationService.send).
      await expect(page.locator('.message-bubble[data-role="user"]').last()).toContainText(
        'What is this document about?',
      );

      const assistantBubble = page.locator('.message-bubble[data-role="assistant"]').last();
      await expect(assistantBubble).toBeVisible({ timeout: 15_000 });
      await expect(assistantBubble.locator('.message-text')).not.toBeEmpty({ timeout: 15_000 });
      await expect(assistantBubble.locator('.message-text')).toContainText('fake deterministic answer', {
        timeout: 15_000,
      });

      expect(Date.now() - sc001Start).toBeLessThan(15_000);

      // thinkingVisible defaults to false: no reasoning block should have been rendered.
      await expect(assistantBubble.locator('details.reasoning')).toHaveCount(0);

      // Wait for the turn to fully settle before the next step sends another message — Pi
      // sessions (real or fake) reject an overlapping prompt() without steer/followUp, same as
      // a real user waiting for a reply before asking a follow-up.
      await expect(assistantBubble).toHaveAttribute('aria-busy', 'false');
    });

    await test.step('enable "Show reasoning" -> next answer streams a visible reasoning block (FR-010, FR-041)', async () => {
      await page.getByLabel('Show reasoning').check();

      const composer = page.getByLabel('Message Main');
      await composer.fill('Follow-up question with reasoning visible.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const assistantBubble = page.locator('.message-bubble[data-role="assistant"]').last();
      const reasoning = assistantBubble.locator('details.reasoning');
      await expect(reasoning).toBeVisible({ timeout: 15_000 });
      await expect(reasoning).toHaveAttribute('open', '');
      await expect(reasoning.locator('.reasoning-content')).not.toBeEmpty();
      await expect(assistantBubble).toHaveAttribute('aria-busy', 'false');
    });

    await test.step('disable "Show reasoning" -> next answer has no reasoning block', async () => {
      await page.getByLabel('Show reasoning').uncheck();

      const composer = page.getByLabel('Message Main');
      await composer.fill('Another question with reasoning hidden.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const assistantBubble = page.locator('.message-bubble[data-role="assistant"]').last();
      await expect(assistantBubble.locator('.message-text')).toContainText('fake deterministic answer', {
        timeout: 15_000,
      });
      await expect(assistantBubble.locator('details.reasoning')).toHaveCount(0);
    });
  });
});
