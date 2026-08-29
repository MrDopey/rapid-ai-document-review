import { test, expect, type Page } from '@playwright/test';

// Mirrors app/backend/src/pi/fake-agent-session.ts's READ_DOCUMENT_DIRECTIVE — a user
// message beginning with this prefix causes FakeAgentSession to actually invoke the real
// read_document tool (document-tools.ts) and echo its full text result (which embeds the
// conversation's context revision and the document content served at it) back as the assistant's
// answer. This is what lets this spec assert exactly what revision/content the agent "saw"
// without any live model involved (US4 has no propose_document_edit steps to exercise instead).
const READ_DOCUMENT_DIRECTIVE = '__READ_DOCUMENT__';

// Unique marker lines, following us3.spec.ts's convention: old_string/assertion targets are the
// full marker line text, unique regardless of whatever other content the document already has
// when this spec runs (it may follow us1/us2/us3 in the same `npm run test:e2e` process).
const MARKERS = {
  original: 'US4-MARKER-ORIGINAL: this line exists before the document advances.',
  advanced: 'US4-MARKER-ADVANCED: this line only exists after the document advances.',
};

const MARKER_BLOCK = ['', '', '## US4 Body', '', MARKERS.original, ''].join('\n');

const BRANCH_SHORTCUT = 'Alt+Shift+C';

async function getDocumentState(page: Page): Promise<{ currentRevision: number; content: string }> {
  const response = await page.request.get('/api/document');
  const body = (await response.json()) as { document: { currentRevision: number }; content: string };
  return { currentRevision: body.document.currentRevision, content: body.content };
}

/** Ensures a document exists containing MARKER_BLOCK, regardless of whether this spec runs in
 * isolation (paste screen appears) or after us1/us2/us3 in the same `npm run test:e2e` process
 * (document already exists) — mirrors us3.spec.ts's `ensureFixtureDocument`. */
async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US4 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.toolbar h1')).toBeVisible();
    return;
  }

  const before = await getDocumentState(page);
  if (before.content.includes(MARKERS.original)) return; // a previous US4 run already appended it

  const from = before.content.length;
  await page.request.patch('/api/document', {
    data: { baseRevision: before.currentRevision, changes: [{ from, to: from, insert: MARKER_BLOCK }] },
  });

  // Wait for the manual-edit debounce (FR-004) to actually create a revision whose heads include
  // this marker block, before branching off "the current revision" below — otherwise the branch
  // could capture an older revision number whose snapshot predates this edit entirely (FR-017),
  // which would make the "old vs. refreshed context" assertions later in this spec meaningless.
  await expect
    .poll(async () => (await getDocumentState(page)).currentRevision, { timeout: 10_000, intervals: [300] })
    .toBeGreaterThan(before.currentRevision);

  await page.reload();
  await expect(page.locator('.toolbar h1')).toBeVisible();
}

async function waitIdle(page: Page): Promise<void> {
  await expect(
    page.locator('.conversation-view .conversation-header .badge').first(),
  ).toHaveAttribute('data-status', /idle|closed/, { timeout: 20_000 });
}

