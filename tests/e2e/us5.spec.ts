import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// Mirrors app/backend/src/pi/fake-agent-session.ts's directive protocol — see us3.spec.ts/
// us4.spec.ts for the same convention. PROPOSE_EDIT_DIRECTIVE drives the real propose_document_edit
// tool deterministically; ERROR_DIRECTIVE (added for US5's FR-029a/FR-038a scenarios) makes a turn
// fail with `agent_error` instead of answering, so a conversation can be put into `errored` on cue.
const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';
const ERROR_DIRECTIVE = '__AGENT_ERROR__';

function proposeEdit(summary: string, operations: { old_string: string; new_string: string }[]): string {
  return `${PROPOSE_EDIT_DIRECTIVE}${JSON.stringify({ summary, operations })}`;
}

// Unique marker lines, following us3.spec.ts/us4.spec.ts's convention: old_string/assertion targets
// are the full marker line text, unique regardless of whatever other content the document already
// has when this spec runs (it may follow us1-us4 in the same `npm run test:e2e` process).
const MARKERS = {
  primary: 'US5-MARKER-PRIMARY: This sentence will be improved by the Primary conversation.',
  stageAfterSwitch: 'US5-MARKER-STAGE: This sentence demonstrates staging once Primary moves elsewhere.',
  conflict: 'US5-MARKER-CONFLICT: This sentence anchors the Primary conflict scenario.',
};

const MARKER_BLOCK = [
  '',
  '',
  '## US5 Body',
  '',
  MARKERS.primary,
  '',
  MARKERS.stageAfterSwitch,
  '',
  MARKERS.conflict,
  '',
].join('\n');

const BRANCH_SHORTCUT = 'Alt+Shift+C';

async function getDocumentState(page: Page): Promise<{ currentRevision: number; content: string }> {
  const response = await page.request.get('/api/document');
  const body = (await response.json()) as { document: { currentRevision: number }; content: string };
  return { currentRevision: body.document.currentRevision, content: body.content };
}

type ConversationSummary = { id: string; name: string; status: string; isPrimary: boolean };

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

/** Ensures a document exists containing MARKER_BLOCK, regardless of whether this spec runs in
 * isolation (paste screen appears) or after us1-us4 in the same `npm run test:e2e` process
 * (document already exists) — mirrors us3.spec.ts/us4.spec.ts's `ensureFixtureDocument`. */
async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US5 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.toolbar h1')).toBeVisible();
    return;
  }

  const before = await getDocumentState(page);
  if (before.content.includes(MARKERS.primary)) return; // a previous US5 run already appended it

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

/** Polls the HUD's per-row status badge for `name`, which is visible regardless of which
 *  conversation is currently selected/open in the detail pane. */
function hudStatusBadge(page: Page, name: string) {
  return page.locator('.hud-panel .conversation-row', { hasText: name }).locator('.status-badge');
}

