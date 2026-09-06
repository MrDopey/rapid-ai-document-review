import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// Spec: specs/005-canvas-conversation-threads (User Story 1, FR-001-FR-004, SC-001),
// quickstart.md Scenario 1. Mirrors us7.spec.ts's API-first setup/assertion conventions.
const BRANCH_SHORTCUT = 'Alt+Shift+C';

const MARKERS = {
  first: 'US8-MARKER-FIRST: This sentence anchors the first highlighted conversation.',
  second:
    'US8-MARKER-SECOND: This sentence anchors the second highlighted conversation, further down the document.',
};

// A filler paragraph, repeated, puts real vertical distance between the two markers — colocation
// asserts *vertical order*, which needs the two anchors to be genuinely far apart on screen rather
// than a coincidence of line height.
const FILLER =
  'Lorem ipsum filler paragraph so the two markers below land far enough apart vertically to make document-order colocation a meaningful check.';

// US2 (Phase 4) note: `ConversationThreadBox`'s sibling-collision stacking (FR-007/FR-012) pushes a
// column-0 box down whenever it would otherwise overlap an earlier one in the same column — and
// Main's own box always renders its full seed message (the whole document content,
// `buildMainSeedMessage`) unclamped until Phase 5/US3 adds the per-message max-height cap, capped
// only by `ConversationThreadBox.vue`'s current stopgap `.thread-messages { max-height: 320px }`.
// So the first highlighted marker needs enough lead-in filler to land comfortably below that ~320px
// (plus header/footer) before Phase 5 lands, or Main's box legitimately (and correctly) pushes it
// down past a "close to its raw anchor" tolerance — this is the new, correct FR-007 behavior, not a
// bug, so the fixture accommodates it rather than the assertion being loosened to hide it.
const LEAD_IN_FILLER_COUNT = 4;

const MARKER_BLOCK = [
  '',
  '',
  ...Array(LEAD_IN_FILLER_COUNT)
    .fill(FILLER)
    .flatMap((p) => [p, '']),
  '## US8 First Target',
  '',
  MARKERS.first,
  '',
  ...Array(10)
    .fill(FILLER)
    .flatMap((p) => [p, '']),
  '## US8 Second Target',
  '',
  MARKERS.second,
  '',
].join('\n');

async function getDocumentState(page: Page): Promise<{ currentRevision: number; content: string }> {
  const response = await page.request.get('/api/document');
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
  branchDepth: number;
};

async function getConversations(request: APIRequestContext): Promise<ConversationSummary[]> {
  const response = await request.get('/api/conversations');
  const body = (await response.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

async function findConversation(
  request: APIRequestContext,
  name: string,
): Promise<ConversationSummary> {
  const conversation = (await getConversations(request)).find((c) => c.name === name);
  if (!conversation) throw new Error(`Conversation not found: ${name}`);
  return conversation;
}

type MessageSummary = { id: string; role: 'user' | 'assistant'; text: string };

async function getConversationMessages(
  request: APIRequestContext,
  conversationId: string,
): Promise<MessageSummary[]> {
  const response = await request.get(`/api/conversations/${conversationId}`);
  const body = (await response.json()) as { messages: MessageSummary[] };
  return body.messages;
}

/** Mirrors us7.spec.ts's ensureFixtureDocument — works whether this spec runs in isolation (paste
 *  screen appears) or after earlier usN specs in the same `npm run test:e2e` process (document
 *  already exists). */
async function ensureFixtureDocument(page: Page): Promise<void> {
  await page.goto('/');
  const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });
  if (await pasteHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Document content').fill(`# US8 Fixture Document${MARKER_BLOCK}\n`);
    await page.getByRole('button', { name: 'Start reviewing' }).click();
    await expect(page.locator('.toolbar h1')).toBeVisible();
    return;
  }

  const before = await getDocumentState(page);
  if (before.content.includes(MARKERS.first)) return; // a previous US8 run already appended it

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
  await expect(page.locator('.toolbar h1')).toBeVisible();
}

