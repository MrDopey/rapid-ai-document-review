import { test, expect, type Page } from '@playwright/test';

// Mirrors packages/backend/src/pi/fake-agent-session.ts's directives (see us3/us5.spec.ts for the
// same convention) — deterministic, credential-free ways to drive a proposed edit or a failed turn
// through the real EventBridge/EventHub/WS pipeline.
const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';
const ERROR_DIRECTIVE = '__AGENT_ERROR__';

function proposeEdit(summary: string, operations: { old_string: string; new_string: string }[]): string {
  return `${PROPOSE_EDIT_DIRECTIVE}${JSON.stringify({ summary, operations })}`;
}

// Matches EditorComponent.vue's plain (non-`Mod`-qualified) CodeMirror keymap entry.
const BRANCH_SHORTCUT = 'Alt+Shift+C';

const MARKERS = {
  intro: 'A11Y-INTRO-LINE',
  target: 'A11Y-TARGET-LINE-FOR-BRANCH',
  appended: 'A11Y-APPENDED-VIA-KEYBOARD',
};

interface ConversationSummary {
  id: string;
  name: string;
  kind: 'main' | 'branch' | 'review';
  status: string;
}

async function getConversations(page: Page): Promise<ConversationSummary[]> {
  const res = await page.request.get('/api/conversations');
  const body = (await res.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

async function waitIdleApi(page: Page, conversationId: string): Promise<void> {
  await expect
    .poll(
      async () => (await getConversations(page)).find((c) => c.id === conversationId)?.status,
      { timeout: 15_000, intervals: [200] },
    )
    .not.toBe('working');
}

/**
 * Records every real mouse/pointer input event that reaches the page, from before any app script
 * runs. Programmatic focus (`locator.focus()`) never dispatches these; neither does the synthetic
 * `click` a browser raises when Enter/Space activates a focused button — only actual pointer
 * hardware input (or Playwright's `.click()`/`.mouse.*`) does, which is exactly what the core-loop
 * test below must prove it never used.
 */
async function installPointerEventGuard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __pointerEvents: string[] };
    w.__pointerEvents = [];
    const types = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'wheel'];
    for (const type of types) {
      window.addEventListener(type, () => w.__pointerEvents.push(type), { capture: true });
    }
  });
}

async function getPointerEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __pointerEvents: string[] }).__pointerEvents);
}

/**
 * Records every non-empty text committed to either FR-043b live region (a11y/live-regions.ts),
 * from before the app mounts them, via a MutationObserver on the whole document. Reading the
 * accumulated history (rather than polling the region's current text) avoids a race where a later
 * announcement overwrites an earlier one before a test gets to assert on it.
 */
async function installLiveRegionRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __liveAnnouncements: { polite: string[]; assertive: string[] } };
    w.__liveAnnouncements = { polite: [], assertive: [] };
    const record = (): void => {
      const polite = document.getElementById('a11y-live-region-polite');
      const assertive = document.getElementById('a11y-live-region-assertive');
      if (polite?.textContent) w.__liveAnnouncements.polite.push(polite.textContent);
      if (assertive?.textContent) w.__liveAnnouncements.assertive.push(assertive.textContent);
    };
    const observer = new MutationObserver(record);
    const start = (): void => observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
}

async function getLiveAnnouncements(page: Page): Promise<{ polite: string[]; assertive: string[] }> {
  return page.evaluate(() => (window as unknown as { __liveAnnouncements: { polite: string[]; assertive: string[] } }).__liveAnnouncements);
}

async function expectAnnounced(page: Page, politeness: 'polite' | 'assertive', substring: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const { polite, assertive } = await getLiveAnnouncements(page);
        return (politeness === 'polite' ? polite : assertive).some((t) => t.includes(substring));
      },
      { timeout: 15_000, intervals: [250] },
    )
    .toBe(true);
}

/**
 * Self-contained (no closure captures — passed by reference into `page.evaluate`) manual WCAG 2.2
 * AA audit. No `@axe-core/playwright` (or any other accessibility-testing library) is present
 * anywhere in this repo's `package.json`s or `node_modules` (checked before writing this), and
 * installing one isn't feasible in this environment (no package-registry network access at
 * implementation time) — this is the documented fallback the task calls for instead: DOM queries
 * for the concrete WCAG failure modes T083 asked about (missing accessible names, missing dialog
 * semantics, missing alt text) plus a from-scratch relative-luminance contrast calculator run over
 * every visible text-bearing leaf element on the page.
 */
