import { test, expect, type Page } from '@playwright/test';

// Mirrors app/backend/src/pi/fake-agent-session.ts's directive protocol — see us3.spec.ts/
// us5.spec.ts for the same convention. `FakeAgentSession` never decides on its own to call
// `propose_document_edit` again after a conflict — the conflict-recovery ("replacement") turn
// ConflictService fires automatically just gets a canned plain-text reply from it, same as any
// other prompt that isn't a recognized directive. So, exactly like us5.spec.ts's Primary-conflict
// step, a "replacement" is delivered by an explicit follow-up composer message using
// PROPOSE_EDIT_DIRECTIVE: the conflict-recorded `supersedes_id` marker (edit-service.ts's
// `awaitingReplacement`) is still pending server-side from the automatic replacement request, so
// this next `propose_document_edit` call — whichever turn it arrives on — still gets linked to the
// superseded original automatically, exactly per agent-tools.md §Conflict recovery. No extension to
// the directive protocol was needed: every US6 conflict below is a *real* TextAnchor conflict,
// forced by mutating the live document between staging and applying (never a scripted fake one).
const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';

function proposeEdit(
  summary: string,
  operations: { old_string: string; new_string: string }[],
): string {
  return `${PROPOSE_EDIT_DIRECTIVE}${JSON.stringify({ summary, operations })}`;
}

const MARKERS = {
  clean: 'US6-MARKER-CLEAN: This sentence will be improved without any conflict.',
  cleanElsewhere: 'US6-MARKER-CLEAN-ELSEWHERE: This other sentence changes concurrently.',
  notfound: 'US6-MARKER-NOTFOUND: This sentence anchors the not_found conflict scenario.',
  ambiguous: 'US6-MARKER-AMBIGUOUS: This unique phrase will be duplicated to force ambiguity.',
  chained: 'US6-MARKER-CHAINED: This sentence will drift twice before a replacement lands.',
  exhaust: 'US6-MARKER-EXHAUST: This sentence will drift three times to exhaust the budget.',
  restore: 'US6-MARKER-RESTORE: This sentence is targeted by a pending proposal during restore.',
};

const MARKER_BLOCK = [
  '',
  '',
  '## US6 Body',
  '',
  MARKERS.clean,
  '',
  MARKERS.cleanElsewhere,
  '',
  MARKERS.notfound,
  '',
  MARKERS.ambiguous,
  '',
  MARKERS.chained,
  '',
  MARKERS.exhaust,
].join('\n');

const BRANCH_SHORTCUT = 'Alt+Shift+C';

async function getDocumentState(page: Page): Promise<{ currentRevision: number; content: string }> {
  const response = await page.request.get('/api/document');
  const body = (await response.json()) as {
    document: { currentRevision: number };
    content: string;
  };
  return { currentRevision: body.document.currentRevision, content: body.content };
}

/** Rewrites `oldStr` (which must appear exactly once) to `newStr` via the same manual-edit HTTP
 *  path US1 uses (PATCH /api/document), and waits for the resulting revision to land — this is how
 *  every conflict in this spec is forced: a real anchor mismatch against the live document, never a
 *  scripted one. Mirrors us5.spec.ts's Primary-conflict step. */
async function mutateDocument(page: Page, oldStr: string, newStr: string): Promise<void> {
  const before = await getDocumentState(page);
  const occurrences = before.content.split(oldStr).length - 1;
  expect(occurrences).toBe(1);
  const mutated = before.content.replace(oldStr, newStr);
  await page.request.patch('/api/document', {
    data: {
      baseRevision: before.currentRevision,
      changes: [{ from: 0, to: before.content.length, insert: mutated }],
    },
  });
  await expect
    .poll(async () => (await getDocumentState(page)).currentRevision, {
      timeout: 10_000,
      intervals: [300],
    })
    .toBeGreaterThan(before.currentRevision);
}

/** Ensures a document exists containing MARKER_BLOCK, regardless of whether this spec runs in
 *  isolation (paste screen appears) or after us1-us5 in the same `npm run test:e2e` process
 *  (document already exists) — mirrors us3.spec.ts/us5.spec.ts's `ensureFixtureDocument` (incl.
 *  its stale-`.toolbar h1`-selector fix — see us3.spec.ts). */
