import { test, expect, type Page } from '@playwright/test';

// Mirrors app/backend/src/pi/fake-agent-session.ts's PROPOSE_EDIT_DIRECTIVE — a user/system
// message beginning with this prefix, followed by a JSON { summary, operations } payload, causes
// FakeAgentSession to actually invoke the real propose_document_edit tool (document-tools.ts)
// instead of its canned answer, so these scenarios exercise the genuine EditService/
// ConflictService pipeline deterministically, with no live model involved.
const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';

function proposeEdit(summary: string, operations: { old_string: string; new_string: string }[]): string {
  return `${PROPOSE_EDIT_DIRECTIVE}${JSON.stringify({ summary, operations })}`;
}

// Unique marker lines appended to whatever document exists when this spec runs (it may already
// have been created by us1/us2 in the same `npm run test:e2e` process, or not exist yet when run
// in isolation via `--grep "US3"`) — old_string targets below are the full marker line text, which
// is trivially unique regardless of any other content already in the document.
const MARKERS = {
  intro: 'US3-MARKER-INTRO: The introduction is straightforward and needs no changes.',
  target1: 'US3-MARKER-TARGET-1: This sentence will be tightened by the agent.',
  target2: 'US3-MARKER-TARGET-2: Another sentence stays the same forever.',
  bulk1: 'US3-MARKER-BULK-1: Yet another line exists here for bulk edit testing.',
  bulk2: 'US3-MARKER-BULK-2: This one too is here for bulk edit testing purposes.',
  bulk3: 'US3-MARKER-BULK-3: And a final line rounds out the body section.',
  active: 'US3-MARKER-ACTIVE: The conclusion wraps everything up nicely.',
  close: 'US3-MARKER-CLOSE: This note exists only for the close-blocked test.',
};

const MARKER_BLOCK = [
  '',
  '',
  '## US3 Body',
  '',
  MARKERS.intro,
  '',
  MARKERS.target1,
  '',
  MARKERS.target2,
  '',
  MARKERS.bulk1,
  '',
  MARKERS.bulk2,
  '',
  MARKERS.bulk3,
  '',
  MARKERS.active,
  '',
  MARKERS.close,
].join('\n');

// Matches EditorComponent.vue's plain (non-`Mod`-qualified) CodeMirror keymap entry — the same
// physical shortcut on every platform, chosen to avoid reserved browser chrome combos.
const BRANCH_SHORTCUT = 'Alt+Shift+C';

/** Ensures a document exists containing MARKER_BLOCK, regardless of whether this spec runs in
 * isolation (paste screen appears) or after us1/us2 in the same `npm run test:e2e` process
 * (document already exists — the marker block is appended via the same PATCH /api/document path
 * US1's manual-edit flow already uses, so nothing here bypasses the application's real write path). */
async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US3 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.toolbar h1')).toBeVisible();
    return;
  }

  const existing = await page.request.get('/api/document');
  const body = (await existing.json()) as { document: { currentRevision: number }; content: string };
  if (body.content.includes(MARKERS.intro)) return; // a previous US3 run already appended it

  const from = body.content.length;
  await page.request.patch('/api/document', {
    data: { baseRevision: body.document.currentRevision, changes: [{ from, to: from, insert: MARKER_BLOCK }] },
  });
  await page.reload();
  await expect(page.locator('.toolbar h1')).toBeVisible();
}

async function waitIdle(page: Page): Promise<void> {
  await expect(
    page.locator('.conversation-view .conversation-header .badge').first(),
  ).toHaveAttribute('data-status', /idle|closed/, { timeout: 20_000 });
}

