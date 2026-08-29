import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// Mirrors app/backend/src/pi/fake-agent-session.ts's directive protocol — see us3.spec.ts/
// us5.spec.ts for the same convention. US7's fold-summary flow needs no directive of its own:
// PiService.generateFoldSynopsis just sends FakeAgentSession a plain prompt and gets back its
// standard deterministic echo ("Here is a fake deterministic answer to: ..."), which is what makes
// the synopsis content assertable below without any live model.
const BRANCH_SHORTCUT = 'Alt+Shift+C';

const MARKERS = {
  foldTarget: 'US7-MARKER-FOLD: This sentence anchors the fold-summary branch target.',
  parentTarget: 'US7-MARKER-PARENT: This sentence anchors the still-open-child branch target.',
};

const MARKER_BLOCK = [
  '',
  '',
  '## US7 Fold Target',
  '',
  MARKERS.foldTarget,
  '',
  '## US7 Parent Target',
  '',
  MARKERS.parentTarget,
  '',
].join('\n');

async function getDocumentState(page: Page): Promise<{ currentRevision: number; content: string }> {
  const response = await page.request.get('/api/document');
  const body = (await response.json()) as { document: { currentRevision: number }; content: string };
  return { currentRevision: body.document.currentRevision, content: body.content };
}

type ConversationSummary = {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  status: string;
  isPrimary: boolean;
};

async function getConversations(request: APIRequestContext): Promise<ConversationSummary[]> {
  const response = await request.get('/api/conversations');
  const body = (await response.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

async function findConversation(request: APIRequestContext, name: string): Promise<ConversationSummary> {
  const conversation = (await getConversations(request)).find((c) => c.name === name);
  if (!conversation) throw new Error(`Conversation not found: ${name}`);
  return conversation;
}

async function getConversationDetail(
  request: APIRequestContext,
  id: string,
): Promise<{ conversation: ConversationSummary & { readOnly?: boolean }; messages: unknown[] }> {
  const response = await request.get(`/api/conversations/${id}`);
  return (await response.json()) as { conversation: ConversationSummary & { readOnly?: boolean }; messages: unknown[] };
}

/** Ensures a document exists containing MARKER_BLOCK, regardless of whether this spec runs in
 * isolation (paste screen appears) or after us1-us6 in the same `npm run test:e2e` process
 * (document already exists) — mirrors us3.spec.ts/us5.spec.ts's `ensureFixtureDocument`. */
async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US7 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.toolbar h1')).toBeVisible();
    return;
  }

  const before = await getDocumentState(page);
  if (before.content.includes(MARKERS.foldTarget)) return; // a previous US7 run already appended it

  const from = before.content.length;
  await page.request.patch('/api/document', {
    data: { baseRevision: before.currentRevision, changes: [{ from, to: from, insert: MARKER_BLOCK }] },
  });

  await expect
    .poll(async () => (await getDocumentState(page)).currentRevision, { timeout: 10_000, intervals: [300] })
    .toBeGreaterThan(before.currentRevision);

  await page.reload();
  await expect(page.locator('.toolbar h1')).toBeVisible();
}

async function waitIdle(page: Page): Promise<void> {
  await expect(page.locator('.conversation-view .conversation-header .badge').first()).toHaveAttribute(
    'data-status',
    /idle|closed/,
    { timeout: 20_000 },
  );
}

/** Selects `name`'s row in the HUD, regardless of which conversation is currently open. */
async function selectConversation(page: Page, name: string): Promise<void> {
  await page.locator('.hud-panel .conversation-row', { hasText: name }).click();
  await expect(page.locator('.conversation-header h2')).toHaveText(name);
}

/** Branches from the line containing `markerText`, selected via the keyboard (FR-043a), and
 *  returns once the new branch (named `expectedName`, per seed-excerpt.ts's `deriveBranchName`)
 *  is open. Mirrors us6.spec.ts's `branchFromMarker`: by the time this spec runs (after us1-us6 in
 *  the shared `npm run test:e2e` process), the document is long enough that CodeMirror's
 *  virtualized rendering has not put these markers — appended at the very end — into the DOM yet.
 *  `Control+End` moves the caret to the document end and scrolls it into view first, a standard
 *  keyboard-only editor command, which renders the tail lines this spec's markers live in. */
