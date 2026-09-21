import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { closeAllFocusedPanels, focusExclusively, getActiveDocumentId } from './test-utils.js';

// Spec: specs/006-archivable-main-conversation (User Story 2, quickstart.md Scenario 2) —
// "A branch survives its parent Main's archival". Mirrors us7.spec.ts's setup/assertion
// conventions (ensureFixtureDocument, branchFromMarker, selectConversation, waitIdle) closely,
// since US7 already covers the equivalent scenario for an ordinary (non-Main) parent — this spec
// is the Main-specific case: archiving Main is the new operation US1 (Phase 3) introduced
// (`ConversationView.vue`'s `archiveOrReviewAction` no longer excludes `kind: 'main'`).
const BRANCH_SHORTCUT = 'Alt+Shift+C';

const MARKERS = {
  target: 'US9-MARKER: This sentence anchors the branch-survives-archival target.',
};

const MARKER_BLOCK = ['', '', '## US9 Target', '', MARKERS.target, ''].join('\n');

async function getDocumentState(
  page: Page,
  documentId: string,
): Promise<{ currentRevision: number; content: string }> {
  const response = await page.request.get(`/api/documents/${documentId}`);
  const body = (await response.json()) as {
    document: { currentRevision: number };
    content: string;
  };
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

async function getConversations(
  request: APIRequestContext,
  documentId: string,
): Promise<ConversationSummary[]> {
  const response = await request.get(`/api/documents/${documentId}/conversations`);
  const body = (await response.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

async function findConversation(
  request: APIRequestContext,
  documentId: string,
  name: string,
): Promise<ConversationSummary> {
  const conversation = (await getConversations(request, documentId)).find((c) => c.name === name);
  if (!conversation) throw new Error(`Conversation not found: ${name}`);
  return conversation;
}

/** Ensures a document exists containing MARKER_BLOCK, regardless of whether this spec runs in
 * isolation (paste screen appears) or after us1-us8 in the same `npm run test:e2e` process
 * (document already exists) — mirrors us7.spec.ts's `ensureFixtureDocument` (incl. its
 * stale-`.toolbar h1`-selector fix — see us3.spec.ts). Also fix: daf1db6 (multi-document support)
 * renested the singleton GET/PATCH /api/document under /api/documents/:documentId — this now
 * resolves and returns that id (mirroring the frontend document store's own `isActive`
 * convention) so callers can thread it through every other document/conversation call below. */
async function ensureFixtureDocument(page: Page): Promise<string> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US9 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.preview-pane')).toBeVisible();
    return getActiveDocumentId(page.request);
  }

  const documentId = await getActiveDocumentId(page.request);
  const before = await getDocumentState(page, documentId);
  if (before.content.includes(MARKERS.target)) return documentId; // a previous US9 run already appended it

  const from = before.content.length;
  await page.request.patch(`/api/documents/${documentId}`, {
    data: {
      baseRevision: before.currentRevision,
      changes: [{ from, to: from, insert: MARKER_BLOCK }],
    },
  });

  await expect
    .poll(async () => (await getDocumentState(page, documentId)).currentRevision, {
      timeout: 10_000,
      intervals: [300],
    })
    .toBeGreaterThan(before.currentRevision);

  await page.reload();
  await expect(page.locator('.preview-pane')).toBeVisible();
  return documentId;
}

async function waitIdle(page: Page): Promise<void> {
  await expect(
    page.locator('.conversation-view .conversation-header .badge').first(),
  ).toHaveAttribute('data-status', /idle|closed/, { timeout: 20_000 });
}

/** Selects `name`'s row in the HUD, regardless of which conversation(s) are currently open —
 *  mirrors us7.spec.ts's `selectConversation`. */
async function selectConversation(page: Page, name: string): Promise<void> {
  await focusExclusively(
    page,
    page.locator('.hud-panel .conversation-row', { hasText: name }),
    name,
  );
}

/** Branches from Main off the line containing `markerText`, selected via the keyboard (FR-043a),
 *  and returns once the new branch (named `expectedName`, per seed-excerpt.ts's `deriveBranchName`)
 *  is open. Mirrors us7.spec.ts's `branchFromMarker`. */
async function branchFromMarker(
  page: Page,
  markerText: string,
  expectedName: string,
): Promise<void> {
  await page.locator('.editor-host').click();
  await page.keyboard.press('Control+End');
  const line = page.locator('.cm-line', { hasText: markerText });
  await line.scrollIntoViewIfNeeded();
  await line.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press(BRANCH_SHORTCUT);

  await expect(page.locator('.conversation-header h2')).toHaveText(expectedName, {
    timeout: 10_000,
  });
  await waitIdle(page);
}

test.describe("US9 — Branches survive their parent Main's archival", () => {
  test('a branch keeps its "Branched from Main" link and stays usable after Main is archived', async ({
    page,
  }) => {
    const branchName = 'US9 Target';
    let documentId = '';

    await test.step('fixture document exists with known marker content', async () => {
      documentId = await ensureFixtureDocument(page);
    });

    await test.step('branch off Main', async () => {
      await branchFromMarker(page, 'US9-MARKER', branchName);
    });

    const branch = await findConversation(page.request, documentId, branchName);
    // Captured before archiving, while exactly one "Main"-named conversation exists — archiving
    // creates a second one (the fresh replacement, also named "Main"), so every lookup below must
    // resolve this specific (soon-to-be-archived) conversation by id, never by name again.
    const mainBeforeArchive = await findConversation(page.request, documentId, 'Main');

    await test.step('the branch\'s box on the canvas shows its "Branched from Main" lineage link before archival', async () => {
      const box = page.locator(`.conversation-thread-box[data-conversation-id="${branch.id}"]`);
      await expect(box.locator('.branch-lineage')).toHaveText('↳ Branched from Main');
    });

    await test.step('archive Main (the "Archive" action, now available for kind: main per US1)', async () => {
      await selectConversation(page, 'Main');
      await page.getByRole('button', { name: 'Archive', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Close conversation' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close conversation' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute(
        'data-status',
        'closed',
        {
          timeout: 10_000,
        },
      );
    });

    await test.step('the now-archived Main shows the existing closed-conversation visual treatment (no dedicated "Archived Main" badge until Phase 5/US3)', async () => {
      const conversations = await getConversations(page.request, documentId);
      const archivedMain = conversations.find((c) => c.id === mainBeforeArchive.id)!;
      expect(archivedMain.status).toBe('closed');
      const mainBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${archivedMain.id}"]`,
      );
      await expect(mainBox.locator('.badge').first()).toHaveAttribute('data-status', 'closed');
    });

    await test.step('the branch\'s "Branched from Main" link still renders, and the branch is still usable, after Main\'s archival (US2)', async () => {
      const box = page.locator(`.conversation-thread-box[data-conversation-id="${branch.id}"]`);
      await expect(box.locator('.branch-lineage')).toHaveText('↳ Branched from Main');

      await selectConversation(page, branchName);
      await expect(page.locator('.readonly-banner')).toHaveCount(0);
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.fill('Are you still usable after Main archived?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await waitIdle(page);
      await expect(page.locator('.message-list')).toContainText('fake deterministic answer');
    });
  });
});

/**
 * specs/006-archivable-main-conversation, T028 (US3): archiving Main twice in succession produces
 * two archived Mains plus one current Main, each individually distinguishable, and each Main's own
 * auto-applied edit stays attributed to that specific (now-archived) conversation in revision
 * history (FR-010/FR-011, quickstart.md Scenario 3). Self-contained — creates/extends its own
 * fixture content and reuses this file's own `ensureFixtureDocument`/`getDocumentState`/`waitIdle`
 * helpers above, but does not depend on the branch-survival test above having run first: it reads
 * whichever conversation is *currently* the document's Main (`isCurrentMain`) rather than assuming
 * this is the very first Main ever created for the document (which — per FR-007 — is the only one
 * automatically Primary; any later replacement Main starts out deliberately NOT Primary, so this
 * test re-designates Primary itself before each round rather than assuming it).
 */
const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';
function proposeEdit(
  summary: string,
  operations: { old_string: string; new_string: string }[],
): string {
  return `${PROPOSE_EDIT_DIRECTIVE}${JSON.stringify({ summary, operations })}`;
}

const ROUND_MARKERS = {
  roundOne:
    'US9-MARKER-ROUND-ONE: This sentence is auto-edited by the first (to-be-archived) Main.',
  roundTwo:
    'US9-MARKER-ROUND-TWO: This sentence is auto-edited by the second (to-be-archived) Main.',
};
const ROUND_MARKER_BLOCK = [
  '',
  '',
  '## US9 Rounds',
  '',
  ROUND_MARKERS.roundOne,
  '',
  ROUND_MARKERS.roundTwo,
  '',
].join('\n');

/** Appends `ROUND_MARKER_BLOCK` on top of whatever `ensureFixtureDocument` already put there —
 *  separate from it (rather than folded into the same marker block) so this describe block's own
 *  fixture needs stay independent of the branch-survival test's above, and idempotent across reruns
 *  in the same shared document (mirrors `ensureFixtureDocument`'s own re-run guard). */
async function ensureRoundMarkers(page: Page, documentId: string): Promise<void> {
  const before = await getDocumentState(page, documentId);
  if (before.content.includes(ROUND_MARKERS.roundOne)) return;
  const from = before.content.length;
  await page.request.patch(`/api/documents/${documentId}`, {
    data: {
      baseRevision: before.currentRevision,
      changes: [{ from, to: from, insert: ROUND_MARKER_BLOCK }],
    },
  });
  await expect
    .poll(async () => (await getDocumentState(page, documentId)).currentRevision, {
      timeout: 10_000,
      intervals: [300],
    })
    .toBeGreaterThan(before.currentRevision);
  await page.reload();
  await expect(page.locator('.preview-pane')).toBeVisible();
}

type ConversationWithCurrent = ConversationSummary & { isCurrentMain: boolean };

async function getConversationsWithCurrent(
  request: APIRequestContext,
  documentId: string,
): Promise<ConversationWithCurrent[]> {
  const response = await request.get(`/api/documents/${documentId}/conversations`);
  const body = (await response.json()) as { conversations: ConversationWithCurrent[] };
  return body.conversations;
}

async function findWhere(
  request: APIRequestContext,
  documentId: string,
  predicate: (c: ConversationWithCurrent) => boolean,
): Promise<ConversationWithCurrent> {
  const conversation = (await getConversationsWithCurrent(request, documentId)).find(predicate);
  if (!conversation) throw new Error('Conversation not found matching predicate');
  return conversation;
}

type RevisionSummary = {
  revision: number;
  conversationId: string | null;
  conversationName: string | null;
};
async function getRevisions(
  request: APIRequestContext,
  documentId: string,
): Promise<RevisionSummary[]> {
  const response = await request.get(`/api/documents/${documentId}/revisions`);
  const body = (await response.json()) as { revisions: RevisionSummary[] };
  return body.revisions;
}

function rowFor(page: Page, conversationId: string) {
  return page.locator(`.hud-panel .conversation-row[data-conversation-id="${conversationId}"]`);
}

/** The sidebar/canvas box's own Make/Clear Primary button for `conversationId` (006-toolbar-reorg
 *  second refactor: the HUD list is now purely informational — no buttons of any kind render there
 *  any more). `ConversationThreadBox.vue`'s root element already carries the same
 *  `data-conversation-id` `rowFor` above matches on, so this scopes directly to it rather than via
 *  `:has()` the way the removed HUD-row version needed to. */
function primaryButtonFor(page: Page, conversationId: string) {
  return page.locator(
    `.conversation-thread-box[data-conversation-id="${conversationId}"] [data-action="primary"]`,
  );
}

async function sendToOpenMain(page: Page, text: string): Promise<void> {
  const composer = page.getByLabel('Message Main');
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Archives (closes) whichever conversation's detail panel is currently open, via the same
 * Archive -> confirm flow as us7.spec.ts's close tests — now available for `kind: 'main'` too
 * (specs/006-archivable-main-conversation US1, T023). */
async function archiveOpenConversation(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Close conversation' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close conversation' }).click();
  await expect(dialog).toHaveCount(0);
  await waitIdle(page);
}

/** A freshly-created replacement Main (`archiveMain`'s new row) fires a fire-and-forget seed
 *  message of its own (same as any brand-new Main — `ConversationService.seedMain`), so it can
 *  briefly be `status: 'working'` right after archiving completes. Designating a *busy* conversation
 *  Primary trips `PRIMARY_TARGET_BUSY` (the same three-choice warning us5.spec.ts exercises
 *  deliberately) — here it's incidental, not what this test is about, so wait it out first. */
async function waitConversationIdle(
  request: APIRequestContext,
  documentId: string,
  conversationId: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await findWhere(request, documentId, (c) => c.id === conversationId)).status,
      {
        timeout: 15_000,
      },
    )
    .not.toBe('working');
}