test.describe('US3 — branch from a selection and review proposed edits', () => {
  test('branch, propose, preview, accept, drop, bulk, act-while-active, close-blocked', async ({ page }) => {
    let branchName = '';

    await test.step('fixture document exists with known marker content', async () => {
      await ensureFixtureDocument(page);
    });

    await test.step('branch from a keyboard-selected passage (FR-011, FR-043a)', async () => {
      const introLine = page.locator('.cm-line', { hasText: 'US3-MARKER-INTRO' });
      await introLine.scrollIntoViewIfNeeded();
      await introLine.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press(BRANCH_SHORTCUT);

      // The branch is created under Main, selected automatically, and its name is derived from
      // the enclosing "## US3 Body" heading (seed-excerpt.ts's deriveBranchName).
      await expect(page.locator('.conversation-header h2')).toHaveText('US3 Body', { timeout: 10_000 });
      branchName = 'US3 Body';

      await expect(page.getByRole('navigation', { name: 'Conversations' }).getByText('US3 Body')).toBeVisible();

      // FR-012: the seeded first message contains the highlighted text.
      await expect(page.locator('.message-bubble[data-role="user"]').first()).toContainText(
        'US3-MARKER-INTRO',
      );

      await waitIdle(page);
    });

    await test.step('propose an edit -> a pending proposal appears; document stays byte-identical (FR-021, SC-004)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Tighten the target sentence', [
          { old_string: MARKERS.target1, new_string: 'US3-MARKER-TARGET-1: This sentence has been tightened.' },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const row = page.locator('.edit-row', { hasText: 'Tighten the target sentence' });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.locator('.status-badge')).toHaveText('pending');

      const currentContent = await page.locator('.editor-host').innerText();
      expect(currentContent).toContain(MARKERS.target1);
      expect(currentContent).not.toContain('This sentence has been tightened.');

      await waitIdle(page);
    });

    await test.step('preview shows both a full-document view and an added/removed hunks view (FR-022, FR-043c)', async () => {
      const row = page.locator('.edit-row', { hasText: 'Tighten the target sentence' });
      await row.getByRole('button', { name: 'Preview' }).click();

      const dialog = page.getByRole('dialog', { name: 'Review proposed edit' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('del.removed').first()).toBeVisible();
      await expect(dialog.locator('ins.added').first()).toBeVisible();
      // FR-043c: conveyed by more than color — a leading marker glyph plus visually-hidden label.
      await expect(dialog.locator('del.removed .marker').first()).toHaveText('−');
      await expect(dialog.locator('ins.added .marker').first()).toHaveText('+');

      await dialog.getByRole('tab', { name: 'Full document' }).click();
      await expect(dialog.locator('.full-preview pre')).toContainText('This sentence has been tightened.');

      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).not.toBeVisible();
    });

    await test.step('accept -> the document updates and a new revision is attributed to this conversation (FR-025, SC-008)', async () => {
      const row = page.locator('.edit-row', { hasText: 'Tighten the target sentence' });
      await row.getByRole('button', { name: 'Accept' }).click();
      await expect(row.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });

      await expect(page.locator('.editor-host')).toContainText('This sentence has been tightened.', {
        timeout: 10_000,
      });

      await page.getByRole('button', { name: 'History' }).click();
      await expect(page.locator('.history-entry').first()).toContainText(branchName);
      await page.getByRole('button', { name: 'Hide history' }).click();
    });

    let contentBeforeDrop = '';

    await test.step('elicit a second proposal, drop it -> document unchanged, gone from pending (FR-023)', async () => {
      contentBeforeDrop = await page.locator('.editor-host').innerText();

      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Rewrite the second sentence', [
          { old_string: MARKERS.target2, new_string: 'US3-MARKER-TARGET-2: Something else entirely.' },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const row = page.locator('.edit-row', { hasText: 'Rewrite the second sentence' });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.getByRole('button', { name: 'Drop' }).click();
      await expect(row.locator('.status-badge')).toHaveText('dropped', { timeout: 10_000 });

      const currentContent = await page.locator('.editor-host').innerText();
      expect(currentContent).toBe(contentBeforeDrop);

      await waitIdle(page);
    });

    await test.step('elicit three proposals; resolve one, then Drop remaining resolves the other two (FR-023)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);

      for (const [summary, marker] of [
        ['Bulk edit one', MARKERS.bulk1],
        ['Bulk edit two', MARKERS.bulk2],
        ['Bulk edit three', MARKERS.bulk3],
      ] as const) {
        await composer.fill(proposeEdit(summary, [{ old_string: marker, new_string: `${marker} EDITED` }]));
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.edit-row', { hasText: summary })).toBeVisible({ timeout: 15_000 });
        await waitIdle(page);
      }

      // Resolve one individually first.
      const first = page.locator('.edit-row', { hasText: 'Bulk edit one' });
      await first.getByRole('button', { name: 'Drop' }).click();
      await expect(first.locator('.status-badge')).toHaveText('dropped', { timeout: 10_000 });

      // The other two resolve together via the bulk action.
      await page.getByRole('button', { name: 'Drop remaining' }).click();
      await expect(page.locator('.edit-row', { hasText: 'Bulk edit two' }).locator('.status-badge')).toHaveText(
        'dropped',
        { timeout: 10_000 },
      );
      await expect(page.locator('.edit-row', { hasText: 'Bulk edit three' }).locator('.status-badge')).toHaveText(
        'dropped',
        { timeout: 10_000 },
      );
    });

    await test.step('act while active: accept a pending proposal while the agent is still working (FR-024)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);

      await composer.fill(
        proposeEdit('Revise the active-turn sentence', [
          { old_string: MARKERS.active, new_string: 'US3-MARKER-ACTIVE: The conclusion has been revised.' },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const activeRow = page.locator('.edit-row', { hasText: 'Revise the active-turn sentence' });
      await expect(activeRow).toBeVisible({ timeout: 15_000 });
      await waitIdle(page);

      // A long message keeps FakeAgentSession streaming for long enough to accept mid-turn.
      await composer.fill('x'.repeat(2000));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', 'working');

      await activeRow.getByRole('button', { name: 'Accept' }).click();
      await expect(activeRow.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });
      await expect(page.locator('.editor-host')).toContainText('The conclusion has been revised.');

      await waitIdle(page);
    });

    await test.step('close is blocked while a proposal is pending, then succeeds once resolved (FR-033)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Edit for the close test', [{ old_string: MARKERS.close, new_string: `${MARKERS.close} EDITED` }]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const closeRow = page.locator('.edit-row', { hasText: 'Edit for the close test' });
      await expect(closeRow).toBeVisible({ timeout: 15_000 });
      await waitIdle(page);

      // US7's close dialog (FR-034): clicking the header "Close" button opens a confirmation
      // dialog offering a separate "Fold summary" option before the close itself is confirmed.
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      const closeDialog = page.getByRole('alertdialog', { name: 'Close conversation' });
      await expect(closeDialog).toBeVisible();
      await closeDialog.getByRole('button', { name: 'Close conversation' }).click();
      await expect(page.locator('.conversation-view .error-banner')).toContainText(/pending/i, { timeout: 10_000 });
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', 'idle');

      await closeRow.getByRole('button', { name: 'Drop' }).click();
      await expect(closeRow.locator('.status-badge')).toHaveText('dropped', { timeout: 10_000 });

      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(closeDialog).toBeVisible();
      await closeDialog.getByRole('button', { name: 'Close conversation' }).click();
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', 'closed', {
        timeout: 10_000,
      });
    });
  });
});