async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US6 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.preview-pane')).toBeVisible();
    return;
  }

  const before = await getDocumentState(page);
  if (before.content.includes(MARKERS.clean)) return; // a previous US6 run already appended it

  const from = before.content.length;
  await page.request.patch('/api/document', {
    data: {
      baseRevision: before.currentRevision,
      changes: [{ from, to: from, insert: MARKER_BLOCK }],
    },
  });
  await expect
    .poll(async () => (await getDocumentState(page)).currentRevision, {
      timeout: 10_000,
      intervals: [300],
    })
    .toBeGreaterThan(before.currentRevision);

  await page.reload();
  await expect(page.locator('.preview-pane')).toBeVisible();
}

async function waitIdle(page: Page): Promise<void> {
  await expect(
    page.locator('.conversation-view .conversation-header .badge').first(),
  ).toHaveAttribute('data-status', /idle|closed/, { timeout: 20_000 });
}

/** Branches from the line containing `markerText`, selected via the keyboard (FR-043a), and
 *  returns the derived branch conversation name so callers can target its composer. */
async function branchFromMarker(page: Page, markerText: string): Promise<string> {
  // CodeMirror only renders lines near the current viewport (research/design notwithstanding —
  // this spec runs after us1-us5 in the shared `npm run test:e2e` process, by which point the
  // document is long enough that the US6 markers, appended at the very end, are not yet in the
  // DOM at all). Ctrl+End moves the caret to the document end and scrolls it into view first — a
  // standard, keyboard-only editor command (FR-043a) — which renders the tail lines this spec's
  // markers live in, all appended close to the document's end.
  await page.locator('.editor-host').click();
  await page.keyboard.press('Control+End');
  const line = page.locator('.cm-line', { hasText: markerText });
  await line.scrollIntoViewIfNeeded();
  await line.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press(BRANCH_SHORTCUT);

  // a26fbec: auto-generated conversation names are now de-duplicated on collision — a second
  // branch from the same enclosing heading gets " (2)" appended, a third " (3)", etc. — so this
  // reads back whatever name was actually assigned instead of hardcoding "US6 Body". Every marker
  // in this file's MARKER_BLOCK sits under the same "## US6 Body" heading, and this file's two
  // tests both branch from it, so the second call here returns "US6 Body (2)".
  const header = page.locator('.conversation-header h2');
  await expect(header).toContainText('US6 Body', { timeout: 10_000 });
  const branchName = ((await header.textContent()) ?? '').trim();
  await waitIdle(page);
  return branchName;
}