async function branchFromMarker(page: Page, markerText: string, expectedName: string): Promise<void> {
  await page.locator('.editor-host').click();
  await page.keyboard.press('Control+End');
  const line = page.locator('.cm-line', { hasText: markerText });
  await line.scrollIntoViewIfNeeded();
  await line.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press(BRANCH_SHORTCUT);

  await expect(page.locator('.conversation-header h2')).toHaveText(expectedName, { timeout: 10_000 });
  await waitIdle(page);
}

test.describe('US7 — Review closed conversations', () => {
  test('close with fold summary, read-only view, and request review (FR-034, FR-034a, FR-035, FR-036)', async ({
    page,
  }) => {
    let branchName = '';

    await test.step('fixture document exists with known marker content', async () => {
      await ensureFixtureDocument(page);
    });

    await test.step('branch a conversation to close with a fold summary (FR-011)', async () => {
      branchName = 'US7 Fold Target';
      await branchFromMarker(page, 'US7-MARKER-FOLD', branchName);
    });

    await test.step('1. closing with "Fold summary" checked eventually delivers a compact summary into the parent (FR-034, FR-034a)', async () => {
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Close conversation' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Fold a compact summary into the parent conversation').check();
      await dialog.getByRole('button', { name: 'Close conversation' }).click();
      await expect(dialog).toHaveCount(0);

      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', 'closed', {
        timeout: 10_000,
      });

      // The close() HTTP call already returned above — the summary is generated and delivered
      // asynchronously (research R1's `sendCustomMessage(..., { deliverAs: 'nextTurn' })`), so this
      // is a genuinely async wait, not an artifact of the UI.
      await selectConversation(page, 'Main');
      const banner = page.locator('.folded-summary-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      // FR-034a content requirements: name, seeded selection, proposal list (none here), and no
      // raw transcript — this deterministic facts block is assembled by ConversationService,
      // never trusted to model recall.
      await expect(banner).toContainText(`Conversation: "${branchName}"`);
      await expect(banner).toContainText('Seeded from:');
      await expect(banner).toContainText('No proposals were made in this conversation.');
      // The synopsis half is a genuine (fake, in this test) Pi call, not a canned string: it
      // echoes the exact prompt ConversationService asked the closed conversation's own session,
      // proving the mechanism actually round-tripped through PiService.generateFoldSynopsis.
      await expect(banner).toContainText('Here is a fake deterministic answer to:');
      await expect(banner).toContainText('write a compact synopsis');

      // Quickstart US7 #1: "confirm the parent's next answer reflects the summary" — the fold was
      // delivered via sendCustomMessage(deliverAs: 'nextTurn'), so Main's very next turn picks it
      // up as context (FakeAgentSession echoes queued custom messages into its next plain answer).
      const mainComposer = page.getByLabel('Message Main');
      await mainComposer.fill('What happened in that conversation?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.message-list')).toContainText('Noted custom context', { timeout: 15_000 });
      await expect(page.locator('.message-list')).toContainText(`closed conversation "${branchName}"`);
      await waitIdle(page);
    });

    await test.step('2. viewing the closed conversation shows it as read-only: no branch/primary/send/refresh-send (FR-035, SC-009)', async () => {
      await selectConversation(page, branchName);

      await expect(page.locator('.readonly-banner')).toBeVisible();
      await expect(page.locator('.conversation-header .close-button')).toHaveCount(0);
      // No send/refresh-send at all on a closed conversation — the composer is hidden entirely
      // rather than shown disabled, since none of it is available once closed (FR-035).
      await expect(page.getByLabel(`Message ${branchName}`)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Refresh + Send' })).toHaveCount(0);

      // No "Make Primary" control on a closed conversation's HUD row (FR-027/FR-035).
      const hudRow = page.locator('.hud-panel li', { hasText: branchName });
      await expect(hudRow.getByRole('button', { name: 'Make Primary' })).toHaveCount(0);
      await expect(hudRow.locator('.readonly-badge')).toBeVisible();

      // History and proposals remain intact and visible (SC-009) — the conversation view still
      // renders its prior messages rather than going blank.
      await expect(page.locator('.message-list')).toContainText('branched from');
    });

    await test.step('3. requesting a review produces an independent conversation without altering the closed one (FR-036)', async () => {
      const before = await getConversationDetail(page.request, (await findConversation(page.request, branchName)).id);
      const messageCountBefore = before.messages.length;

      await page.getByRole('button', { name: 'Request review' }).click();

      const reviewName = `Review: ${branchName}`;
      await expect(page.locator('.conversation-header h2')).toHaveText(reviewName, { timeout: 10_000 });

      const reviewConversation = await findConversation(page.request, reviewName);
      expect(reviewConversation.kind).toBe('review');

      // The review conversation is independently usable: it can be sent a message like any other.
      await waitIdle(page);
      const reviewComposer = page.getByLabel(`Message ${reviewName}`);
      await reviewComposer.fill('Summarize your findings.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', 'working', {
        timeout: 10_000,
      });
      await waitIdle(page);

      // The reviewed (closed) conversation is byte-identical: same message count, still closed.
      const closedId = (await findConversation(page.request, branchName)).id;
      const after = await getConversationDetail(page.request, closedId);
      expect(after.messages.length).toBe(messageCountBefore);
      expect(after.conversation.status).toBe('closed');
    });
  });

  test('4. closing a parent conversation leaves its still-open child fully usable (FR-035a)', async ({ page }) => {
    await ensureFixtureDocument(page);

    await test.step('branch a parent conversation, then branch a child from it', async () => {
      await branchFromMarker(page, 'US7-MARKER-PARENT', 'US7 Parent Target');
    });

    const parent = await findConversation(page.request, 'US7 Parent Target');

    const branchResponse = await page.request.post('/api/conversations', {
      data: { parentConversationId: parent.id, name: 'US7 Open Child' },
    });
    expect(branchResponse.ok()).toBe(true);
    const child = (await branchResponse.json()) as ConversationSummary;
    expect(child.parentId).toBe(parent.id);
    await expect
      .poll(async () => (await findConversation(page.request, 'US7 Open Child')).status, { timeout: 10_000 })
      .not.toBe('working');

    await test.step('close the parent (no fold needed for this scenario)', async () => {
      await selectConversation(page, 'US7 Parent Target');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Close conversation' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close conversation' }).click();
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', 'closed', {
        timeout: 10_000,
      });
    });

    await test.step('the child remains open, unaffected, and fully usable: send, branch (FR-035a)', async () => {
      const childAfter = await findConversation(page.request, 'US7 Open Child');
      expect(childAfter.status).not.toBe('closed');
      expect(childAfter.parentId).toBe(parent.id); // historical branch link retained

      await selectConversation(page, 'US7 Open Child');
      await expect(page.locator('.readonly-banner')).toHaveCount(0);
      await expect(page.getByLabel('Message US7 Open Child')).toBeEnabled();

      const composer = page.getByLabel('Message US7 Open Child');
      await composer.fill('Are you still usable after your parent closed?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await waitIdle(page);
      await expect(page.locator('.message-list')).toContainText('fake deterministic answer');

      // Still able to branch further (FR-013/FR-035a: only the closed parent itself is
      // unbranchable, the still-open child is not restricted by its parent's closure).
      const grandchildResponse = await page.request.post('/api/conversations', {
        data: { parentConversationId: child.id, name: 'US7 Grandchild' },
      });
      expect(grandchildResponse.ok()).toBe(true);
      const grandchild = (await grandchildResponse.json()) as ConversationSummary;
      expect(grandchild.parentId).toBe(child.id);
    });
  });
});