/** Makes whichever conversation's row is at `conversationId` Primary, if it isn't already — clicks
 *  that row's own Make Primary button directly (006-toolbar-reorg: per-row, not a single global
 *  button targeting whichever conversation is currently selected/focused). Waits out any in-flight
 *  seed turn first (see `waitConversationIdle` above) so no busy dialog is expected here. */
async function ensurePrimary(
  page: Page,
  documentId: string,
  conversationId: string,
): Promise<void> {
  const current = await findWhere(page.request, documentId, (c) => c.id === conversationId);
  if (current.isPrimary) return;
  await waitConversationIdle(page.request, documentId, conversationId);
  await primaryButtonFor(page, conversationId).click();
  await expect
    .poll(
      async () =>
        (await findWhere(page.request, documentId, (c) => c.id === conversationId)).isPrimary,
    )
    .toBe(true);
}

test.describe('US9 — Archived Main: attribution and distinguishability across repeated archiving (US3)', () => {
  test('archiving Main twice produces three individually-distinguishable Mains, and each auto-applied edit stays attributed to the specific (archived) Main that produced it', async ({
    page,
  }) => {
    let documentId = '';
    await test.step("fixture document exists (may already, from the branch-survival test above), with this test's own round-specific marker content appended", async () => {
      documentId = await ensureFixtureDocument(page);
      await ensureRoundMarkers(page, documentId);
    });

    let mainId1 = '';
    let revisionOne = 0;

    await test.step("Round 1: designate the current Main Primary if it isn't already, then a proposed edit auto-applies immediately", async () => {
      const main = await findWhere(
        page.request,
        documentId,
        (c) => c.kind === 'main' && c.isCurrentMain,
      );
      mainId1 = main.id;

      // Fix: `ensurePrimary` clicks the canvas box's own `[data-action="primary"]` button, which
      // sits behind `.conversation-detail-overlay` while any conversation's detail view is open —
      // designate Primary first, while nothing is focused yet and the canvas is unoccluded, then
      // open Main's detail view afterward for `sendToOpenMain`'s composer.
      await ensurePrimary(page, documentId, mainId1);
      await focusExclusively(page, rowFor(page, mainId1), 'Main');

      const before = await getDocumentState(page, documentId);
      await sendToOpenMain(
        page,
        proposeEdit('US9 round 1 auto-apply', [
          { old_string: ROUND_MARKERS.roundOne, new_string: 'US9 EDITED ROUND ONE.' },
        ]),
      );
      await waitIdle(page);
      await expect
        .poll(async () => (await getDocumentState(page, documentId)).currentRevision, {
          timeout: 10_000,
        })
        .toBeGreaterThan(before.currentRevision);
      revisionOne = (await getDocumentState(page, documentId)).currentRevision;

      // Attributed to Main (still current at this point) before any archiving happens.
      const revisions = await getRevisions(page.request, documentId);
      expect(revisions.find((r) => r.revision === revisionOne)?.conversationId).toBe(mainId1);
    });

    await test.step('Archive Main the first time (US1 archive-and-replace)', async () => {
      await archiveOpenConversation(page);
      await expect(rowFor(page, mainId1)).toHaveCount(1); // stays in the list, just no longer current.
    });

    let mainId2 = '';
    let revisionTwo = 0;

    await test.step('Round 2: the replacement Main is NOT Primary (FR-007 — no auto-transfer), so it must be explicitly re-designated Primary before a second edit can auto-apply', async () => {
      const main2 = await findWhere(
        page.request,
        documentId,
        (c) => c.kind === 'main' && c.isCurrentMain,
      );
      mainId2 = main2.id;
      expect(mainId2).not.toBe(mainId1);
      expect(main2.isPrimary).toBe(false);

      // See Round 1's fix note above: designate Primary before opening any detail view — and
      // first close whatever's still open (the just-archived mainId1's own panel, left open by
      // `archiveOpenConversation`, which only dismisses the confirmation alertdialog, not the
      // detail view itself) so it doesn't occlude mainId2's canvas button either.
      await closeAllFocusedPanels(page);
      await ensurePrimary(page, documentId, mainId2);
      await focusExclusively(page, rowFor(page, mainId2), 'Main');

      const before = await getDocumentState(page, documentId);
      await sendToOpenMain(
        page,
        proposeEdit('US9 round 2 auto-apply', [
          { old_string: ROUND_MARKERS.roundTwo, new_string: 'US9 EDITED ROUND TWO.' },
        ]),
      );
      await waitIdle(page);
      await expect
        .poll(async () => (await getDocumentState(page, documentId)).currentRevision, {
          timeout: 10_000,
        })
        .toBeGreaterThan(before.currentRevision);
      revisionTwo = (await getDocumentState(page, documentId)).currentRevision;

      const revisions = await getRevisions(page.request, documentId);
      expect(revisions.find((r) => r.revision === revisionTwo)?.conversationId).toBe(mainId2);
    });

    await test.step('Archive Main the second time, producing two archived Mains plus one new current Main', async () => {
      await archiveOpenConversation(page);
    });

    let mainId3 = '';
    await test.step('Three distinct Main conversations now exist: two archived, one current (SC-004 setup)', async () => {
      const mains = (await getConversationsWithCurrent(page.request, documentId)).filter(
        (c) => c.kind === 'main',
      );
      const main3 = mains.find((c) => c.id !== mainId1 && c.id !== mainId2 && c.isCurrentMain);
      expect(main3).toBeTruthy();
      mainId3 = main3!.id;
      expect(new Set([mainId1, mainId2, mainId3]).size).toBe(3); // all distinct ids.

      for (const id of [mainId1, mainId2]) {
        const archived = mains.find((c) => c.id === id)!;
        expect(archived.status).toBe('closed');
        expect(archived.isCurrentMain).toBe(false);
      }
      expect(main3!.status).not.toBe('closed');
    });

    await test.step('The conversation list (HUD) shows all three Mains, each individually inspectable by id and by closed-vs-current visual state (FR-010, SC-004) — PROVISIONAL: this only checks id/status distinguishability; once T029 lands, this should additionally assert an "Archived Main" badge on mainId1/mainId2\'s rows and its absence on mainId3\'s (see conversationStatusBadges.spec.ts T027)', async () => {
      for (const id of [mainId1, mainId2, mainId3]) {
        await expect(rowFor(page, id)).toBeVisible();
      }
      // Both archived Mains show the closed status badge; the current Main does not.
      await expect(rowFor(page, mainId1).locator('[data-status]')).toHaveAttribute(
        'data-status',
        'closed',
      );
      await expect(rowFor(page, mainId2).locator('[data-status]')).toHaveAttribute(
        'data-status',
        'closed',
      );
      await expect(rowFor(page, mainId3).locator('[data-status]')).not.toHaveAttribute(
        'data-status',
        'closed',
      );
    });

    await test.step('The History panel still attributes each auto-applied edit to the correct specific (now-archived) Main conversation (FR-011, SC-003)', async () => {
      // API-level check first: this is the only place the two archived Mains' distinct
      // `conversationId`s are actually verifiable — both are named "Main" (T029's badge doesn't
      // exist yet, and even once it does, the *name* stays "Main" for all three), so a UI-only
      // check of the rendered text couldn't tell them apart by itself.
      const revisions = await getRevisions(page.request, documentId);
      const revOne = revisions.find((r) => r.revision === revisionOne);
      const revTwo = revisions.find((r) => r.revision === revisionTwo);
      expect(revOne?.conversationId).toBe(mainId1);
      expect(revOne?.conversationName).toBe('Main');
      expect(revTwo?.conversationId).toBe(mainId2);
      expect(revTwo?.conversationName).toBe('Main');

      // UI-level check: the History panel renders a (non-blank) conversation-name label for both
      // revisions, i.e. attribution isn't silently dropped once the producing Main is archived.
      await page.getByRole('button', { name: 'History', exact: true }).click();
      const panel = page.locator('.history-panel');
      await expect(panel).toBeVisible();
      const entryOne = panel.locator('.history-entry', {
        has: page.locator('strong', { hasText: `v${revisionOne}` }),
      });
      const entryTwo = panel.locator('.history-entry', {
        has: page.locator('strong', { hasText: `v${revisionTwo}` }),
      });
      await expect(entryOne.locator('.conversation-name')).toHaveText('Main');
      await expect(entryTwo.locator('.conversation-name')).toHaveText('Main');
    });
  });
});