test.describe('US4 — keep a conversation in sync with a changing document', () => {
  test('branch goes stale as the document advances; send uses old context, refresh + send uses new (FR-016, FR-017, FR-018)', async ({
    page,
  }) => {
    let branchName = '';
    let branchRevision = 0;

    await test.step('fixture document exists with known marker content', async () => {
      await ensureFixtureDocument(page);
    });

    await test.step('branch a conversation from a keyboard-selected passage (FR-011, FR-043a)', async () => {
      // Run standalone (--grep "US4"), the fixture document is short and every line is already in
      // the DOM. Run after us1/us2/us3 in the same process, the document is long enough that
      // CodeMirror virtualizes lines outside the viewport, so the marker line may not exist in the
      // DOM at all until scrolled near. Reaching it entirely via the keyboard — focus, jump to
      // document end, step up until it appears — works in both cases and is itself a demonstration
      // of FR-043a's keyboard-operable selection, since CodeMirror's cursor-movement commands
      // scroll the new position into view.
      const markerLine = page.locator('.cm-line', { hasText: 'US4-MARKER-ORIGINAL' });
      await page.locator('.cm-line').first().click();
      await page.keyboard.press('Control+End');
      for (let attempt = 0; attempt < 10 && !(await markerLine.isVisible().catch(() => false)); attempt += 1) {
        await page.keyboard.press('ArrowUp');
      }
      await expect(markerLine).toBeVisible({ timeout: 10_000 });
      // Now that the line exists in the DOM, click it directly to place the caret precisely on
      // it — the keyboard navigation above exists only to force CodeMirror to render this far,
      // not to land the caret exactly (a document with more or fewer trailing blank lines than
      // expected would otherwise throw off a purely-relative Home/ArrowUp count).
      await markerLine.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press(BRANCH_SHORTCUT);

      await expect(page.locator('.conversation-header h2')).toHaveText('US4 Body', { timeout: 10_000 });
      branchName = 'US4 Body';

      await waitIdle(page);
    });

    await test.step("record the branch's context revision (v17-equivalent — the value itself is irrelevant, only its relationship to later revisions is)", async () => {
      const { currentRevision } = await getDocumentState(page);
      branchRevision = currentRevision;

      const conversations = await page.request.get('/api/conversations');
      const { conversations: list } = (await conversations.json()) as {
        conversations: { name: string; contextRevision: number; isStale: boolean }[];
      };
      const branch = list.find((c) => c.name === branchName);
      expect(branch?.contextRevision).toBe(branchRevision);
      expect(branch?.isStale).toBe(false);
    });

    await test.step('advance the document past the branch (v17 -> v20-equivalent): Main-side manual edit creates a new revision', async () => {
      const { currentRevision, content } = await getDocumentState(page);
      const from = content.length;
      await page.request.patch('/api/document', {
        data: { baseRevision: currentRevision, changes: [{ from, to: from, insert: `\n\n${MARKERS.advanced}` }] },
      });

      // The manual-edit debounce (E2E_SEED_REVISION_DEBOUNCE_MS, playwright.config.ts) must fire
      // before document.currentRevision actually advances (FR-004).
      await expect
        .poll(async () => (await getDocumentState(page)).currentRevision, { timeout: 10_000, intervals: [300] })
        .toBeGreaterThan(branchRevision);
    });

    await test.step('the branch is marked stale in the HUD, still showing its old context revision (FR-016)', async () => {
      const row = page.locator('.conversation-row', { hasText: branchName });
      await expect(row.locator('.stale-badge')).toBeVisible({ timeout: 10_000 });

      const conversations = await page.request.get('/api/conversations');
      const { conversations: list } = (await conversations.json()) as {
        conversations: { name: string; contextRevision: number; isStale: boolean }[];
      };
      const branch = list.find((c) => c.name === branchName);
      expect(branch?.isStale).toBe(true);
      expect(branch?.contextRevision).toBe(branchRevision); // unchanged by itself (FR-016)
    });

    await test.step('send normally (Enter) -> answered against the older context; read_document returns the old revision (FR-017)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(READ_DOCUMENT_DIRECTIVE);
      await page.keyboard.press('Enter');

      const assistantBubble = page.locator('.message-bubble[data-role="assistant"]').last();
      await expect(assistantBubble.locator('.message-text')).not.toBeEmpty({ timeout: 15_000 });
      await expect(assistantBubble.locator('.message-text')).toContainText(
        `Revision: ${branchRevision} (conversation context)`,
      );
      await expect(assistantBubble.locator('.message-text')).toContainText(MARKERS.original);
      await expect(assistantBubble.locator('.message-text')).not.toContainText(MARKERS.advanced);

      await waitIdle(page);

      // The as-is send did not touch this conversation's context revision — still stale.
      const row = page.locator('.conversation-row', { hasText: branchName });
      await expect(row.locator('.stale-badge')).toBeVisible();
    });

    let advancedRevision = 0;

    await test.step('Refresh + Send (Ctrl+Enter) -> the HUD shows the new revision and the answer reflects the newer document (FR-018, FR-043a)', async () => {
      advancedRevision = (await getDocumentState(page)).currentRevision;
      expect(advancedRevision).toBeGreaterThan(branchRevision);

      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(READ_DOCUMENT_DIRECTIVE);
      // Keyboard-operable equivalent of the "Refresh + Send" button (FR-043a) — exercised here
      // instead of the button itself so this scenario also proves the shortcut works.
      await composer.press('Control+Enter');

      const assistantBubble = page.locator('.message-bubble[data-role="assistant"]').last();
      await expect(assistantBubble.locator('.message-text')).not.toBeEmpty({ timeout: 15_000 });
      await expect(assistantBubble.locator('.message-text')).toContainText(
        `Revision: ${advancedRevision} (conversation context)`,
      );
      await expect(assistantBubble.locator('.message-text')).toContainText(MARKERS.advanced);

      await waitIdle(page);
    });

    await test.step('the HUD no longer shows the branch as stale, and its context revision caught up', async () => {
      const row = page.locator('.conversation-row', { hasText: branchName });
      await expect(row.locator('.stale-badge')).toHaveCount(0);

      const conversations = await page.request.get('/api/conversations');
      const { conversations: list } = (await conversations.json()) as {
        conversations: { name: string; contextRevision: number; isStale: boolean }[];
      };
      const branch = list.find((c) => c.name === branchName);
      expect(branch?.isStale).toBe(false);
      expect(branch?.contextRevision).toBe(advancedRevision);
    });

    await test.step('the "Refresh + Send" button is also reachable and focusable — not only via the Ctrl+Enter shortcut (FR-043a)', async () => {
      const button = page.getByRole('button', { name: 'Refresh + Send' });
      await expect(button).toBeVisible();

      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill('placeholder text so the button becomes enabled');
      await expect(button).toBeEnabled();
      await composer.fill('');
    });
  });
});