test.describe('US6 — Resolve conflicts when applying an out-of-date proposal', () => {
  test('clean apply, not_found, ambiguous, chained replacement, and budget exhaustion (FR-031, FR-032)', async ({
    page,
  }) => {
    // Six sequential scenarios, several with two full conflict/replacement round trips each — a
    // legitimately longer compound test than any single other US spec exercises in one go.
    test.setTimeout(90_000);

    await test.step('fixture document exists with known marker content', async () => {
      await ensureFixtureDocument(page);
    });

    let branchName = '';
    await test.step('branch a conversation to run every US6 scenario from', async () => {
      // The full marker line (not the short "US6-MARKER-CLEAN" prefix) to avoid also matching the
      // "US6-MARKER-CLEAN-ELSEWHERE" line.
      branchName = await branchFromMarker(page, MARKERS.clean);
    });

    await test.step('1-2. clean reconcile: the document advances elsewhere without touching the anchor (FR-031, FR-031a)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Improve the clean sentence', [
          { old_string: MARKERS.clean, new_string: `${MARKERS.clean} IMPROVED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const row = page.locator('.edit-row', { hasText: 'Improve the clean sentence' });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.locator('.status-badge')).toHaveText('pending');
      await waitIdle(page);

      // Advance the document elsewhere — a concurrent manual edit unrelated to this proposal's anchor.
      await mutateDocument(
        page,
        MARKERS.cleanElsewhere,
        `${MARKERS.cleanElsewhere} CHANGED CONCURRENTLY`,
      );

      await row.getByRole('button', { name: 'Accept' }).click();
      await expect(row.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });

      // SC-005: both the proposal's change and the concurrent manual edit are preserved.
      await expect(page.locator('.editor-host')).toContainText(`${MARKERS.clean} IMPROVED`);
      await expect(page.locator('.editor-host')).toContainText('CHANGED CONCURRENTLY');
    });

    await test.step('3. not_found conflict: rewriting the exact anchored region supersedes and requests a replacement (FR-032)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Fix the not_found sentence', [
          { old_string: MARKERS.notfound, new_string: `${MARKERS.notfound} EDITED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const originalRow = page.locator('.edit-row', { hasText: 'Fix the not_found sentence' });
      await expect(originalRow).toBeVisible({ timeout: 15_000 });
      await waitIdle(page);

      const mutatedNotfound = MARKERS.notfound.replace(
        'anchors the not_found conflict scenario',
        'no longer matches the mutated scenario',
      );
      await mutateDocument(page, MARKERS.notfound, mutatedNotfound);

      await originalRow.getByRole('button', { name: 'Accept' }).click();
      await expect(originalRow.locator('.status-badge')).toHaveText('superseded', {
        timeout: 10_000,
      });
      await expect(page.locator('.editor-host')).not.toContainText(`${MARKERS.notfound} EDITED`);
      await waitIdle(page);

      // The replacement, informed by the conflict, targets the current (mutated) text.
      await composer.fill(
        proposeEdit('Replacement for the not_found sentence', [
          { old_string: mutatedNotfound, new_string: `${mutatedNotfound} REPLACED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const replacementRow = page.locator('.edit-row', {
        hasText: 'Replacement for the not_found sentence',
      });
      await expect(replacementRow).toBeVisible({ timeout: 15_000 });
      await expect(replacementRow.locator('.status-badge')).toHaveText('pending', {
        timeout: 10_000,
      });
      await expect(replacementRow.locator('.chain-indicator')).toBeVisible();

      await replacementRow.getByRole('button', { name: 'Accept' }).click();
      await expect(replacementRow.locator('.status-badge')).toHaveText('applied', {
        timeout: 10_000,
      });
      await expect(page.locator('.editor-host')).toContainText(`${mutatedNotfound} REPLACED`);
      await waitIdle(page);
    });

    await test.step('4. ambiguous conflict: duplicating the anchor supersedes and requests a replacement (FR-032)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Fix the ambiguous sentence', [
          { old_string: MARKERS.ambiguous, new_string: `${MARKERS.ambiguous} EDITED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const originalRow = page.locator('.edit-row', { hasText: 'Fix the ambiguous sentence' });
      await expect(originalRow).toBeVisible({ timeout: 15_000 });
      await waitIdle(page);

      // Duplicate the anchored text elsewhere so it is no longer unique (ambiguous, not not_found).
      const before = await getDocumentState(page);
      await page.request.patch('/api/document', {
        data: {
          baseRevision: before.currentRevision,
          changes: [
            {
              from: before.content.length,
              to: before.content.length,
              insert: `\n\n${MARKERS.ambiguous}\n`,
            },
          ],
        },
      });
      await expect
        .poll(async () => (await getDocumentState(page)).currentRevision, {
          timeout: 10_000,
          intervals: [300],
        })
        .toBeGreaterThan(before.currentRevision);

      await originalRow.getByRole('button', { name: 'Accept' }).click();
      await expect(originalRow.locator('.status-badge')).toHaveText('superseded', {
        timeout: 10_000,
      });
      await waitIdle(page);

      // A replacement with enough surrounding context to be unique this time.
      await composer.fill(
        proposeEdit('Replacement for the ambiguous sentence', [
          {
            old_string: `${MARKERS.ambiguous}\n\n${MARKERS.chained}`,
            new_string: `${MARKERS.ambiguous} DISAMBIGUATED\n\n${MARKERS.chained}`,
          },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const replacementRow = page.locator('.edit-row', {
        hasText: 'Replacement for the ambiguous sentence',
      });
      await expect(replacementRow).toBeVisible({ timeout: 15_000 });
      await expect(replacementRow.locator('.status-badge')).toHaveText('pending', {
        timeout: 10_000,
      });

      await replacementRow.getByRole('button', { name: 'Accept' }).click();
      await expect(replacementRow.locator('.status-badge')).toHaveText('applied', {
        timeout: 10_000,
      });
      await expect(page.locator('.editor-host')).toContainText('DISAMBIGUATED');
      await waitIdle(page);
    });

    await test.step('5. chained replacement: a replacement itself goes stale before it is applied (edge case)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Fix the chained sentence', [
          { old_string: MARKERS.chained, new_string: `${MARKERS.chained} EDITED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const edit1Row = page.locator('.edit-row', { hasText: 'Fix the chained sentence' });
      await expect(edit1Row).toBeVisible({ timeout: 15_000 });
      await waitIdle(page);

      const revA = MARKERS.chained.replace(
        'drift twice before a replacement lands',
        'has drifted once (rev A)',
      );
      await mutateDocument(page, MARKERS.chained, revA);
      await edit1Row.getByRole('button', { name: 'Accept' }).click();
      await expect(edit1Row.locator('.status-badge')).toHaveText('superseded', { timeout: 10_000 });
      await waitIdle(page);

      await composer.fill(
        proposeEdit('Chained replacement 1', [
          { old_string: revA, new_string: `${revA} REPLACED-1` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const edit2Row = page.locator('.edit-row', { hasText: 'Chained replacement 1' });
      await expect(edit2Row).toBeVisible({ timeout: 15_000 });
      await expect(edit2Row.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });
      await expect(edit2Row.locator('.chain-indicator')).toBeVisible();
      await waitIdle(page);

      // The replacement itself goes stale before the user gets to act on it.
      const revB = revA.replace('has drifted once (rev A)', 'has drifted twice (rev B)');
      await mutateDocument(page, revA, revB);
      await edit2Row.getByRole('button', { name: 'Accept' }).click();
      await expect(edit2Row.locator('.status-badge')).toHaveText('superseded', { timeout: 10_000 });
      await waitIdle(page);

      await composer.fill(
        proposeEdit('Chained replacement 2', [
          { old_string: revB, new_string: `${revB} REPLACED-2` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const edit3Row = page.locator('.edit-row', { hasText: 'Chained replacement 2' });
      await expect(edit3Row).toBeVisible({ timeout: 15_000 });
      await expect(edit3Row.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });

      await edit3Row.getByRole('button', { name: 'Accept' }).click();
      await expect(edit3Row.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });
      await expect(page.locator('.editor-host')).toContainText(`${revB} REPLACED-2`);
      await waitIdle(page);
    });

    await test.step('6. budget exhaustion: the third conflict in a row stops requesting replacements (FR-032a, FR-032b)', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Fix the exhaust sentence', [
          { old_string: MARKERS.exhaust, new_string: `${MARKERS.exhaust} EDITED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const edit1Row = page.locator('.edit-row', { hasText: 'Fix the exhaust sentence' });
      await expect(edit1Row).toBeVisible({ timeout: 15_000 });
      await waitIdle(page);

      const revA = MARKERS.exhaust.replace(
        'drift three times to exhaust the budget',
        'has drifted (rev A)',
      );
      await mutateDocument(page, MARKERS.exhaust, revA);
      await edit1Row.getByRole('button', { name: 'Accept' }).click();
      await expect(edit1Row.locator('.status-badge')).toHaveText('superseded', { timeout: 10_000 });
      await waitIdle(page);

      await composer.fill(
        proposeEdit('Exhaust replacement 1', [{ old_string: revA, new_string: `${revA} R1` }]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const edit2Row = page.locator('.edit-row', { hasText: 'Exhaust replacement 1' });
      await expect(edit2Row).toBeVisible({ timeout: 15_000 });
      await expect(edit2Row.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });
      await waitIdle(page);

      const revB = revA.replace('has drifted (rev A)', 'has drifted again (rev B)');
      await mutateDocument(page, revA, revB);
      await edit2Row.getByRole('button', { name: 'Accept' }).click();
      await expect(edit2Row.locator('.status-badge')).toHaveText('superseded', { timeout: 10_000 });
      await waitIdle(page);

      await composer.fill(
        proposeEdit('Exhaust replacement 2', [{ old_string: revB, new_string: `${revB} R2` }]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const edit3Row = page.locator('.edit-row', { hasText: 'Exhaust replacement 2' });
      await expect(edit3Row).toBeVisible({ timeout: 15_000 });
      await expect(edit3Row.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });
      await waitIdle(page);

      // Default max_replacement_attempts is 2 — this third conflict in the chain exhausts it.
      const revC = revB.replace('has drifted again (rev B)', 'has drifted a third time (rev C)');
      await mutateDocument(page, revB, revC);
      const contentBeforeExhaustedApply = (await getDocumentState(page)).content;
      await edit3Row.getByRole('button', { name: 'Accept' }).click();
      await expect(edit3Row.locator('.status-badge')).toHaveText('superseded', { timeout: 10_000 });

      await expect(page.locator('.exhausted-banner')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.exhausted-banner')).toContainText(/could not produce an edit/i);
      // The document is unchanged by the exhausted apply attempt itself.
      expect((await getDocumentState(page)).content).toBe(contentBeforeExhaustedApply);
      await waitIdle(page);

      // The conversation stays usable — dismissing the banner and continuing to chat works.
      await page.locator('.exhausted-banner').getByRole('button', { name: 'Dismiss' }).click();
      await expect(page.locator('.exhausted-banner')).toHaveCount(0);
    });
  });

  test('7. restoring an earlier revision surfaces the dry-run reconciliation without altering a pending proposal', async ({
    page,
  }) => {
    // 79c2d07: dropping a proposed edit now gates behind window.confirm — Playwright auto-dismisses
    // unhandled native dialogs, so accept it here (this test's only Drop click, further below).
    page.on('dialog', (dialog) => void dialog.accept());
    await ensureFixtureDocument(page);

    const beforeMarker = await getDocumentState(page);
    const from = beforeMarker.content.length;
    await page.request.patch('/api/document', {
      data: {
        baseRevision: beforeMarker.currentRevision,
        changes: [{ from, to: from, insert: `\n\n${MARKERS.restore}\n` }],
      },
    });
    await expect
      .poll(async () => (await getDocumentState(page)).currentRevision, {
        timeout: 10_000,
        intervals: [300],
      })
      .toBeGreaterThan(beforeMarker.currentRevision);
    await page.reload();
    await expect(page.locator('.preview-pane')).toBeVisible();

    const branchName = await branchFromMarker(page, MARKERS.restore);
    const composer = page.getByLabel(`Message ${branchName}`);
    await composer.fill(
      proposeEdit('Proposal pending across a restore', [
        { old_string: MARKERS.restore, new_string: `${MARKERS.restore} EDITED` },
      ]),
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const row = page.locator('.edit-row', { hasText: 'Proposal pending across a restore' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });
    await waitIdle(page);

    // `branchName` is now already de-duplicated (a26fbec — e.g. "US6 Body (2)" since this file's
    // first test already created a "US6 Body" branch from the same enclosing heading), so this
    // filter matches exactly this test's own fresh branch. `.at(-1)` is kept defensively (`GET
    // /api/conversations` orders by `createdAt` ascending, per http-api.md) in case a name ever
    // collides again for some other reason.
    const conversationsBefore = (await page.request
      .get('/api/conversations')
      .then((r) => r.json())) as {
      conversations: { id: string; name: string }[];
    };
    const conversation = conversationsBefore.conversations
      .filter((c) => c.name === branchName)
      .at(-1);
    expect(conversation).toBeTruthy();
    const editsBefore = (await page.request
      .get(`/api/conversations/${conversation!.id}/edits`)
      .then((r) => r.json())) as {
      stagedEdits: { id: string; status: string; summary: string }[];
    };
    const stagedEdit = editsBefore.stagedEdits.find(
      (e) => e.summary === 'Proposal pending across a restore',
    );
    expect(stagedEdit?.status).toBe('pending');

    // Restore to the revision *before* the RESTORE marker existed — the pending proposal's anchor
    // will no longer resolve against that content (reconcilable: false, not_found). Matched by the
    // exact "v<N>" label (not a plain substring, which "v1" would also match inside "v10"/"v11").
    await page.getByRole('button', { name: 'History' }).click();
    const targetEntry = page.locator('.history-entry').filter({
      has: page.locator('strong', { hasText: new RegExp(`^v${beforeMarker.currentRevision}$`) }),
    });
    await targetEntry.getByRole('button', { name: 'Restore' }).click();
    // c92bf3f: Restore now opens a confirmation dialog (role="alertdialog") before actually
    // restoring — click through it to exercise the full restore flow.
    const restoreDialog = page.getByRole('alertdialog', { name: 'Restore revision' });
    await expect(restoreDialog).toBeVisible();
    await restoreDialog.getByRole('button', { name: 'Restore' }).click();
    await expect(restoreDialog).not.toBeVisible();

    await expect(page.locator('.reconciliation-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.reconciliation-panel')).toContainText('No longer applies');
    await expect(page.locator('.reconciliation-panel')).toContainText(
      'Proposal pending across a restore',
    );
    await expect(page.locator('.reconciliation-panel')).toContainText(branchName);

    await expect(page.locator('.editor-host')).not.toContainText(MARKERS.restore);

    // The dry-run never altered the proposal: still pending, unchanged, in the API.
    const editsAfter = (await page.request
      .get(`/api/conversations/${conversation!.id}/edits`)
      .then((r) => r.json())) as {
      stagedEdits: { id: string; status: string; summary: string }[];
    };
    const stagedEditAfter = editsAfter.stagedEdits.find((e) => e.id === stagedEdit!.id);
    expect(stagedEditAfter).toEqual(stagedEdit);

    await page.locator('.reconciliation-panel').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.reconciliation-panel')).toHaveCount(0);

    // Clean up: drop the now-unreconcilable proposal so it doesn't block anything later in the run.
    await row.getByRole('button', { name: 'Drop' }).click();
    await expect(row.locator('.status-badge')).toHaveText('dropped', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Hide history' }).click();
  });
});
