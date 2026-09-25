import { test, expect } from '@playwright/test';
import { createThreadDocument, sendThreadMessage, branchFromFirstMessage } from './test-utils.js';

// Spec: 011-linear-thread-mode. Regression coverage for two historical `ThreadCard.vue` layout
// bugs that no jsdom-based component test can catch (jsdom performs no real box-layout math).
//
// NOTE: two other historical bugs in this same file's history (branch-alignment "jiggle" loops,
// margin-top nudging self-triggering a ResizeObserver feedback loop) are deliberately NOT covered
// here — `ThreadCard.vue`'s later self-recursive-per-run "column-packing redesign" (see this
// file's own top doc comment) removed the entire `syncBranchAlignment`/`ResizeObserver`/JS-margin-
// nudge mechanism those bugs lived in. There is nothing left to assert: confirmed by grepping the
// current component for `syncBranchAlignment`/`ResizeObserver`/`appliedMargins` (zero matches) —
// the bug class was eliminated structurally by the redesign, not patched.
test.describe('Thread mode — branch/run-card layout (regression)', () => {
  test('a fork-continuation connector spans the full height of an interposed branch row (2d78be1)', async ({
    page,
  }) => {
    await test.step('a thread with one message, forked, that also continues afterward', async () => {
      await createThreadDocument(page);
      await sendThreadMessage(page, 'First message in the root thread.');
      await branchFromFirstMessage(page);
      await expect(page.locator('.thread-mode-hud .conversation-row')).toHaveCount(2);
    });

    await test.step('back on the root thread, send a second message so this run both forks AND continues', async () => {
      // branchFromFirstMessage's own click auto-focused the new branch; the root thread's own
      // composer (this run's tip) is still the first one in DOM order.
      await sendThreadMessage(page, 'Second message on the root thread, after the branch.');
    });

    await test.step('the spanning connector covers the branch row, not just its near edge', async () => {
      const group = page.locator('.thread-branch-group').first();
      const row = group.locator('.thread-branch-row').first();
      const connector = group.locator('.thread-fork-connector--spanning');
      await expect(connector).toHaveCount(1);

      const groupBox = await group.boundingBox();
      const rowBox = await row.boundingBox();
      const connectorBox = await connector.boundingBox();
      if (!groupBox || !rowBox || !connectorBox) throw new Error('missing bounding box');

      // Regression guard: before the fix, this connector was a fixed 1.25rem box that only
      // bridged the flex-gap edge nearest the run card — nowhere close to the branch row's own
      // (dynamic) height. `--spanning` is absolutely positioned to cover `.thread-branch-group`'s
      // entire box (top:0; bottom:0), so its height must track the row's real height, not a
      // constant.
      expect(Math.abs(connectorBox.height - rowBox.height)).toBeLessThan(3);
      expect(Math.abs(connectorBox.height - groupBox.height)).toBeLessThan(3);
      expect(connectorBox.height).toBeGreaterThan(20); // a real branch row is never 1.25rem tall
    });
  });

  test("a run's sticky header stays flush against its own first run-card (f91157f)", async ({
    page,
  }) => {
    await createThreadDocument(page);
    await sendThreadMessage(page, 'First message in the root thread.');
    await branchFromFirstMessage(page);
    await expect(page.locator('.thread-mode-hud .conversation-row')).toHaveCount(2);

    // `.thread-card-header` only renders once per Thread (its own `runStartIndex === 0` instance —
    // see ThreadCard.vue's own top doc comment), immediately followed in DOM order by that same
    // Thread's first `.thread-card--flush-header` run-card. `.first()` on each resolves to the
    // ROOT thread's own pair (mounted before the branch's, which is nested inside its own
    // `.thread-branch-group` further down the DOM).
    const headerLocator = page.locator('.thread-card-header').first();
    const rootCard = page.locator('.thread-card--flush-header').first();

    const headerBox = await headerLocator.boundingBox();
    const cardBox = await rootCard.boundingBox();
    if (!headerBox || !cardBox) throw new Error('missing bounding box');

    // Regression guard: before the fix, the header was a bare, unbordered flex sibling floating
    // disconnected above the run-card chain ("the title and expand buttons render outside the
    // threaded conversation") — assert it now reads as one continuous box: same left/right edges,
    // and flush (no gap) against the card immediately below it.
    expect(Math.abs(headerBox.x - cardBox.x)).toBeLessThan(3);
    expect(Math.abs(headerBox.width - cardBox.width)).toBeLessThan(3);
    expect(Math.abs(headerBox.y + headerBox.height - cardBox.y)).toBeLessThan(3);
  });
});