function runManualA11yAudit(): { roleViolations: string[]; contrastViolations: string[] } {
  const roleViolations: string[] = [];
  const contrastViolations: string[] = [];

  function describe(el: Element): string {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }

  function hasAccessibleName(el: Element): boolean {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim().length > 0) return true;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby && labelledby.split(/\s+/).some((id) => (document.getElementById(id)?.textContent ?? '').trim().length > 0)) {
      return true;
    }
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
    if (el.closest('label')) return true;
    if (el.textContent && el.textContent.trim().length > 0) return true;
    return false;
  }

  // 1. Every visible button has an accessible name.
  for (const button of Array.from(document.querySelectorAll('button'))) {
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!hasAccessibleName(button)) roleViolations.push(`Button with no accessible name: ${describe(button)}`);
  }

  // 2. Every visible form input/textarea/select has an accessible name.
  for (const field of Array.from(document.querySelectorAll('input, textarea, select'))) {
    const rect = field.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!hasAccessibleName(field)) roleViolations.push(`Form field with no accessible name: ${describe(field)}`);
  }

  // 3. Every dialog/alertdialog declares aria-modal and has an accessible name.
  for (const dialog of Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))) {
    if (dialog.getAttribute('aria-modal') !== 'true') {
      roleViolations.push(`Dialog missing aria-modal="true": ${describe(dialog)}`);
    }
    if (!hasAccessibleName(dialog)) roleViolations.push(`Dialog with no accessible name: ${describe(dialog)}`);
  }

  // 4. Every img declares alt (empty alt is fine for decorative images; missing is not).
  for (const img of Array.from(document.querySelectorAll('img'))) {
    if (!img.hasAttribute('alt')) roleViolations.push(`<img> missing alt attribute: ${describe(img)}`);
  }

  // 5. Every tab has an aria-controls pointing at an existing tabpanel.
  for (const tab of Array.from(document.querySelectorAll('[role="tab"]'))) {
    const controls = tab.getAttribute('aria-controls');
    if (!controls || !document.getElementById(controls)) {
      roleViolations.push(`Tab missing aria-controls (or target panel absent): ${describe(tab)}`);
    }
  }

  // 6. Contrast: relative-luminance ratio for every visible text-bearing leaf element.
  function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1]!.split(',').map((s) => parseFloat(s.trim()));
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts.length > 3 ? parts[3]! : 1 };
  }

  function relLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
    const lin = (c: number): number => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(fg: { r: number; g: number; b: number }, bg: { r: number; g: number; b: number }): number {
    const l1 = relLuminance(fg) + 0.05;
    const l2 = relLuminance(bg) + 0.05;
    return l1 > l2 ? l1 / l2 : l2 / l1;
  }

  function effectiveBackground(el: Element): { r: number; g: number; b: number } {
    let node: Element | null = el;
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) return bg;
        // Composite the partial-alpha background over an assumed white canvas (this app's actual
        // default — `style.css` never overrides it) rather than treating it as opaque.
        return {
          r: bg.r * bg.a + 255 * (1 - bg.a),
          g: bg.g * bg.a + 255 * (1 - bg.a),
          b: bg.b * bg.a + 255 * (1 - bg.a),
        };
      }
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255 };
  }

  function isLargeText(fontSizePx: number, fontWeight: string): boolean {
    const bold = fontWeight === 'bold' || parseInt(fontWeight, 10) >= 700;
    if (fontSizePx >= 24) return true;
    return fontSizePx >= 18.66 && bold;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = walker.currentNode;
  while (current) {
    const el = current as Element;
    current = walker.nextNode();

    // Only leaf elements (no element children) carrying their own direct text are meaningful
    // "one color, one background" contrast subjects — a container's mixed-color descendants are
    // each checked individually when the walker reaches them.
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? '').trim();
    if (text.length === 0) continue;

    const rect = el.getBoundingClientRect();
    // Visually-hidden (screen-reader-only) text is never meant to be seen, so contrast doesn't
    // apply to it — both this app's `.visually-hidden` utility and the FR-043b live regions
    // collapse to a near-zero box.
    if (rect.width <= 2 || rect.height <= 2) continue;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const fg = parseColor(style.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    const fontSizePx = parseFloat(style.fontSize);
    const threshold = isLargeText(fontSizePx, style.fontWeight) ? 3.0 : 4.5;
    const ratio = contrastRatio(fg, bg);
    if (ratio < threshold - 0.05) {
      contrastViolations.push(
        `${describe(el)} "${text.slice(0, 40)}": ratio ${ratio.toFixed(2)} < required ${threshold} ` +
          `(color ${style.color} on effective background rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}))`,
      );
    }
  }

  return { roleViolations, contrastViolations };
}