/** Selects the line containing `markerText` via keyboard-only navigation (mirrors
 *  us7.spec.ts/us6.spec.ts's branchFromMarker) and starts a conversation from it. CodeMirror
 *  virtualizes long documents, so `Control+End` + `scrollIntoViewIfNeeded` are needed to actually
 *  render a marker line that isn't near the top. */
async function branchFromMarker(page: Page, markerText: string): Promise<void> {
  await page.locator('.editor-host').click();
  await page.keyboard.press('Control+End');
  const line = page.locator('.cm-line', { hasText: markerText });
  await line.scrollIntoViewIfNeeded();
  await line.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press(BRANCH_SHORTCUT);

  // US4/T031: branching from a selection auto-opens the new conversation's full detail view
  // (matches this app's pre-canvas behavior, which us4.spec.ts/us7.spec.ts depend on) — that
  // overlay covers the whole canvas while open, so anything this test does next on the canvas
  // itself (clicking another box's button, focusing the editor for another branch) needs it
  // closed first, exactly as a real user would dismiss it before continuing.
  await expect(page.locator('.conversation-detail-overlay')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.conversation-detail-overlay')).toHaveCount(0);
}

test.describe('US8 — Spatial canvas colocation', () => {
  test('document floats on a canvas and highlight-anchored conversations colocate at their anchor height, in document order (FR-001-FR-004, SC-001)', async ({
    page,
  }) => {
    await test.step('fixture document exists with two markers at different heights', async () => {
      await ensureFixtureDocument(page);
    });

    await test.step('the document renders inside a pannable canvas with no competing inner scrollbar', async () => {
      const canvas = page.locator('.document-canvas');
      await expect(canvas).toBeVisible();
      await expect(canvas).toHaveCSS('overflow-y', 'auto');
      // research.md §2/FR-015: the editor's own scroller must not have its own overflow, or wheel
      // events would scroll the page before ever reaching the canvas.
      await expect(page.locator('.cm-scroller')).not.toHaveCSS('overflow-y', 'auto');
    });

    await test.step('Main renders in column 0, anchored to the top of the document', async () => {
      const main = await findConversation(page.request, 'Main');
      await expect(
        page.locator(`.conversation-thread-box[data-conversation-id="${main.id}"]`),
      ).toBeVisible();
    });

    let firstBranchId = '';
    let firstBoxTop = 0;

    await test.step('highlighting a passage and starting a conversation colocates its box at approximately the highlight height, above the Main box is preserved and it lands in column 0', async () => {
      const before = await getConversations(page.request);

      await branchFromMarker(page, 'US8-MARKER-FIRST');

      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);

      const after = await getConversations(page.request);
      const branch = after.find((c) => !before.some((b) => b.id === c.id));
      expect(branch).toBeTruthy();
      expect(branch!.branchDepth).toBe(1); // a direct branch of Main
      firstBranchId = branch!.id;

      const box = page.locator(`.conversation-thread-box[data-conversation-id="${firstBranchId}"]`);
      await expect(box).toBeVisible({ timeout: 10_000 });

      const markerLine = page.locator('.cm-line', { hasText: 'US8-MARKER-FIRST' });
      const [lineBox, threadBox] = await Promise.all([markerLine.boundingBox(), box.boundingBox()]);
      expect(lineBox).toBeTruthy();
      expect(threadBox).toBeTruthy();
      // "Approximately" the same height — a generous tolerance, since the box's own header sits
      // above its message content, so its top edge is expected to be somewhat above the
      // highlighted line rather than pixel-identical to it.
      expect(Math.abs(lineBox!.y - threadBox!.y)).toBeLessThan(250);
      firstBoxTop = threadBox!.y;

      const main = await findConversation(page.request, 'Main');
      const mainBoxBox = await page
        .locator(`.conversation-thread-box[data-conversation-id="${main.id}"]`)
        .boundingBox();
      expect(mainBoxBox).toBeTruthy();
      expect(mainBoxBox!.y).toBeLessThan(firstBoxTop);
    });

    await test.step('a second, lower highlight produces a box further down than the first, preserving document order (SC-001)', async () => {
      const before = await getConversations(page.request);

      await branchFromMarker(page, 'US8-MARKER-SECOND');

      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);

      const after = await getConversations(page.request);
      const secondBranch = after.find((c) => !before.some((b) => b.id === c.id));
      expect(secondBranch).toBeTruthy();

      const box = page.locator(
        `.conversation-thread-box[data-conversation-id="${secondBranch!.id}"]`,
      );
      await expect(box).toBeVisible({ timeout: 10_000 });
      const boxBox = await box.boundingBox();
      expect(boxBox).toBeTruthy();
      expect(boxBox!.y).toBeGreaterThan(firstBoxTop);
    });
  });

  test('branches render one column further out per depth, siblings stack without overlapping, and messages stay isolated (US2, FR-006/FR-007)', async ({
    page,
  }) => {
    await test.step('fixture document exists', async () => {
      await ensureFixtureDocument(page);
    });

    let parentId = '';
    await test.step('a highlight-anchored branch of Main is a direct branch (branchDepth 1, column 0)', async () => {
      const before = await getConversations(page.request);
      await branchFromMarker(page, 'US8-MARKER-FIRST');
      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);
      const after = await getConversations(page.request);
      const branch = after.find((c) => !before.some((b) => b.id === c.id));
      expect(branch).toBeTruthy();
      expect(branch!.branchDepth).toBe(1);
      parentId = branch!.id;
      await expect(
        page.locator(`.conversation-thread-box[data-conversation-id="${parentId}"]`),
      ).toBeVisible({
        timeout: 10_000,
      });
    });

    let firstChildId = '';
    let firstChildBox: { x: number; y: number; width: number; height: number };
    await test.step('branching that conversation (no message-level anchor exists — see conversation-service.ts; "branch off a specific message" is branching the conversation itself) renders one column further out', async () => {
      const parentBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${parentId}"]`,
      );
      const parentBoundingBox = await parentBox.boundingBox();
      expect(parentBoundingBox).toBeTruthy();

      const before = await getConversations(page.request);
      await parentBox.getByRole('button', { name: 'Branch this conversation' }).click();
      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);
      const after = await getConversations(page.request);
      const child = after.find((c) => !before.some((b) => b.id === c.id));
      expect(child).toBeTruthy();
      expect(child!.branchDepth).toBe(2);
      expect(child!.parentId).toBe(parentId);
      firstChildId = child!.id;

      const childBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${firstChildId}"]`,
      );
      await expect(childBox).toBeVisible({ timeout: 10_000 });
      const bb = await childBox.boundingBox();
      expect(bb).toBeTruthy();
      firstChildBox = bb!;
      // column = max(0, branchDepth - 1): the parent (branchDepth 1) is column 0, this child
      // (branchDepth 2) is column 1 — one column further from the document than its parent.
      expect(firstChildBox.x).toBeGreaterThan(
        parentBoundingBox!.x + parentBoundingBox!.width * 0.5,
      );
    });

    await test.step('branching the same parent again produces a sibling that stacks below the first, in the same column, without overlapping (FR-007)', async () => {
      const parentBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${parentId}"]`,
      );
      const before = await getConversations(page.request);
      await parentBox.getByRole('button', { name: 'Branch this conversation' }).click();
      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);
      const after = await getConversations(page.request);
      const sibling = after.find((c) => !before.some((b) => b.id === c.id));
      expect(sibling).toBeTruthy();
      expect(sibling!.branchDepth).toBe(2);
      expect(sibling!.parentId).toBe(parentId);

      const siblingBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${sibling!.id}"]`,
      );
      await expect(siblingBox).toBeVisible({ timeout: 10_000 });
      const bb = await siblingBox.boundingBox();
      expect(bb).toBeTruthy();
      // Same column as the first child...
      expect(Math.abs(bb!.x - firstChildBox.x)).toBeLessThan(5);
      // ...but stacked below it with a visible gap, not overlapping.
      expect(bb!.y).toBeGreaterThanOrEqual(firstChildBox.y + firstChildBox.height);
    });

    await test.step('branching a branch itself lands two columns out from the document (branchDepth 3, column 2)', async () => {
      const childBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${firstChildId}"]`,
      );
      const before = await getConversations(page.request);
      await childBox.getByRole('button', { name: 'Branch this conversation' }).click();
      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);
      const after = await getConversations(page.request);
      const grandchild = after.find((c) => !before.some((b) => b.id === c.id));
      expect(grandchild).toBeTruthy();
      expect(grandchild!.branchDepth).toBe(3);
      expect(grandchild!.parentId).toBe(firstChildId);

      const grandchildBoxEl = page.locator(
        `.conversation-thread-box[data-conversation-id="${grandchild!.id}"]`,
      );
      await expect(grandchildBoxEl).toBeVisible({ timeout: 10_000 });
      const bb = await grandchildBoxEl.boundingBox();
      expect(bb).toBeTruthy();
      expect(bb!.x).toBeGreaterThan(firstChildBox.x + firstChildBox.width * 0.5);
    });

    await test.step('messages sent into the parent and its branch stay isolated to their own conversation', async () => {
      async function sendMessageVia(conversationId: string, text: string): Promise<void> {
        const box = page.locator(
          `.conversation-thread-box[data-conversation-id="${conversationId}"]`,
        );
        await box.getByRole('button', { name: 'Focus' }).click();
        // US4/T031: the per-box detail overlay was consolidated into a single, app-level dialog
        // (`.conversation-detail-dialog` in App.vue) so opening one conversation doesn't block
        // clicking a different HUD row — see App.vue's `selectedConversationId`.
        const dialog = page.locator('.conversation-detail-dialog');
        await dialog.locator('textarea').fill(text);
        await dialog.getByRole('button', { name: /^Send$/ }).click();
        await expect(dialog.locator('.message-bubble', { hasText: text })).toBeVisible({
          timeout: 10_000,
        });
        await dialog.getByRole('button', { name: 'Close full view' }).click();
      }

      const parentOnlyText = 'US8-ISOLATION-PARENT-ONLY message';
      const childOnlyText = 'US8-ISOLATION-CHILD-ONLY message';
      await sendMessageVia(parentId, parentOnlyText);
      await sendMessageVia(firstChildId, childOnlyText);

      // `.message-bubble[data-role="user"]` (not just `.message-bubble`) — the assistant's
      // deterministic `FakeAgentSession` reply echoes the sent text back inside its own message
      // ("Here is a fake deterministic answer to: ..."), which would otherwise also match a plain
      // text filter on the *other* conversation's box once both messages have been sent (each box
      // only ever contains its own assistant reply, but that reply's text still contains the other
      // conversation's user text as a substring after both sends have happened).
      const parentBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${parentId}"]`,
      );
      const childBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${firstChildId}"]`,
      );
      await expect(
        parentBox.locator('.message-bubble[data-role="user"]', { hasText: parentOnlyText }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        parentBox.locator('.message-bubble[data-role="user"]', { hasText: childOnlyText }),
      ).toHaveCount(0);
      await expect(
        childBox.locator('.message-bubble[data-role="user"]', { hasText: childOnlyText }),
      ).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        childBox.locator('.message-bubble[data-role="user"]', { hasText: parentOnlyText }),
      ).toHaveCount(0);
    });
  });

  test('per-message expand/collapse and a conversation-level bulk toggle (US3, FR-008/FR-009)', async ({
    page,
  }) => {
    await test.step('fixture document exists', async () => {
      await ensureFixtureDocument(page);
    });

    // Long enough (well over MessageBubble.vue's 160px clamp) that both this user message and the
    // FakeAgentSession's echo reply (which quotes the whole sent text back) get their own toggle.
    const LONG_TEXT = Array(10)
      .fill(
        'This is a deliberately long test sentence meant to exceed the default collapsed message height.',
      )
      .join(' ');

    let mainId = '';
    await test.step('locate Main and send two long messages into it', async () => {
      const main = await findConversation(page.request, 'Main');
      mainId = main.id;
      const box = page.locator(`.conversation-thread-box[data-conversation-id="${mainId}"]`);
      await box.getByRole('button', { name: 'Focus' }).click();
      // See the note in the US2 isolation test above: the detail overlay is now a single,
      // app-level dialog rather than one owned per-box.
      const dialog = page.locator('.conversation-detail-dialog');
      for (const suffix of ['one', 'two']) {
        await dialog.locator('textarea').fill(`${LONG_TEXT} (${suffix})`);
        await dialog.getByRole('button', { name: /^Send$/ }).click();
        await expect(dialog.locator('.message-bubble', { hasText: `(${suffix})` })).toBeVisible({
          timeout: 10_000,
        });
      }
      await dialog.getByRole('button', { name: 'Close full view' }).click();
    });

    const box = () => page.locator(`.conversation-thread-box[data-conversation-id="${mainId}"]`);
    const firstLongBubble = () => box().locator('.message-bubble', { hasText: '(one)' }).first();
    const secondLongBubble = () => box().locator('.message-bubble', { hasText: '(two)' }).first();

    await test.step('a long message truncates with its own expand control; expanding/collapsing it individually works (FR-008)', async () => {
      await expect(
        firstLongBubble().getByRole('button', { name: /Show more of this message/ }),
      ).toBeVisible({
        timeout: 10_000,
      });
      await firstLongBubble()
        .getByRole('button', { name: /Show more of this message/ })
        .click();
      await expect(
        firstLongBubble().getByRole('button', { name: /Show less of this message/ }),
      ).toBeVisible();
      await firstLongBubble()
        .getByRole('button', { name: /Show less of this message/ })
        .click();
      await expect(
        firstLongBubble().getByRole('button', { name: /Show more of this message/ }),
      ).toBeVisible();
    });

    await test.step('the conversation-level bulk control expands every message in the box together (FR-009)', async () => {
      const bulk = box().getByRole('button', { name: /Expand all messages/ });
      await expect(bulk).toBeVisible();
      await bulk.click();
      const toggles = box().locator('.expand-toggle-button');
      const count = await toggles.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        await expect(toggles.nth(i)).toHaveText('Show less');
      }
      await expect(box().getByRole('button', { name: /Collapse all messages/ })).toBeVisible();
    });

    await test.step('after the bulk action, toggling one message individually changes only that message', async () => {
      await firstLongBubble()
        .getByRole('button', { name: /Show less of this message/ })
        .click();
      await expect(
        firstLongBubble().getByRole('button', { name: /Show more of this message/ }),
      ).toBeVisible();
      // The other long message stays expanded — the individual toggle didn't affect it.
      await expect(
        secondLongBubble().getByRole('button', { name: /Show less of this message/ }),
      ).toBeVisible();
    });
  });

  test('HUD ordering, click-to-scroll, and staying visible while panning (US4, FR-010)', async ({
    page,
  }) => {
    await test.step('fixture document exists', async () => {
      await ensureFixtureDocument(page);
    });

    let mainId = '';
    let firstHighlightId = '';
    let branchOfFirstId = '';
    let secondHighlightId = '';

    await test.step('build Main + two highlight-anchored conversations + one branch of the first', async () => {
      // By this point in the suite, tests 1-3 have already accumulated a double-digit number of
      // conversations/thread boxes on this same server-side document — driving three more
      // sequential UI-based branches (each needing CodeMirror to locate and scroll a specific
      // `.cm-line`, per `branchFromMarker`) on top of that got materially flakier/slower purely
      // from that accumulated scale, unrelated to what this test is actually checking (HUD
      // ordering/scroll, not branch-creation UI — already covered by the tests above). Creating
      // the fixture conversations directly via the same API `branchFromMarker` ultimately calls
      // avoids that scale-dependent flakiness while still exercising genuine UI interaction for
      // the actual behavior under test below.
      const main = await findConversation(page.request, 'Main');
      mainId = main.id;

      const { content } = await getDocumentState(page);
      const firstOffset = content.indexOf(MARKERS.first);
      const secondOffset = content.indexOf(MARKERS.second);
      expect(firstOffset).toBeGreaterThanOrEqual(0);
      expect(secondOffset).toBeGreaterThanOrEqual(0);

      const firstResponse = await page.request.post('/api/conversations', {
        data: {
          parentConversationId: mainId,
          selection: { from: firstOffset, to: firstOffset + MARKERS.first.length },
        },
      });
      expect(firstResponse.ok()).toBeTruthy();
      firstHighlightId = ((await firstResponse.json()) as { id: string }).id;

      const branchResponse = await page.request.post('/api/conversations', {
        data: { parentConversationId: firstHighlightId },
      });
      expect(branchResponse.ok()).toBeTruthy();
      branchOfFirstId = ((await branchResponse.json()) as { id: string }).id;

      const secondResponse = await page.request.post('/api/conversations', {
        data: {
          parentConversationId: mainId,
          selection: { from: secondOffset, to: secondOffset + MARKERS.second.length },
        },
      });
      expect(secondResponse.ok()).toBeTruthy();
      secondHighlightId = ((await secondResponse.json()) as { id: string }).id;

      await page.reload();
      await expect(page.locator('.toolbar h1')).toBeVisible();
      await expect(
        page.locator(`.conversation-thread-box[data-conversation-id="${secondHighlightId}"]`),
      ).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('the HUD is always visible and lists Main first, then by distance from the top of the document, with the branch grouped at its root rather than given an independent slot (data-model.md HUD ordering)', async () => {
      // By this point in the suite, tests 1-3 have already created their own conversations
      // (including branches anchored to these exact same two markers) that persist in the same
      // server-side document/HUD list — so this asserts the *relative* order of just this test's
      // four conversations within the full list, rather than the list's exact full contents.
      const rows = page.locator('.hud-panel .conversation-row');
      await expect(rows).not.toHaveCount(0);
      const ids = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-conversation-id')),
      );
      const mine = new Set([mainId, firstHighlightId, branchOfFirstId, secondHighlightId]);
      const myOrder = ids.filter((id): id is string => id !== null && mine.has(id));
      expect(myOrder).toEqual([mainId, firstHighlightId, branchOfFirstId, secondHighlightId]);
    });

    await test.step('clicking a HUD entry scrolls the canvas so that conversation comes into view', async () => {
      const canvas = page.locator('.document-canvas');
      // Scroll away from the second highlight first, so the click is what brings it back — not
      // that it was already in view.
      await canvas.evaluate((el) => el.scrollTo({ top: 0 }));
      await expect(async () => {
        const box = await page
          .locator(`.conversation-thread-box[data-conversation-id="${secondHighlightId}"]`)
          .boundingBox();
        expect(box).toBeTruthy();
        const viewport = page.viewportSize();
        expect(viewport).toBeTruthy();
        expect(box!.y).toBeGreaterThan(viewport!.height); // scrolled out of view below the fold
      }).toPass({ timeout: 5_000 });

      await page
        .locator(`.hud-panel .conversation-row[data-conversation-id="${secondHighlightId}"]`)
        .click();

      await expect(async () => {
        const box = await page
          .locator(`.conversation-thread-box[data-conversation-id="${secondHighlightId}"]`)
          .boundingBox();
        expect(box).toBeTruthy();
        const viewport = page.viewportSize();
        expect(viewport).toBeTruthy();
        // `scrollIntoView({block: 'nearest'})` brings it fully within the viewport's vertical band.
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeLessThan(viewport!.height);
      }).toPass({ timeout: 5_000 });
    });

    await test.step('the HUD stays visible while the canvas is panned (it lives in the toolbar row, outside the scrollable canvas)', async () => {
      const hud = page.locator('.hud-panel');
      const before = await hud.boundingBox();
      expect(before).toBeTruthy();

      const canvas = page.locator('.document-canvas');
      await canvas.evaluate((el) => el.scrollTo({ top: el.scrollHeight / 2 }));

      await expect(hud).toBeVisible();
      const after = await hud.boundingBox();
      expect(after).toBeTruthy();
      // Structurally outside the scrollable canvas — panning it must not move the HUD at all.
      expect(after).toEqual(before);
    });
  });

  // NEW desired behavior (not yet implemented) — spec: specs/005-canvas-conversation-threads.
  // Today, branching a conversation (either the "Branch this conversation" button tested here, or
  // a document-highlight branch) always fires a fire-and-forget seed message as the new
  // conversation's first message (`ConversationService.branch`'s `buildBranchSeedMessage`/generic
  // "This conversation was branched from ..." fallback — see conversation-service.ts), so a
  // freshly-created branch never actually renders with zero messages. This test instead asserts
  // the new contract: branching sends no message at all, and the new placeholder box borrows
  // exactly its parent's last user + last assistant message for read-only display (the same
  // `.continuity-context` contract exercised directly in
  // app/frontend/tests/component/MessageBubble.spec.ts).
  test("branching a conversation creates an empty placeholder with no auto-sent seed message, showing the parent's last two messages as read-only context (canvas-conversation-threads, NEW behavior)", async ({
    page,
  }) => {
    await test.step('fixture document exists', async () => {
      await ensureFixtureDocument(page);
    });

    const main = await findConversation(page.request, 'Main');
    const parentLastUserText = 'US8-CONTINUITY-PARENT-USER: what do you make of this document?';

    await test.step('send a real message into Main so it has genuine history to borrow from', async () => {
      const box = page.locator(`.conversation-thread-box[data-conversation-id="${main.id}"]`);
      await box.getByRole('button', { name: 'Focus' }).click();
      const dialog = page.locator('.conversation-detail-dialog');
      await dialog.locator('textarea').fill(parentLastUserText);
      await dialog.getByRole('button', { name: /^Send$/ }).click();
      // Wait for the fake agent's deterministic reply too, so Main's "last message" is settled
      // before branching (mirrors us8's other tests' reliance on FakeAgentSession's echo reply).
      await expect(
        dialog.locator('.message-bubble[data-role="assistant"]', { hasText: parentLastUserText }),
      ).toBeVisible({
        timeout: 10_000,
      });
      await dialog.getByRole('button', { name: 'Close full view' }).click();
    });

    const parentMessagesBeforeBranch = await getConversationMessages(page.request, main.id);
    const parentLastAssistantText = parentMessagesBeforeBranch.at(-1)!.text;
    expect(parentMessagesBeforeBranch.at(-1)!.role).toBe('assistant');

    let branchId = '';
    await test.step('"Branch this conversation" creates a new box with zero of its own messages, immediately', async () => {
      const before = await getConversations(page.request);
      const mainBox = page.locator(`.conversation-thread-box[data-conversation-id="${main.id}"]`);
      await mainBox.getByRole('button', { name: 'Branch this conversation' }).click();

      await expect
        .poll(async () => (await getConversations(page.request)).length, { timeout: 10_000 })
        .toBeGreaterThan(before.length);
      const after = await getConversations(page.request);
      const branch = after.find((c) => !before.some((b) => b.id === c.id));
      expect(branch).toBeTruthy();
      branchId = branch!.id;

      const branchBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${branchId}"]`,
      );
      await expect(branchBox).toBeVisible({ timeout: 10_000 });
      // No message ever belongs to the branch's own history — checked immediately (not after a
      // poll/wait) since the point is that nothing was ever queued to send one in the first place.
      expect(await getConversationMessages(page.request, branchId)).toEqual([]);
      expect(branchBox.locator('.thread-messages .message-bubble')).toHaveCount(0);

      // Confirm it stays that way — no seed message ever arrives, even after a settle window a
      // real fire-and-forget seed turn would have long completed within (this suite's other tests
      // show a branch's seed turn settling well within 10s).
      await page.waitForTimeout(500);
      expect(await getConversationMessages(page.request, branchId)).toEqual([]);
    });

    await test.step("the new placeholder box shows the parent's last user and last assistant message as read-only context", async () => {
      const branchBox = page.locator(
        `.conversation-thread-box[data-conversation-id="${branchId}"]`,
      );
      const context = branchBox.locator('.continuity-context');
      await expect(context).toBeVisible({ timeout: 10_000 });
      await expect(context.locator('.message-bubble')).toHaveCount(2);
      await expect(context.locator('.message-bubble').first()).toContainText(parentLastUserText);
      await expect(context.locator('.message-bubble').last()).toContainText(
        parentLastAssistantText,
      );
    });
  });
});