test.describe('US5 — Designate a Primary conversation for automatic edits', () => {
  test('Primary defaults, auto-apply, switch-while-busy, staging, and Primary conflict (FR-027 - FR-030)', async ({
    page,
  }) => {
    let branchName = '';

    await test.step('fixture document exists with known marker content', async () => {
      await ensureFixtureDocument(page);
    });

    await test.step('1. Main is Primary by default, and exactly one conversation is Primary (FR-027)', async () => {
      const conversations = await getConversations(page.request);
      const main = conversations.find((c) => c.name === 'Main');
      expect(main?.isPrimary).toBe(true);
      expect(conversations.filter((c) => c.isPrimary)).toHaveLength(1);

      await expect(page.locator('.primary-summary')).toContainText('Primary: Main');
    });

    await test.step('2. Main auto-applies an edit immediately, with no pending proposal left behind (FR-027)', async () => {
      const composer = page.getByLabel('Message Main');
      await composer.fill(
        proposeEdit('Improve the Primary sentence', [
          { old_string: MARKERS.primary, new_string: `${MARKERS.primary} IMPROVED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const row = page.locator('.edit-row', { hasText: 'Improve the Primary sentence' });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });
      await expect(row.locator('.badge', { hasText: 'Primary auto-apply' })).toBeVisible();
      // Applied, not pending — no Accept/Drop actions remain on this row (FR-027's "no pending
      // proposal left behind"); the change is visible directly in the editor as the audit trail.
      await expect(row.getByRole('button', { name: 'Accept' })).toHaveCount(0);
      await expect(page.locator('.editor-host')).toContainText(`${MARKERS.primary} IMPROVED`);

      await waitIdle(page);
    });

    await test.step('branch a conversation to switch Primary onto (FR-011)', async () => {
      // Branch name is derived from the enclosing "## US5 Body" heading (seed-excerpt.ts's
      // deriveBranchName), same convention as us3.spec.ts/us4.spec.ts.
      const stageLine = page.locator('.cm-line', { hasText: 'US5-MARKER-STAGE' });
      await stageLine.scrollIntoViewIfNeeded();
      await stageLine.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press(BRANCH_SHORTCUT);

      await expect(page.locator('.conversation-header h2')).toHaveText('US5 Body', { timeout: 10_000 });
      branchName = 'US5 Body';
      await waitIdle(page);
    });

    await test.step('3. making the branch Primary while Main is busy shows the three-choice warning (FR-029)', async () => {
      // Branching (above) auto-selected the new branch in the HUD, so Main's composer is not
      // currently rendered (ConversationView shows only the selected conversation) — reselect it.
      await page.locator('.conversation-row', { hasText: 'Main' }).click();
      await expect(page.locator('.conversation-header h2')).toHaveText('Main');

      // A long message keeps FakeAgentSession streaming for long enough to attempt the switch
      // mid-turn (same technique as us3.spec.ts's "act while active" step). A generous length
      // keeps it streaming through both this step and step 4 below (both interact with the same
      // in-flight turn) with comfortable margin under CI load.
      const mainComposer = page.getByLabel('Message Main');
      await mainComposer.fill('x'.repeat(6000));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(hudStatusBadge(page, 'Main')).toHaveAttribute('data-status', 'working');

      const branchRow = page.locator('.hud-panel li', { hasText: branchName });
      await branchRow.getByRole('button', { name: 'Make Primary' }).click();

      const dialog = page.getByRole('alertdialog', { name: 'Primary conversation is busy' });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByRole('button', { name: 'Switch now' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Switch when idle' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

      // "Cancel" leaves the designation unchanged.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      const afterCancel = await findConversation(page.request, branchName);
      expect(afterCancel.isPrimary).toBe(false);
    });

    await test.step('4. "switch now" moves Primary immediately without interrupting Main\'s in-flight run (FR-030)', async () => {
      const branchRow = page.locator('.hud-panel li', { hasText: branchName });
      await branchRow.getByRole('button', { name: 'Make Primary' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Primary conversation is busy' });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Switch now' }).click();
      await expect(dialog).toHaveCount(0);

      await expect(branchRow.locator('.badge', { hasText: 'Primary' })).toBeVisible({ timeout: 10_000 });
      const afterSwitch = await findConversation(page.request, branchName);
      expect(afterSwitch.isPrimary).toBe(true);
      const main = await findConversation(page.request, 'Main');
      expect(main.isPrimary).toBe(false);

      // Main's long-running turn was not interrupted by the switch — it settles back to idle and
      // its assistant reply is present, exactly as if the switch had never happened.
      await expect(hudStatusBadge(page, 'Main')).toHaveAttribute('data-status', 'idle', { timeout: 20_000 });
    });

    await test.step('5. non-Primary conversations keep staging their proposals (FR-021)', async () => {
      const mainComposer = page.getByLabel('Message Main');
      await mainComposer.fill(
        proposeEdit('Stage this now that Main is not Primary', [
          { old_string: MARKERS.stageAfterSwitch, new_string: `${MARKERS.stageAfterSwitch} STAGED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const row = page.locator('.edit-row', { hasText: 'Stage this now that Main is not Primary' });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });
      await expect(row.getByRole('button', { name: 'Accept' })).toBeVisible();
      await expect(page.locator('.editor-host')).not.toContainText(`${MARKERS.stageAfterSwitch} STAGED`);

      // Clean up so this proposal doesn't block anything later in the run.
      await row.getByRole('button', { name: 'Accept' }).click();
      await expect(row.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });
      await waitIdle(page);
    });

    await test.step('6. Primary conflict: a stale anchor is superseded, and its replacement is presented as a pending proposal for review (FR-027)', async () => {
      // Select the (now-Primary) branch conversation.
      await page.locator('.conversation-row', { hasText: branchName }).click();
      await expect(page.locator('.conversation-header h2')).toHaveText(branchName);
      await waitIdle(page);

      // "Edit the document manually mid-run": mutate a word inside the anchor text (rather than
      // merely appending to it) so the exact `old_string` the proposal below targets no longer
      // exists as a substring anywhere in the document, deterministically forcing `not_found`.
      const mutatedConflictMarker = MARKERS.conflict.replace(
        'anchors the Primary conflict scenario',
        'no longer anchors the mutated scenario',
      );
      expect(mutatedConflictMarker).not.toBe(MARKERS.conflict);

      const before = await getDocumentState(page);
      const mutated = before.content.replace(MARKERS.conflict, mutatedConflictMarker);
      expect(mutated).not.toBe(before.content);
      await page.request.patch('/api/document', {
        data: { baseRevision: before.currentRevision, changes: [{ from: 0, to: before.content.length, insert: mutated }] },
      });
      await expect
        .poll(async () => (await getDocumentState(page)).currentRevision, { timeout: 10_000, intervals: [300] })
        .toBeGreaterThan(before.currentRevision);

      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill(
        proposeEdit('Primary edit against a stale anchor', [
          { old_string: MARKERS.conflict, new_string: `${MARKERS.conflict} EDITED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const originalRow = page.locator('.edit-row', { hasText: 'Primary edit against a stale anchor' });
      await expect(originalRow).toBeVisible({ timeout: 15_000 });
      await expect(originalRow.locator('.status-badge')).toHaveText('superseded', { timeout: 10_000 });
      // Not applied, and not silently dropped either — the document is unchanged from the mutation.
      await expect(page.locator('.editor-host')).not.toContainText(`${MARKERS.conflict} EDITED`);
      await waitIdle(page);

      // The agent's replacement — targeting the now-current text — arrives as an ordinary pending
      // proposal for user review, even though this conversation is Primary (FR-027's second half).
      await composer.fill(
        proposeEdit('Replacement for the stale anchor', [
          { old_string: mutatedConflictMarker, new_string: `${mutatedConflictMarker} REPLACED` },
        ]),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const replacementRow = page.locator('.edit-row', { hasText: 'Replacement for the stale anchor' });
      await expect(replacementRow).toBeVisible({ timeout: 15_000 });
      await expect(replacementRow.locator('.status-badge')).toHaveText('pending', { timeout: 10_000 });
      await expect(replacementRow.getByRole('button', { name: 'Accept' })).toBeVisible();
      await expect(replacementRow.locator('.chain-indicator')).toBeVisible();
      await expect(page.locator('.editor-host')).not.toContainText(`${mutatedConflictMarker} REPLACED`);

      await replacementRow.getByRole('button', { name: 'Drop' }).click();
      await expect(replacementRow.locator('.status-badge')).toHaveText('dropped', { timeout: 10_000 });
      await waitIdle(page);
    });
  });

  test('7. a deferred "switch when idle" is silently cancelled if the target errors first (FR-029a)', async ({
    page,
  }) => {
    await ensureFixtureDocument(page);

    const primaryBefore = (await getConversations(page.request)).find((c) => c.isPrimary);
    expect(primaryBefore).toBeTruthy();
    const primaryId = primaryBefore!.id;

    // A fresh, idle branch to designate — and then to error out before the deferred switch fires.
    const branchResponse = await page.request.post('/api/conversations', {
      data: { parentConversationId: primaryId, name: 'US5 Deferred Target' },
    });
    expect(branchResponse.ok()).toBe(true);
    const targetConversation = (await branchResponse.json()) as { id: string };
    await expect
      .poll(async () => (await findConversation(page.request, 'US5 Deferred Target')).status, { timeout: 10_000 })
      .not.toBe('working');

    // Make the current Primary busy for long enough to run the rest of this step.
    const sendResponse = await page.request.post(`/api/conversations/${primaryId}/send`, {
      data: { message: 'x'.repeat(2000) },
    });
    expect(sendResponse.ok()).toBe(true);
    await expect
      .poll(async () => (await getConversations(page.request)).find((c) => c.id === primaryId)?.status, {
        timeout: 5_000,
      })
      .toBe('working');

    // First attempt with no `whenBusy` choice is rejected with PRIMARY_TARGET_BUSY.
    const busyResponse = await page.request.post(`/api/conversations/${targetConversation.id}/primary`, { data: {} });
    expect(busyResponse.status()).toBe(409);
    const busyBody = (await busyResponse.json()) as { error: { code: string } };
    expect(busyBody.error.code).toBe('PRIMARY_TARGET_BUSY');

    // "Switch when idle" schedules the deferred switch.
    const deferResponse = await page.request.post(`/api/conversations/${targetConversation.id}/primary`, {
      data: { whenBusy: 'switch_when_idle' },
    });
    expect(deferResponse.ok()).toBe(true);
    const deferBody = (await deferResponse.json()) as { applied: string };
    expect(deferBody.applied).toBe('deferred_until_idle');

    // The target errors out before the busy Primary settles.
    const errorResponse = await page.request.post(`/api/conversations/${targetConversation.id}/send`, {
      data: { message: ERROR_DIRECTIVE },
    });
    expect(errorResponse.ok()).toBe(true);
    await expect
      .poll(async () => (await findConversation(page.request, 'US5 Deferred Target')).status, { timeout: 10_000 })
      .toBe('errored');

    // Once the busy Primary settles, the deferred switch is cancelled without effect: Primary is
    // unchanged, and the errored target never became Primary.
    await expect
      .poll(async () => (await getConversations(page.request)).find((c) => c.id === primaryId)?.status, {
        timeout: 15_000,
      })
      .toBe('idle');

    const finalTarget = await findConversation(page.request, 'US5 Deferred Target');
    expect(finalTarget.isPrimary).toBe(false);
    const finalPrimary = (await getConversations(page.request)).find((c) => c.isPrimary);
    expect(finalPrimary?.id).toBe(primaryId);

    await test.step('8. designating the now-errored conversation Primary is rejected (FR-038a)', async () => {
      const response = await page.request.post(`/api/conversations/${targetConversation.id}/primary`, { data: {} });
      expect(response.status()).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CONVERSATION_ERRORED');

      // Primary is still unaffected.
      const primary = (await getConversations(page.request)).find((c) => c.isPrimary);
      expect(primary?.id).toBe(primaryId);
    });
  });
});