test.describe('a11y — WCAG 2.2 AA (FR-043a/b/c/d)', () => {
  test('core loop is fully keyboard-operable with no mouse/pointer input (FR-043a)', async ({ page }) => {
    await installPointerEventGuard(page);

    let branchName = '';

    await test.step('establish the fixture document via the keyboard', async () => {
      await page.goto('/');
      const pasteHeading = page.getByRole('heading', { name: 'Paste your document' });

      if (await pasteHeading.isVisible().catch(() => false)) {
        const textarea = page.getByLabel('Document content');
        await textarea.focus();
        await page.keyboard.type(`# A11y Fixture Document\n\n${MARKERS.intro}\n\n${MARKERS.target}`);

        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Start reviewing' })).toBeFocused();
        await page.keyboard.press('Enter');

        await expect(page.locator('.toolbar h1')).toBeVisible({ timeout: 10_000 });
      } else {
        // A document already exists — this backend/database is shared across the whole e2e
        // run (see env.ts), and the story specs run before this one, so the (single, global)
        // paste screen is no longer reachable at all. Reset its content directly via the same
        // document PATCH endpoint the app's own debounced-save path uses (not a UI interaction,
        // so it doesn't count against the pointer-free assertion below) rather than simulating
        // a "select all" keypress whose effect depends on exactly which CodeMirror keymap
        // extensions are registered — everything from here on (edit, branch, propose, preview,
        // accept) still exercises the real UI keyboard-only.
        await expect(page.locator('.toolbar h1')).toBeVisible({ timeout: 10_000 });
        const docRes = await page.request.get('/api/document');
        const docBody = (await docRes.json()) as { document: { currentRevision: number }; content: string };
        await page.request.patch('/api/document', {
          data: {
            baseRevision: docBody.document.currentRevision,
            changes: [
              {
                from: 0,
                to: docBody.content.length,
                insert: `# A11y Fixture Document\n\n${MARKERS.intro}\n\n${MARKERS.target}`,
              },
            ],
          },
        });
        const editorContent = page.locator('.editor-host .cm-content');
        await expect(editorContent).toContainText(MARKERS.target, { timeout: 10_000 });
      }
    });

    await test.step('edit the document via the keyboard', async () => {
      const editorContent = page.locator('.editor-host .cm-content');
      await editorContent.focus();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(`\n\n${MARKERS.appended}`);
      await expect(editorContent).toContainText(MARKERS.appended);
    });

    await test.step('branch from a keyboard-only selection (FR-011/FR-043a)', async () => {
      const editorContent = page.locator('.editor-host .cm-content');
      await editorContent.focus();
      await page.keyboard.press('ControlOrMeta+Home');
      // Doc lines after the two steps above: 0 title, 1 blank, 2 intro, 3 blank, 4 target — no
      // pointer needed to reach it, since every line's position is known from what was just typed.
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press(BRANCH_SHORTCUT);

      await expect(page.locator('.conversation-header h2')).toHaveText('A11y Fixture Document', { timeout: 10_000 });
      branchName = 'A11y Fixture Document';
      await expect(page.locator('.conversation-header .badge').first()).toHaveAttribute('data-status', /idle/, {
        timeout: 20_000,
      });
    });

    await test.step('propose an edit from the composer via the keyboard', async () => {
      const composer = page.getByLabel(`Message ${branchName}`);
      await composer.focus();
      await page.keyboard.type(
        proposeEdit('Tighten via keyboard-only a11y test', [
          // A word-level replacement (not a pure append) so the diff has both a removed and an
          // added part — exercising both halves of FR-043c's marker+label pair below.
          { old_string: MARKERS.target, new_string: 'A11Y-TARGET-LINE-REVISED' },
        ]),
      );
      await page.keyboard.press('Enter');

      const row = page.locator('.edit-row', { hasText: 'Tighten via keyboard-only a11y test' });
      await expect(row).toBeVisible({ timeout: 15_000 });
    });

    await test.step('preview the proposed diff via the keyboard, close it with Escape (FR-043d)', async () => {
      const row = page.locator('.edit-row', { hasText: 'Tighten via keyboard-only a11y test' });
      const previewButton = row.getByRole('button', { name: 'Preview' });
      await previewButton.focus();
      await page.keyboard.press('Enter');

      const dialog = page.getByRole('dialog', { name: 'Review proposed edit' });
      await expect(dialog).toBeVisible();
      // FR-043d: opening the dialog moved focus to its first interactive element automatically.
      await expect(dialog.getByRole('tab', { name: 'Added / removed' })).toBeFocused();
      // FR-043c: conveyed by more than color alone.
      await expect(dialog.locator('del.removed .marker').first()).toHaveText('−');
      await expect(dialog.locator('ins.added .marker').first()).toHaveText('+');

      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      // FR-043d: closing it returned focus to the control that opened it.
      await expect(previewButton).toBeFocused();
    });

    await test.step('accept the proposed edit via the keyboard', async () => {
      const row = page.locator('.edit-row', { hasText: 'Tighten via keyboard-only a11y test' });
      const acceptButton = row.getByRole('button', { name: 'Accept' });
      await acceptButton.focus();
      await page.keyboard.press('Enter');

      await expect(row.locator('.status-badge')).toHaveText('applied', { timeout: 10_000 });
      await expect(page.locator('.editor-host')).toContainText('A11Y-TARGET-LINE-REVISED', { timeout: 10_000 });
    });

    await test.step('no mouse/pointer event was ever dispatched', async () => {
      expect(await getPointerEvents(page)).toEqual([]);
    });
  });

  test('live-region announcements fire for every FR-043b event type', async ({ page }) => {
    await installLiveRegionRecorder(page);
    await page.goto('/');
    await expect(page.locator('.toolbar h1')).toBeVisible({ timeout: 10_000 });

    const main = (await getConversations(page)).find((c) => c.kind === 'main');
    if (!main) throw new Error('expected a Main conversation to already exist (previous test creates the document)');

    await test.step('agent_started + message_completed (polite)', async () => {
      const res = await page.request.post(`/api/conversations/${main.id}/send`, {
        data: { message: 'Hello from the a11y live-region test.' },
      });
      expect(res.ok()).toBe(true);
      await expectAnnounced(page, 'polite', 'the agent started responding');
      await expectAnnounced(page, 'polite', 'response completed');
      await waitIdleApi(page, main.id);
    });

    await test.step('staged_edit_created (polite)', async () => {
      const res = await page.request.post(`/api/conversations/${main.id}/send`, {
        data: {
          message: proposeEdit('A11y live-region proposal', [
            { old_string: MARKERS.appended, new_string: `${MARKERS.appended}-2` },
          ]),
        },
      });
      expect(res.ok()).toBe(true);
      await expectAnnounced(page, 'polite', 'new proposed edit');
      await waitIdleApi(page, main.id);
    });

    await test.step('agent_error (assertive)', async () => {
      const res = await page.request.post(`/api/conversations/${main.id}/send`, { data: { message: ERROR_DIRECTIVE } });
      expect(res.ok()).toBe(true);
      await expectAnnounced(page, 'assertive', 'agent error');
    });

    await test.step('conversation_stale (polite)', async () => {
      const branchRes = await page.request.post('/api/conversations', {
        data: { parentConversationId: main.id, name: 'A11y Stale Branch' },
      });
      expect(branchRes.ok()).toBe(true);
      const branch = (await branchRes.json()) as { id: string };

      const docRes = await page.request.get('/api/document');
      const docBody = (await docRes.json()) as { document: { currentRevision: number }; content: string };
      const from = docBody.content.length;
      await page.request.patch('/api/document', {
        data: { baseRevision: docBody.document.currentRevision, changes: [{ from, to: from, insert: '\n\nA11Y-STALE-ADVANCE' }] },
      });

      await expect
        .poll(async () => (await getConversations(page)).find((c) => c.id === branch.id) !== undefined, { timeout: 5_000 })
        .toBe(true);
      await expectAnnounced(page, 'polite', 'is now stale');
    });
  });

  test('manual WCAG 2.2 AA audit over each main view (roles/names + contrast)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.toolbar h1')).toBeVisible({ timeout: 10_000 });

    async function runAuditAndAssert(viewName: string): Promise<void> {
      const { roleViolations, contrastViolations } = await page.evaluate(runManualA11yAudit);
      expect(roleViolations, `${viewName}: role/name violations`).toEqual([]);
      expect(contrastViolations, `${viewName}: contrast violations`).toEqual([]);
    }

    await test.step('main editor + HUD + conversation view', async () => {
      await runAuditAndAssert('main view');
    });

    await test.step('history panel', async () => {
      await page.getByRole('button', { name: 'History' }).click();
      await expect(page.locator('.history-panel')).toBeVisible();
      await runAuditAndAssert('history panel');
      await page.getByRole('button', { name: 'Hide history' }).click();
    });

    await test.step('diff preview dialog', async () => {
      // Main accumulates edits across the whole shared-backend e2e run (see env.ts), including
      // superseded/conflicted ones from earlier specs (US5's Primary-conflict-exhaustion
      // scenario in particular) whose preview is `reconcilable: false` by now. Rather than audit
      // whichever edit happens to be first in that history, propose a fresh, guaranteed-clean
      // one against a brand-new anchor so this step reliably exercises the tabbed (reconcilable)
      // layout rather than the conflict-banner one.
      const anchor = 'A11Y-AUDIT-DIFF-ANCHOR';
      const docRes = await page.request.get('/api/document');
      const docBody = (await docRes.json()) as { document: { currentRevision: number }; content: string };
      await page.request.patch('/api/document', {
        data: {
          baseRevision: docBody.document.currentRevision,
          changes: [{ from: docBody.content.length, to: docBody.content.length, insert: `\n\n${anchor}` }],
        },
      });

      const main = (await getConversations(page)).find((c) => c.kind === 'main');
      if (!main) throw new Error('expected a Main conversation to already exist');
      const summary = 'A11y audit fixture proposal';
      const res = await page.request.post(`/api/conversations/${main.id}/send`, {
        data: { message: proposeEdit(summary, [{ old_string: anchor, new_string: `${anchor}-REVISED` }]) },
      });
      expect(res.ok()).toBe(true);
      await waitIdleApi(page, main.id);

      const row = page.locator('.edit-row', { hasText: summary });
      await expect(row).toBeVisible({ timeout: 10_000 });
      const previewButton = row.getByRole('button', { name: `Preview: ${summary}` });
      await previewButton.click();
      const dialog = page.getByRole('dialog', { name: 'Review proposed edit' });
      await expect(dialog).toBeVisible();
      // The dialog itself renders synchronously; its preview content arrives from an async fetch
      // (DiffViewer.vue's `load()`) — wait for that to settle (either outcome) before auditing,
      // otherwise the audit can run against the transient "Loading preview…" state.
      await expect(dialog.locator('[role="tabpanel"], .conflict-banner').first()).toBeVisible({ timeout: 10_000 });
      await runAuditAndAssert('diff preview dialog');
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
    });

    await test.step('close-confirmation dialog', async () => {
      const branchRow = page.locator('.conversation-row', { hasText: 'A11y Fixture Document' });
      await branchRow.click();
      await expect(page.locator('.conversation-header h2')).toHaveText('A11y Fixture Document');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Close conversation' });
      await expect(dialog).toBeVisible();
      await runAuditAndAssert('close-confirmation dialog');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).not.toBeVisible();
    });
  });
});
