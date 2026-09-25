import { test, expect, type Page } from '@playwright/test';

// Mirrors app/backend/src/pi/fake-agent-session.ts's MULTI_TOOL_DIRECTIVE — a user message
// beginning with this prefix, followed by JSON `{ calls: { tool, params }[] }`, causes
// FakeAgentSession to invoke each named real tool object in turn, all attributed to the SAME
// tool-call-carrier message. This is the only fake-session directive that can produce a message
// with 2+ tool calls (every other directive calls its carrier's tool exactly once) — needed to
// drive ToolCallMessage.vue's message-scoped "Expand all"/"Collapse all" toggle
// (`clamp.canBulkToggle()`, only shown with 2+ tool calls where at least one overflows) through a
// real UI-driven agent turn in a real browser, not a jsdom mock.
const MULTI_TOOL_DIRECTIVE = '__MULTI_TOOL_CALL__';

// A body long enough that `read_document`'s full-text echo (which embeds every line, line
// numbered — see read-document.ts's renderReadResult) genuinely exceeds ToolCallMessage.vue's
// 160px clamp in a real rendered browser. `list_items`, called with no items ever added, always
// renders a short two-line "No items." result — well under the clamp — giving exactly the "2 tool
// calls, only one overflows" precondition the bulk toggle needs.
const FILLER_LINE_COUNT = 60;
const MARKER_BLOCK = [
  '',
  '',
  '## Tool Call Bulk Toggle Fixture',
  '',
  ...Array.from(
    { length: FILLER_LINE_COUNT },
    (_, i) => `Filler line ${i + 1} of the fixture body.`,
  ),
  '',
].join('\n');

async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page
      .getByLabel('Document content')
      .fill(`# Tool Call Bulk Toggle Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.preview-pane')).toBeVisible();
    return;
  }
  await expect(page.locator('.preview-pane')).toBeVisible();
}

test.describe('Tool-call message bulk expand/collapse', () => {
  test('a tool-call-carrier message with 2+ tool calls (only one overflowing) gets its own "Expand all"/"Collapse all" toggle', async ({
    page,
  }) => {
    await test.step('fixture document exists', async () => {
      await ensureFixtureDocument(page);
    });

    const dialog = page.locator('.conversation-detail-dialog');
    let conversationId = '';

    await test.step('send a message that produces 2 tool calls in one carrier message (one long, one short)', async () => {
      const mainRow = page.locator('.hud-panel .conversation-row').first();
      conversationId = (await mainRow.getAttribute('data-conversation-id')) ?? '';
      expect(conversationId).not.toBe('');
      await mainRow.click();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await dialog.locator('textarea').fill(
        `${MULTI_TOOL_DIRECTIVE}${JSON.stringify({
          calls: [
            { tool: 'read_document', params: {} },
            { tool: 'list_items', params: {} },
          ],
        })}`,
      );
      await dialog.getByRole('button', { name: /^Send$/ }).click();
      // ToolCallMessage.vue's own doc comment: live tool-call detail only populates after
      // `loadDetail`/a remount, not through the WS stream (`tool_started`/`tool_completed` aren't
      // surfaced into the store's message shape yet) — so the carrier renders with an empty
      // `toolCalls[]` right after sending and MessageBubble.vue's root `v-if` hides it entirely.
      // Wait for the turn to settle (the follow-up plain-text reply, which streams live and always
      // renders), then close and reopen this conversation's detail view — remounting
      // `ConversationView.vue` re-runs `loadDetail`, which fetches the full message list including
      // `toolCalls` from the backend.
      await expect(dialog.locator('.message-bubble', { hasText: 'No items.' })).toBeVisible({
        timeout: 10_000,
      });
      await dialog.getByRole('button', { name: 'Close full view' }).click();
      await page.locator('.hud-panel .conversation-row').first().click();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog.locator('[data-message-kind="tool-call"]')).toBeVisible({
        timeout: 10_000,
      });
    });

    const carrier = () => dialog.locator('[data-message-kind="tool-call"]');

    await test.step('exactly 2 tool calls landed in the same carrier message, only one with its own individual toggle', async () => {
      await expect(carrier().locator('.tool-call')).toHaveCount(2);
      await expect(carrier().locator('.tool-call .expand-toggle-button')).toHaveCount(1);
    });

    const bulkToggle = () => carrier().getByRole('button', { name: /tool calls in this message/ });

    await test.step('the message-scoped bulk toggle appears, defaulting to "Expand all"', async () => {
      await expect(bulkToggle()).toBeVisible();
      await expect(bulkToggle()).toHaveText('Expand all');
    });

    await test.step('clicking it expands the overflowing tool call and flips its own label to "Collapse all"', async () => {
      await bulkToggle().click();
      await expect(bulkToggle()).toHaveText('Collapse all');
      await expect(carrier().locator('.tool-call .expand-toggle-button')).toHaveText('Show less');
    });

    await test.step('clicking it again collapses everything back', async () => {
      await bulkToggle().click();
      await expect(bulkToggle()).toHaveText('Expand all');
      await expect(carrier().locator('.tool-call .expand-toggle-button')).toHaveText('Show more');
    });

    await test.step('the pre-existing conversation-level bulk toggle still cascades into this same tool-call message', async () => {
      await dialog.getByRole('button', { name: 'Close full view' }).click();
      const box = page.locator(
        `.conversation-thread-box[data-conversation-id="${conversationId}"]`,
      );
      const conversationBulk = box.getByRole('button', { name: /Expand all messages/ });
      await expect(conversationBulk).toBeVisible();
      await conversationBulk.click();
      await expect(box.locator('.tool-call .expand-toggle-button')).toHaveText('Show less');
    });
  });
});
