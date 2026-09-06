import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type {
  ConversationDto,
  DocumentDto,
  GetDocumentResponse,
  ListConversationsResponse,
  UserSettingsDto,
} from '@rapid-ai-document-review/shared/contracts/http';

// New feature: synchronized scrolling between the Editor and Preview panes. This covers the
// toolbar-level bits App.vue itself owns (per specs/005-canvas-conversation-threads' toolbar
// conventions — 006-toolbar-reorg's "Global Actions" box and its Ctrl+Alt+<letter> shortcuts, both
// documented in a11y/keymap-registry.ts): the "Sync scroll" checkbox's label/state in
// `.actions-group`, alongside "Show reasoning"/"History", and its Ctrl+Alt+Y shortcut — mirroring
// the existing Ctrl+Alt+R ("Show reasoning")/Ctrl+Alt+H ("History") shortcuts App.vue already
// implements the same way. The scroll-linking mechanics themselves (ratio mapping, feedback-loop
// guard) are covered directly in scrollSync.spec.ts; this file only covers the toggle's own
// UI/keyboard wiring, so the heavy panes (DocumentCanvas, PreviewComponent) and the toolbar's
// HudPanel box are stubbed out — nothing here exercises their internals.
//
// Mounting App.vue for real (rather than testing this inline in isolation, as there is no smaller
// existing component that owns these shortcuts) needs a few browser APIs jsdom doesn't implement:
// `ResizeObserver` (App.vue's own `.panes` observer, used for `focusCap`) and `window.matchMedia`
// (the desktop/mobile breakpoint check) are stubbed below; `httpClient`/`WsClient` are mocked so
// `store.load()` and friends resolve immediately instead of making real network calls.

const documentFixture: DocumentDto = {
  id: 'doc-1',
  title: 'Test Document',
  currentRevision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const getDocumentResponse: GetDocumentResponse = {
  document: documentFixture,
  content: '# Test Document\n\nHello world.',
  eventSequence: 0,
};

const listConversationsResponse: ListConversationsResponse = {
  currentRevision: 1,
  conversations: [],
  nextCursor: null,
};

const settingsFixture: UserSettingsDto = {
  thinkingVisible: false,
  revisionDebounceMs: 300_000,
  maxConcurrentAgents: 3,
  maxEditingDepth: 2,
  maxConversationDepth: 3,
  maxReplacementAttempts: 2,
  softWordCountThreshold: 20_000,
};

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    getDocument: vi.fn(async () => getDocumentResponse),
    listConversations: vi.fn(async () => listConversationsResponse),
    getSettings: vi.fn(async () => settingsFixture),
    patchSettings: vi.fn(async () => settingsFixture),
    // Used only by the "auto-focus on branch" suite below — the other suites in this file never
    // branch, so this stays unset (undefined resolution) for them.
    branchConversation: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

import { httpClient } from '../../src/transport/http-client.js';
import { HOTKEY_BINDINGS, findConflicts } from '../../src/a11y/keymap-registry.js';
import { useConversationsStore } from '../../src/stores/conversations.js';
import { useDocumentStore } from '../../src/stores/document.js';
import DocumentCanvas from '../../src/components/canvas/DocumentCanvas.vue';
import PreviewComponent from '../../src/components/preview/PreviewComponent.vue';
import ConversationDetailPanel from '../../src/components/conversation/ConversationDetailPanel.vue';
import HudPanel from '../../src/components/hud/HudPanel.vue';

vi.mock('../../src/transport/ws-client.js', async () => {
  const { ref } = await import('vue');
  class MockWsClient {
    reconnecting = ref(false);
    onFrame = vi.fn();
    connect = vi.fn();
    close = vi.fn();
    send = vi.fn();
  }
  return { WsClient: MockWsClient };
});

import App from '../../src/App.vue';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function stubMatchMedia(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const STUBS = {
  DocumentCanvas: true,
  PreviewComponent: true,
  HudPanel: true,
  HistoryPanel: true,
  ConversationDetailPanel: true,
  KeyboardShortcutsDialog: true,
  HelpDialog: true,
};

async function mountApp(pinia: Pinia): Promise<VueWrapper> {
  const wrapper = mount(App, { global: { plugins: [pinia], stubs: STUBS } });
  await flushPromises();
  return wrapper;
}

describe('App.vue — "Sync scroll" toggle (Global Actions box)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true); // desktop breakpoint, matching the other two toolbar toggles' own layout
    localStorage.clear(); // no stored "sync scroll" preference by default — see the dedicated test below
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function syncScrollCheckbox(wrapper: VueWrapper) {
    const label = wrapper.findAll('.reasoning-toggle').find((el) => el.text().includes('Sync scroll'));
    if (!label) throw new Error('"Sync scroll" control not found in .actions-group');
    return label.find('input[type="checkbox"]');
  }

  it('renders checked by default (no stored preference), labeled "Sync scroll", alongside "Show reasoning" and "History" in .actions-group', async () => {
    const wrapper = await mountApp(pinia);
    const actionsGroup = wrapper.find('.actions-group');
    expect(actionsGroup.exists()).toBe(true);

    const labels = actionsGroup.findAll('.reasoning-toggle').map((el) => el.text());
    expect(labels).toEqual(['Show reasoning', 'Sync scroll']);
    expect(actionsGroup.text()).toContain('History');

    const checkbox = syncScrollCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  it('renders unchecked when the user previously stored an explicit "off" preference', async () => {
    localStorage.setItem('raidr:syncScrollEnabled', 'false');
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  it('clicking the checkbox toggles the checked state', async () => {
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);

    await checkbox.setValue(false);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);

    await checkbox.setValue(true);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  it('Ctrl+Alt+Y toggles the checkbox, matching the Ctrl+Alt+R/Ctrl+Alt+H sibling shortcuts', async () => {
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  it('ignores Ctrl+Alt+Y while focus is in an editing context (matching the sibling shortcuts\' guard)', async () => {
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, altKey: true, bubbles: true }));
    await wrapper.vm.$nextTick();

    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
    input.remove();
  });
});

// Auto-focus-on-branch + branch-cap gating (005-canvas-conversation-threads follow-up): branching
// from within the focus view's own "Branch" button (`ConversationView.vue`'s
// `branchThisConversation`, parity with `ConversationThreadBox.vue`'s sidebar branch action) should
// auto-focus the newly created branch — and, per the later branch-cap parity fix, branch creation
// itself is now blocked outright (the button disabled, with a focus-limit tooltip) whenever the
// live focus cap (`focusConfig.ts`'s `useFocusCap`) has no free slot left, rather than allowing
// creation and silently skipping auto-focus as before. `App.vue`'s consolidated `onBranchCreated`
// handler just forwards the new id into `focusConversation` (guaranteed a free slot by the time it
// fires); these tests exercise the whole chain end to end: real `ConversationDetailPanel`/
// `ConversationView` (unlike the "Sync scroll" suite above, which stubs `ConversationDetailPanel`
// out entirely), a real click on the Branch action button, and the resulting focus-set/`lastInteractedId`
// state, observed via which `ConversationDetailPanel` instances render and each one's own `active`
// prop.
describe('App.vue — auto-focus on branch from the focus view', () => {
  let pinia: Pinia;

  // The do-nothing `ResizeObserverStub` above never actually invokes its callback, which pins every
  // other suite in this file to `viewportFitCount === 1` (see `focusConfig.ts`'s `useFocusCap`) —
  // fine for suites that don't care about the focus cap, but this suite needs real headroom (cap 3,
  // the default) to exercise both "still room" and "already full" — so `.panes`' `ResizeObserver`
  // is given a wide measured width the moment it starts observing, simulating a viewport with room
  // for several focused panels side by side.
  class WideResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ contentRect: { width: 2000 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', WideResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
    vi.mocked(httpClient.branchConversation).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // Everything except `ConversationDetailPanel` (and its own nested `EditsList`, irrelevant here)
  // is stubbed, same convention as `MessageBubble.spec.ts`'s own
  // "ConversationDetailPanel/ConversationView — Expand all/Branch parity" suite.
  const FOCUS_VIEW_STUBS = {
    DocumentCanvas: true,
    PreviewComponent: true,
    HudPanel: true,
    HistoryPanel: true,
    KeyboardShortcutsDialog: true,
    HelpDialog: true,
    EditsList: true,
  };

  function conversationFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
    return {
      name: overrides.id,
      kind: 'branch',
      parentId: null,
      branchDepth: 1,
      status: 'idle',
      isPrimary: false,
      contextRevision: 1,
      isStale: false,
      pendingEditCount: 0,
      canEdit: true,
      canBranch: true,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      readOnly: false,
      anchorOrphaned: false,
      seedSelection: null,
      forkedFromMessageId: null,
      ...overrides,
    };
  }

  /** Mounts `App.vue` for real, seeds `conversationsStore.conversations` (after the initial
   *  `conversationsStore.load()` from `onMounted` has resolved to its mocked empty list — otherwise
   *  that load would clobber the seed), then focuses `focusedIds` in order via the same
   *  `toggle-focus` event `DocumentCanvas`'s real `ConversationThreadBox` boxes emit (App.vue's
   *  `@toggle-focus="toggleFocus"`), driven here through the stubbed `DocumentCanvas`'s `$emit`
   *  directly. `conversationsStore.loadDetail` (each focused `ConversationView`'s own `onMounted`
   *  load) is stubbed to a no-op, same as `MessageBubble.spec.ts`'s equivalent suite — this test
   *  only cares about focus-set/`lastInteractedId` state, not a real detail re-fetch. */
  async function mountFocusedApp(conversations: ConversationDto[], focusedIds: string[]) {
    const wrapper = mount(App, { global: { plugins: [pinia], stubs: FOCUS_VIEW_STUBS } });
    await flushPromises();

    const conversationsStore = useConversationsStore();
    conversationsStore.conversations = conversations;
    vi.spyOn(conversationsStore, 'loadDetail').mockResolvedValue(undefined);

    const canvas = wrapper.findComponent(DocumentCanvas);
    for (const id of focusedIds) {
      canvas.vm.$emit('toggle-focus', id);
      await flushPromises();
    }
    return wrapper;
  }

  /** Every currently-rendered focus panel's own conversation id and `active` prop, in DOM order —
   *  `ConversationDetailPanel.vue`'s `active` prop is exactly App.vue's `conv.id === lastInteractedId`
   *  (see its own doc comment), so reading it back off the rendered instance is a direct, black-box
   *  way to observe `lastInteractedId` without reaching into App.vue's internals. */
  function focusedPanelStates(wrapper: VueWrapper): { conversationId: string; active: boolean }[] {
    return wrapper.findAllComponents(ConversationDetailPanel).map((panel) => ({
      conversationId: panel.props('conversationId'),
      active: panel.props('active'),
    }));
  }

  it('auto-focuses (and marks lastInteractedId) the new branch when the focus set has a free slot under the cap', async () => {
    const main = conversationFixture({ id: 'main-1', kind: 'main', parentId: null, branchDepth: 0 });
    const wrapper = await mountFocusedApp([main], ['main-1']);
    expect(focusedPanelStates(wrapper)).toEqual([{ conversationId: 'main-1', active: true }]);

    const branch = conversationFixture({ id: 'branch-1', parentId: 'main-1', branchDepth: 1 });
    vi.mocked(httpClient.branchConversation).mockResolvedValue(branch);

    await wrapper.get('[data-action="branch"]').trigger('click');
    await flushPromises();

    expect(httpClient.branchConversation).toHaveBeenCalledWith({ parentConversationId: 'main-1' });
    const states = focusedPanelStates(wrapper);
    expect(states.map((s) => s.conversationId).sort()).toEqual(['branch-1', 'main-1']);
    // The freshly auto-focused branch becomes `lastInteractedId` — the one active panel — and
    // `main-1`'s own panel (which the click originated in) is no longer the active one.
    expect(states.find((s) => s.conversationId === 'branch-1')?.active).toBe(true);
    expect(states.find((s) => s.conversationId === 'main-1')?.active).toBe(false);
  });

  it('disables the Branch button (with a focus-limit tooltip) and never creates a branch once the focus set is already at the cap', async () => {
    const conversations = [
      conversationFixture({ id: 'c1', branchDepth: 1 }),
      conversationFixture({ id: 'c2', branchDepth: 1 }),
      conversationFixture({ id: 'c3', branchDepth: 1 }),
    ];
    const wrapper = await mountFocusedApp(conversations, ['c1', 'c2', 'c3']);
    expect(focusedPanelStates(wrapper).map((s) => s.conversationId).sort()).toEqual(['c1', 'c2', 'c3']);

    const branch = conversationFixture({ id: 'branch-1', parentId: 'c1', branchDepth: 2 });
    vi.mocked(httpClient.branchConversation).mockResolvedValue(branch);

    // Branch-cap parity fix (behavior change): branch creation itself is now blocked outright at
    // the cap, not just auto-focus — the Branch button inside `c1`'s own focus panel is disabled,
    // with a tooltip naming the focus limit, and a click (jsdom, like a real browser, never fires a
    // `click` handler for a `disabled` native button) never reaches the API at all.
    const c1Panel = wrapper.findAllComponents(ConversationDetailPanel).find((p) => p.props('conversationId') === 'c1')!;
    const branchButton = c1Panel.get('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toMatch(/max 3/);

    await branchButton.trigger('click');
    await flushPromises();

    expect(httpClient.branchConversation).not.toHaveBeenCalled();
    // Still exactly the original three panels, and the branch was never even created.
    const states = focusedPanelStates(wrapper);
    expect(states.map((s) => s.conversationId).sort()).toEqual(['c1', 'c2', 'c3']);
    const conversationsStore = useConversationsStore();
    expect(conversationsStore.conversations.some((c) => c.id === 'branch-1')).toBe(false);
  });
});

// Three related additions to the Preview|Canvas split, all covered below:
//   1. The drag resize handle's minimum-width clamp is now 30% of `.panes`' total measured width
//      on each side (replacing an earlier fixed-`200px` floor).
//   2. Independent Preview/Canvas visibility toggles (`.actions-group` buttons + Ctrl+Alt+P/E),
//      each persisted via panePersistence.ts, with a "never hide both" guard.
//   3. The document title moved out of `.toolbar-left` into `document.title` (a reactive watch),
//      freeing that column's height for the HUD box.
// `jsdom` gives every element a zero-size `getBoundingClientRect()` by default, so the resize-drag
// suite below stubs `.panes`' own rect directly — the same element `useResizeHandle`'s
// `containerEl` ref (App.vue's `panesEl`) reads from mid-gesture. `jsdom` also has no global
// `PointerEvent` constructor (only `MouseEvent`), so drag gestures are simulated with `MouseEvent`s
// carrying a `pointermove`/`pointerup` `type` — `useResizeHandle`'s window-level listeners are
// registered by event `type` string, not by constructor, so this reaches the same code path a real
// pointer drag would.

describe('App.vue — Preview|Canvas resize handle: 30% minimum-width clamp', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Stubs `.panes`' `getBoundingClientRect()` to a fixed, known width — `useResizeHandle` reads
   *  this at the start of each gesture (`startDrag`'s own `containerEl.value?.getBoundingClientRect()`). */
  function stubPanesWidth(wrapper: VueWrapper, width: number): void {
    const panesEl = wrapper.get('.panes').element as HTMLDivElement;
    panesEl.getBoundingClientRect = () =>
      ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }

  /** Parses the `previewFr`/`canvasFr` pair straight out of `.panes`' own rendered inline
   *  `grid-template-columns` (App.vue's `panesStyle`) — a direct, black-box read of the values the
   *  drag gesture just computed. */
  function readPaneFr(wrapper: VueWrapper): { previewFr: number; canvasFr: number } {
    const style = wrapper.get('.panes').attributes('style') ?? '';
    const match = style.match(/grid-template-columns:\s*([\d.]+)fr 6px ([\d.]+)fr/);
    if (!match) throw new Error(`Could not parse a Preview|Canvas grid-template-columns from: "${style}"`);
    return { previewFr: Number(match[1]), canvasFr: Number(match[2]) };
  }

  async function drag(wrapper: VueWrapper, fromClientX: number, toClientX: number): Promise<void> {
    await wrapper.get('.resize-handle').trigger('pointerdown', { clientX: fromClientX });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: toClientX }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    await wrapper.vm.$nextTick();
  }

  it('clamps the Preview pane to exactly 30% of the total width when dragged far past that minimum', async () => {
    const wrapper = await mountApp(pinia);
    stubPanesWidth(wrapper, 1000);

    // A huge leftward drag (deltaPx = -1500) would push Preview's pixel width far below zero
    // without the clamp — it must settle at exactly 30% of the 1000px total (300px) instead.
    await drag(wrapper, 500, -1000);

    const { previewFr, canvasFr } = readPaneFr(wrapper);
    const previewPx = (previewFr / (previewFr + canvasFr)) * (1000 - 6);
    expect(previewPx).toBeCloseTo(300, 0);
  });

  it('clamps the Canvas pane to exactly 30% of the total width when dragged far past that minimum', async () => {
    const wrapper = await mountApp(pinia);
    stubPanesWidth(wrapper, 1000);

    // A huge rightward drag (deltaPx = +1500) would push Canvas's pixel width far below zero
    // without the clamp — it must settle at exactly 30% of the 1000px total (300px) instead.
    await drag(wrapper, 500, 2000);

    const { previewFr, canvasFr } = readPaneFr(wrapper);
    const canvasPx = (canvasFr / (previewFr + canvasFr)) * (1000 - 6);
    expect(canvasPx).toBeCloseTo(300, 0);
  });

  it('scales the 30% floor with the container width rather than using a fixed pixel minimum', async () => {
    const wrapper = await mountApp(pinia);
    stubPanesWidth(wrapper, 2000);

    await drag(wrapper, 500, -3000);

    const { previewFr, canvasFr } = readPaneFr(wrapper);
    const previewPx = (previewFr / (previewFr + canvasFr)) * (2000 - 6);
    // 30% of a 2000px container (600px) — not the old fixed 200px floor.
    expect(previewPx).toBeCloseTo(600, 0);
  });

  // d75a6c2: the resize handle is a role="separator" with no native semantics of its own for
  // "how far dragged" — aria-valuenow/min/max make that state available to assistive tech, and
  // must track the live drag, not just a static initial render.
  it('exposes aria-valuenow/min/max, and aria-valuenow updates live as the handle is dragged', async () => {
    const wrapper = await mountApp(pinia);
    stubPanesWidth(wrapper, 1000);

    const handle = wrapper.get('.resize-handle');
    expect(handle.attributes('aria-valuemin')).toBe('0');
    expect(handle.attributes('aria-valuemax')).toBe('100');
    const before = Number(handle.attributes('aria-valuenow'));
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(100);

    // A huge leftward drag toward Preview's 30%-of-container floor (same gesture as the clamp
    // test above) — aria-valuenow must reflect the new, dragged-to ratio, not the pre-drag one.
    await drag(wrapper, 500, -1000);

    const after = Number(wrapper.get('.resize-handle').attributes('aria-valuenow'));
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(30, 0);
  });
});

describe('App.vue — Preview/Editor visibility toggles (.actions-group)', () => {
  let pinia: Pinia;
  let currentWrapper: VueWrapper | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    currentWrapper?.unmount();
    currentWrapper = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // Mounted with `attachTo: document.body` (unlike the plain `mountApp` used by every other suite
  // in this file) — `.isVisible()` (used throughout this suite) walks the live computed-style
  // cascade up the ancestor chain, which jsdom only resolves reliably for elements actually
  // attached to `document`; the default detached-container mount `mountApp` uses is fine for every
  // other suite here since none of them call `.isVisible()`.
  async function mountAttachedApp(p: Pinia): Promise<VueWrapper> {
    currentWrapper = mount(App, { attachTo: document.body, global: { plugins: [p], stubs: STUBS } });
    await flushPromises();
    return currentWrapper;
  }

  function actionButton(wrapper: VueWrapper, label: string) {
    const button = wrapper.findAll('.actions-group button').find((btn) => btn.text() === label);
    if (!button) throw new Error(`Button "${label}" not found in .actions-group`);
    return button;
  }

  it('both panes are visible by default, each with a "Hide" toggle button', async () => {
    const wrapper = await mountAttachedApp(pinia);
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(true);
    expect(wrapper.findComponent(DocumentCanvas).isVisible()).toBe(true);
    expect(actionButton(wrapper, 'Hide preview').exists()).toBe(true);
    expect(actionButton(wrapper, 'Hide editor').exists()).toBe(true);
  });

  it('clicking "Hide preview" hides only the Preview pane — Canvas/editor/sidebar stay fully visible — expands Canvas onto the freed grid track, and persists the preference', async () => {
    const wrapper = await mountAttachedApp(pinia);

    await actionButton(wrapper, 'Hide preview').trigger('click');

    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(false);
    // Bug 2 regression check: hiding Preview must not collapse/hide Canvas (the grid
    // auto-placement bug used to shift Canvas into Preview's own 0-width track).
    expect(wrapper.findComponent(DocumentCanvas).isVisible()).toBe(true);
    expect(wrapper.findComponent(DocumentCanvas).props('editorVisible')).toBe(true);
    expect(wrapper.get('.panes').attributes('style') ?? '').toMatch(/grid-template-columns:\s*0fr 0px [\d.]+fr/);
    expect(localStorage.getItem('raidr:previewVisible')).toBe('false');

    // The button relabels to "Show preview" and toggles back.
    await actionButton(wrapper, 'Show preview').trigger('click');
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(true);
    expect(localStorage.getItem('raidr:previewVisible')).toBe('true');
  });

  it('clicking "Hide editor" leaves the Canvas pane (and its conversation sidebar) visible, only flips the editorVisible prop, and expands Preview onto the freed grid track', async () => {
    const wrapper = await mountAttachedApp(pinia);

    await actionButton(wrapper, 'Hide editor').trigger('click');

    // Bug 1 fix: "Hide editor" must never hide the whole Canvas pane (editor + sidebar) — only
    // DocumentCanvas's own internal `editorVisible` prop flips, and its pane keeps rendering.
    expect(wrapper.findComponent(DocumentCanvas).isVisible()).toBe(true);
    expect(wrapper.findComponent(DocumentCanvas).props('editorVisible')).toBe(false);
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(true);
    // The outer Preview|Canvas grid split is untouched by this toggle — DocumentCanvas's own grid
    // column never collapses any more (only Preview's own track can).
    expect(wrapper.get('.panes').attributes('style') ?? '').toMatch(/grid-template-columns:\s*[\d.]+fr 6px [\d.]+fr/);
    expect(localStorage.getItem('raidr:editorVisible')).toBe('false');
  });

  it('disables (no-ops) the toggle that would hide the last visible one', async () => {
    const wrapper = await mountAttachedApp(pinia);
    await actionButton(wrapper, 'Hide preview').trigger('click');
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(false);

    const hideEditorButton = actionButton(wrapper, 'Hide editor');
    expect(hideEditorButton.attributes('disabled')).toBeDefined();

    await hideEditorButton.trigger('click');
    await flushPromises();

    // Still visible — clicking a disabled native button never even fires the handler, but this
    // also guards the underlying `toggleEditorVisible` no-op directly in case that changes.
    expect(wrapper.findComponent(DocumentCanvas).props('editorVisible')).toBe(true);
    expect(localStorage.getItem('raidr:editorVisible')).not.toBe('false');
  });

  it('restores a previously stored "hidden" preference on mount', async () => {
    localStorage.setItem('raidr:previewVisible', 'false');
    const wrapper = await mountAttachedApp(pinia);
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(false);
    expect(actionButton(wrapper, 'Show preview').exists()).toBe(true);
  });

  it('Ctrl+Alt+P and Ctrl+Alt+E toggle Preview/editor visibility respectively, without ever hiding the Canvas pane itself', async () => {
    const wrapper = await mountAttachedApp(pinia);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(PreviewComponent).isVisible()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(DocumentCanvas).isVisible()).toBe(true);
    expect(wrapper.findComponent(DocumentCanvas).props('editorVisible')).toBe(false);
  });
});

describe('App.vue — document.title reflects the loaded document (moved out of .toolbar-left)', () => {
  let pinia: Pinia;
  const originalTitle = document.title;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
    document.title = 'AI Document Review';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.title = originalTitle;
  });

  it('sets document.title to "<document title> - AI Document Review" once the document loads', async () => {
    await mountApp(pinia);
    expect(document.title).toBe('Test Document - AI Document Review');
  });

  it('no longer renders the document title anywhere inside .toolbar-left', async () => {
    const wrapper = await mountApp(pinia);
    expect(wrapper.get('.toolbar-left').text()).not.toContain('Test Document');
    expect(wrapper.find('.toolbar-left h1').exists()).toBe(false);
  });
});

// 9dbc077: an unreachable/erroring backend used to leave `!store.loaded` (a bare "Loading…") true
// forever, with no way for the user to know anything had gone wrong or to do anything about it.
describe('App.vue — initial-load timeout/retry', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('a rejected initial load shows the retry UI; clicking Retry re-invokes load and, once it succeeds, shows the document', async () => {
    vi.mocked(httpClient.getDocument).mockRejectedValueOnce(new Error('Network request failed'));

    const wrapper = mount(App, { global: { plugins: [pinia], stubs: STUBS } });
    await flushPromises();

    expect(httpClient.getDocument).toHaveBeenCalledTimes(1);
    const loadError = wrapper.get('.load-error');
    expect(loadError.text()).toContain('Network request failed');
    expect(loadError.get('button').text()).toBe('Retry');
    expect(wrapper.find('.toolbar').exists()).toBe(false);

    // The next call succeeds (the default mocked resolution from this file's top-level factory).
    await loadError.get('button').trigger('click');
    await flushPromises();

    expect(httpClient.getDocument).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.load-error').exists()).toBe(false);
    expect(wrapper.get('.toolbar').exists()).toBe(true);
  });

  it('an unreachable backend that never resolves times out (LOAD_TIMEOUT_MS) with a "couldn\'t reach the server" message', async () => {
    vi.useFakeTimers();
    vi.mocked(httpClient.getDocument).mockImplementationOnce(() => new Promise(() => {})); // never settles

    const wrapper = mount(App, { global: { plugins: [pinia], stubs: STUBS } });
    await vi.advanceTimersByTimeAsync(15_000);

    const loadError = wrapper.get('.load-error');
    expect(loadError.text()).toMatch(/couldn't reach the server/i);
  });
});

// 29a11a2: `documentStore.conflictMessage` (stores/document.ts) is set once a manual edit is
// rejected over a genuine baseRevision conflict (bf220af) — surfaced here as a dismissible banner
// rather than silently resyncing with no visible explanation.
describe('App.vue — conflictMessage banner', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is absent when conflictMessage is unset', async () => {
    const wrapper = await mountApp(pinia);
    expect(wrapper.find('.toolbar-conflict-banner').exists()).toBe(false);
  });

  it('renders the message once documentStore.conflictMessage is set, and Dismiss clears it', async () => {
    const wrapper = await mountApp(pinia);
    const documentStore = useDocumentStore();
    documentStore.conflictMessage = 'This document changed elsewhere while you were editing.';
    await wrapper.vm.$nextTick();

    const banner = wrapper.get('.toolbar-conflict-banner');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('This document changed elsewhere while you were editing.');

    await banner.get('[aria-label="Dismiss conflict notice"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(documentStore.conflictMessage).toBeNull();
    expect(wrapper.find('.toolbar-conflict-banner').exists()).toBe(false);
  });
});

// New: Ctrl+Alt+1..9 conversation-focus toggle. Ctrl+Alt+1/2 used to toggle Preview/Editor
// visibility (now Ctrl+Alt+P/E, covered above) — the freed digits now toggle focus for the Nth
// conversation in HudPanel.vue's own display order (`orderConversationsByAnchor`, honoring its
// Active-only/All filter), reusing the same `toggleFocus` add-if-room/remove-if-present toggle
// every other Focus entry point already shares. Same `WideResizeObserverStub`/`FOCUS_VIEW_STUBS`-
// style setup as the "auto-focus on branch" suite above (a real `ConversationDetailPanel` per
// focused id, `HudPanel` stubbed out so the HUD's own filter can be driven directly via its stub's
// `update:filter` emit) — this suite only cares about which conversations end up focused, not the
// HUD's own rendered rows.
describe('App.vue — Ctrl+Alt+1..9 conversation-focus toggle', () => {
  let pinia: Pinia;

  // Same "wide enough for the default cap (3) to apply in full" stub as the auto-focus-on-branch
  // suite above — see that suite's own doc comment for why `ResizeObserverStub`'s do-nothing
  // default isn't enough here.
  class WideResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback([{ contentRect: { width: 2000 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  const FOCUS_DIGIT_STUBS = {
    DocumentCanvas: true,
    PreviewComponent: true,
    HudPanel: true,
    HistoryPanel: true,
    KeyboardShortcutsDialog: true,
    HelpDialog: true,
    EditsList: true,
  };

  function conversationFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
    return {
      name: overrides.id,
      kind: 'branch',
      parentId: null,
      branchDepth: 1,
      status: 'idle',
      isPrimary: false,
      contextRevision: 1,
      isStale: false,
      pendingEditCount: 0,
      canEdit: true,
      canBranch: true,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      readOnly: false,
      anchorOrphaned: false,
      seedSelection: null,
      forkedFromMessageId: null,
      ...overrides,
    };
  }

  let currentWrapper: VueWrapper | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', WideResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    currentWrapper?.unmount();
    currentWrapper = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Mounts `App.vue` for real and seeds `conversationsStore.conversations` directly (same
   *  after-mount seeding as the auto-focus-on-branch suite's `mountFocusedApp`, since a fresh
   *  `conversationsStore.load()` from `onMounted` would otherwise clobber it).
   *
   *  Mounted with `attachTo: document.body` (same reason as the Preview/Editor visibility suite
   *  above) — `ConversationDetailPanel` is deliberately left out of `FOCUS_DIGIT_STUBS` (a real
   *  instance renders per focused id, marking its root `aria-modal="true"`), and `isOverlayOpen()`
   *  (a11y/keymap-registry.ts), which the digit shortcut consults, queries the real `document` —
   *  jsdom only surfaces that element to `document.querySelector` once the wrapper's tree is
   *  actually attached to `document.body`. A detached mount here would make every focused
   *  conversation invisible to `isOverlayOpen()`, silently hiding any regression where it wrongly
   *  treats that panel itself as a blocking overlay. */
  async function mountWithConversations(conversations: ConversationDto[]): Promise<VueWrapper> {
    const wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia], stubs: FOCUS_DIGIT_STUBS } });
    currentWrapper = wrapper;
    await flushPromises();
    const conversationsStore = useConversationsStore();
    conversationsStore.conversations = conversations;
    vi.spyOn(conversationsStore, 'loadDetail').mockResolvedValue(undefined);
    await flushPromises();
    return wrapper;
  }

  function focusedIds(wrapper: VueWrapper): string[] {
    return wrapper.findAllComponents(ConversationDetailPanel).map((p) => p.props('conversationId'));
  }

  function pressDigit(n: number): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: `Digit${n}`, ctrlKey: true, altKey: true }));
  }

  it('Ctrl+Alt+<N> focuses the Nth conversation in HUD display order', async () => {
    const conversations = [
      conversationFixture({ id: 'c1' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
    ];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(2);
    await flushPromises();

    expect(focusedIds(wrapper)).toEqual(['c2']);
  });

  // Regression test: `ConversationDetailPanel.vue`'s own root also carries `aria-modal="true"`
  // (needed for its `useFocusTrap`), so once conversation #1 is focused, its panel is itself an
  // element `isOverlayOpen()` (a11y/keymap-registry.ts) would find via a bare
  // `document.querySelector('[aria-modal="true"]')` — if that function didn't specifically exclude
  // `.conversation-detail-dialog`, this second press would wrongly be treated as "some other dialog
  // is open" and silently no-op, leaving c1 stuck focused forever. `mountWithConversations` attaches
  // to `document.body` specifically so this panel is reachable that way, matching how the real app
  // behaves.
  it('pressing the same digit again un-focuses that conversation (toggle off), even while that conversation\'s own focused panel is the only "modal" in the document', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual(['c1']);
    // Sanity-check the premise above: c1's panel is really in the live document, marked
    // `aria-modal="true"`, so a naive `isOverlayOpen()` really would see it.
    expect(document.querySelector('.conversation-detail-dialog[aria-modal="true"]')).not.toBeNull();

    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual([]);
  });

  // Regression test for a real-app-only gap `pressDigit`'s `document.dispatchEvent(...)` above
  // can't exercise: a genuine keyboard `keydown` is dispatched on `document.activeElement` and
  // bubbles up from there, so its `event.target` is whatever element actually has focus — not
  // `document` itself. `useFocusTrap` (a11y/focus-manager.ts) moves focus *into* a conversation's
  // panel (onto its "Close full view" button) the instant that panel becomes the
  // most-recently-interacted one, i.e. immediately after the first Ctrl+Alt+<N> press focuses it.
  // So the very next Ctrl+Alt+<N> keypress meant to un-focus it has a target sitting inside
  // `.conversation-detail-dialog`, unlike this suite's other tests, whose synthetic
  // `document.dispatchEvent(...)` gives `isEditingContext` (a11y/keymap-registry.ts) a target
  // (`document`) with no `.closest` method, so its `[aria-modal="true"]` check is never actually
  // reached. This test focuses the real close button and dispatches the keydown on it instead, to
  // reach that check for real.
  it('still un-focuses a conversation on the second press when the event target is the focused element inside that conversation\'s own panel (matching real post-focus-trap keyboard focus)', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual(['c1']);

    const dialog = document.querySelector('.conversation-detail-dialog');
    expect(dialog).not.toBeNull();
    const closeButton = dialog!.querySelector<HTMLElement>('.close-detail-button');
    expect(closeButton).not.toBeNull();
    closeButton!.focus();
    expect(document.activeElement).toBe(closeButton);

    closeButton!.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true, altKey: true, bubbles: true }),
    );
    await flushPromises();

    expect(focusedIds(wrapper)).toEqual([]);
  });

  it('is a no-op when fewer than N conversations are visible', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(5);
    await flushPromises();

    expect(focusedIds(wrapper)).toEqual([]);
  });

  it('never adds a new focus once the live focus cap is reached, but un-focusing an already-focused one still works', async () => {
    const conversations = [
      conversationFixture({ id: 'c1' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
      conversationFixture({ id: 'c4' }),
    ];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(1);
    await flushPromises();
    pressDigit(2);
    await flushPromises();
    pressDigit(3);
    await flushPromises();
    expect(focusedIds(wrapper).sort()).toEqual(['c1', 'c2', 'c3']);

    // Cap (3, the default) already reached — c4 isn't focused yet, so Ctrl+Alt+4 is a no-op.
    pressDigit(4);
    await flushPromises();
    expect(focusedIds(wrapper).sort()).toEqual(['c1', 'c2', 'c3']);

    // But un-focusing an already-focused conversation is never blocked by the cap.
    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper).sort()).toEqual(['c2', 'c3']);
  });

  it('is a no-op while any modal dialog is open, not just App.vue\'s own tracked History/Help/shortcuts dialogs', async () => {
    const conversations = [conversationFixture({ id: 'c1' })];
    const wrapper = await mountWithConversations(conversations);

    // A bare `aria-modal="true"` element anywhere in the document — standing in for the History
    // panel's diff view, the Help/Keyboard-shortcuts dialogs, or a busy-switch/close-confirmation
    // dialog, all of which mark their own root this same way (see `isOverlayOpen`,
    // a11y/keymap-registry.ts) — is enough to block the shortcut, with no need to plumb each
    // dialog's own open/closed state into this test.
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlay);

    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual([]);

    overlay.remove();
    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual(['c1']);
  });

  // Bug fix regression test: before this fix, `focus-toggle-<N>` bindings left `composerExempt`
  // unset (`false`) in `HOTKEY_BINDINGS` (a11y/keymap-registry.ts), so `isEditingContext`'s blanket
  // "any textarea is an editing context" rule silently swallowed every Ctrl+Alt+<N> keypress typed
  // from inside a conversation composer's own textarea — exactly the place a user is most likely to
  // press it (e.g. to un-focus/close the panel they're currently typing in). Dispatched on the real
  // composer element (not `document`) so `isEditingContext`'s `target.closest`/`allowComposer` path
  // is actually exercised, matching how a real keypress while typing reaches this handler.
  it('fires from inside a conversation composer textarea, un-focusing the conversation currently being typed in', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual(['c1']);

    const composer = document.querySelector<HTMLTextAreaElement>('#composer-c1');
    expect(composer).not.toBeNull();
    composer!.focus();
    composer!.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true, altKey: true, bubbles: true }),
    );
    await flushPromises();

    expect(focusedIds(wrapper)).toEqual([]);
  });

  // Same scenario, but focusing (not un-focusing) a *different* conversation than the one currently
  // being typed in — the other half of "toggle" this composer-exempt fix must preserve.
  it('fires from inside a conversation composer textarea to focus a different conversation', async () => {
    const conversations = [
      conversationFixture({ id: 'c1' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
    ];
    const wrapper = await mountWithConversations(conversations);

    pressDigit(1);
    await flushPromises();
    expect(focusedIds(wrapper)).toEqual(['c1']);

    const composer = document.querySelector<HTMLTextAreaElement>('#composer-c1');
    expect(composer).not.toBeNull();
    composer!.focus();
    composer!.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true, bubbles: true }),
    );
    await flushPromises();

    expect(focusedIds(wrapper).sort()).toEqual(['c1', 'c2']);
  });

  it("respects the HUD's Active-only filter, skipping closed conversations when numbering", async () => {
    const conversations = [
      conversationFixture({ id: 'c1', status: 'closed' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
    ];
    const wrapper = await mountWithConversations(conversations);

    // HudPanel.vue is stubbed here — drive its own `update:filter` emit directly (App.vue's
    // `@update:filter="conversationFilter = $event"`), the same way other suites in this file
    // reach through a stubbed component's emits (e.g. the auto-focus suite's `canvas.vm.$emit`).
    wrapper.findComponent(HudPanel).vm.$emit('update:filter', 'active');
    await wrapper.vm.$nextTick();

    pressDigit(1);
    await flushPromises();
    // With the closed `c1` filtered out, "1st" is now `c2`.
    expect(focusedIds(wrapper)).toEqual(['c2']);
  });
});

// Hotkey-consolidation refactor (Phase B): the History toggle moved from the bare Ctrl+Alt+H to
// Ctrl+Alt+Shift+H, freeing Ctrl+Alt+H for the new cycle-focused-conversations shortcut (its own
// suite below).
describe('App.vue — History panel toggle moved to Ctrl+Alt+Shift+H', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function historyButton(wrapper: VueWrapper) {
    const btn = wrapper
      .findAll('.actions-col-buttons button')
      .find((b) => b.text() === 'History' || b.text() === 'Hide history');
    if (!btn) throw new Error('History button not found in .actions-group');
    return btn;
  }

  it('Ctrl+Alt+Shift+H opens and closes the History panel', async () => {
    const wrapper = await mountApp(pinia);
    expect(historyButton(wrapper).text()).toBe('History');

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true, shiftKey: true }));
    await wrapper.vm.$nextTick();
    expect(historyButton(wrapper).text()).toBe('Hide history');

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true, shiftKey: true }));
    await wrapper.vm.$nextTick();
    expect(historyButton(wrapper).text()).toBe('History');
  });

  it('the bare Ctrl+Alt+H (no Shift) no longer toggles the History panel', async () => {
    const wrapper = await mountApp(pinia);
    expect(historyButton(wrapper).text()).toBe('History');

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect(historyButton(wrapper).text()).toBe('History');
  });
});

// New feature: cycle-focused-conversations (Ctrl+Alt+H/Ctrl+Alt+ArrowLeft for previous,
// Ctrl+Alt+L/Ctrl+Alt+ArrowRight for next) — moves which already-focused conversation panel is
// "active" (App.vue's `lastInteractedId`) among `orderedFocusedConversations`, wrapping at both
// ends, without adding/removing any focused panel. Same `WideResizeObserverStub`/real-
// `ConversationDetailPanel` setup as the Ctrl+Alt+1..9 suite above (this feature's primary use case
// — firing from inside an already-focused conversation's own composer — needs a real, attached
// `ConversationDetailPanel`/`ConversationView`, not a stub).
describe('App.vue — cycle-focused-conversations hotkey (Ctrl+Alt+H/L, Ctrl+Alt+ArrowLeft/Right)', () => {
  let pinia: Pinia;

  class WideResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback([{ contentRect: { width: 2000 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  const CYCLE_STUBS = {
    DocumentCanvas: true,
    PreviewComponent: true,
    HudPanel: true,
    HistoryPanel: true,
    KeyboardShortcutsDialog: true,
    HelpDialog: true,
    EditsList: true,
  };

  function conversationFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
    return {
      name: overrides.id,
      kind: 'branch',
      parentId: null,
      branchDepth: 1,
      status: 'idle',
      isPrimary: false,
      contextRevision: 1,
      isStale: false,
      pendingEditCount: 0,
      canEdit: true,
      canBranch: true,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      readOnly: false,
      anchorOrphaned: false,
      seedSelection: null,
      forkedFromMessageId: null,
      ...overrides,
    };
  }

  let currentWrapper: VueWrapper | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', WideResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
  });

  afterEach(() => {
    currentWrapper?.unmount();
    currentWrapper = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Mounts `App.vue` for real (attached to `document.body` — this feature's composer-origin
   *  firing and composer-focus-after-switch both need the real DOM), seeds conversations, then
   *  focuses each of `focusedIds` in turn via the same Ctrl+Alt+<N> digit shortcut the
   *  Ctrl+Alt+1..9 suite above drives (so `lastInteractedId` ends up on the last id in the list,
   *  same as a user clicking/focusing them in that order would). */
  async function mountWithFocused(conversations: ConversationDto[], focusedIds: string[]): Promise<VueWrapper> {
    const wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia], stubs: CYCLE_STUBS } });
    currentWrapper = wrapper;
    await flushPromises();
    const conversationsStore = useConversationsStore();
    conversationsStore.conversations = conversations;
    vi.spyOn(conversationsStore, 'loadDetail').mockResolvedValue(undefined);
    await flushPromises();
    for (const id of focusedIds) {
      const digit = conversations.findIndex((c) => c.id === id) + 1;
      document.dispatchEvent(new KeyboardEvent('keydown', { code: `Digit${digit}`, ctrlKey: true, altKey: true }));
      await flushPromises();
    }
    return wrapper;
  }

  function activeConversationId(wrapper: VueWrapper): string | undefined {
    return wrapper.findAllComponents(ConversationDetailPanel).find((p) => p.props('active'))?.props('conversationId');
  }

  function pressCycle(code: string, extra: Partial<KeyboardEventInit> = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { code, ctrlKey: true, altKey: true, ...extra }));
  }

  it('Ctrl+Alt+L (and Ctrl+Alt+ArrowRight, Ctrl+Alt+N) focuses the next currently-focused panel, wrapping from the last back to the first', async () => {
    const conversations = [
      conversationFixture({ id: 'c1' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
    ];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2', 'c3']);
    expect(activeConversationId(wrapper)).toBe('c3');

    pressCycle('KeyL');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c1'); // wraps from the last (c3) to the first

    pressCycle('ArrowRight');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c2');

    pressCycle('KeyN');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c3');
  });

  // Bug investigation regression test: a real user reported Ctrl+Alt+L not advancing to the next
  // panel while Ctrl+Alt+H (previous) worked. Thorough investigation (binding definition, App.vue's
  // dispatch table, registry-wide collision check, a byte-level scan for a stray typo/whitespace in
  // the `code` string, and reproducing from both a `document` target and a real composer target —
  // see the suite above and below) found no in-app defect: `cycle-conversation-next`'s `code` is a
  // clean `'KeyL'` with no collision anywhere in `HOTKEY_BINDINGS`, and its handler
  // (`cycleFocusedConversation(1)`) is exactly as symmetric with `cycle-conversation-prev`'s
  // `cycleFocusedConversation(-1)` as the passing suite above already demonstrates. The most
  // consistent explanation left is that the user's OS/window manager claims the bare Ctrl+Alt+L
  // combo itself before it ever reaches the browser (see the `cycle-conversation-next-alt` binding's
  // own doc comment in keymap-registry.ts) — unfixable by this app's own keydown handler, since the
  // event never arrives. This test locks in that the in-app dispatch for `KeyL` is correct (so any
  // *future* regression here is still caught), and the tests below cover the new Ctrl+Alt+N alternate
  // this fix adds as a guaranteed-reachable fallback.
  it('regression: KeyL is defined once, with no registry collision, and its handler is symmetric with KeyH\'s', () => {
    const keyLBindings = HOTKEY_BINDINGS.filter((b) => b.code === 'KeyL');
    expect(keyLBindings).toHaveLength(1);
    expect(keyLBindings[0]).toMatchObject({
      id: 'cycle-conversation-next',
      modifiers: { ctrl: true, alt: true, shift: false },
      composerExempt: true,
    });
    expect(findConflicts(HOTKEY_BINDINGS)).toEqual([]);
  });

  it('Ctrl+Alt+H (and Ctrl+Alt+ArrowLeft) focuses the previous currently-focused panel, wrapping from the first back to the last', async () => {
    const conversations = [
      conversationFixture({ id: 'c1' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
    ];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2', 'c3']);
    expect(activeConversationId(wrapper)).toBe('c3');

    pressCycle('KeyH');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c2');

    pressCycle('ArrowLeft');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c1');

    pressCycle('KeyH');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c3'); // wraps from the first back to the last
  });

  // Bug fix: with *zero* focused conversations this hotkey used to be a dead no-op — pressing
  // Ctrl+Alt+L/N/H with nothing open did nothing, even though there's an obvious, unambiguous
  // action to take ("focus something"). It now falls back to focusing the first conversation in
  // the same HUD-ordered list Ctrl+Alt+1 targets. With exactly one focused conversation it's still
  // correctly a no-op — there's nothing else to cycle to.
  it('focuses the first conversation when none are focused, and is a no-op with exactly one focused', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapperNone = await mountWithFocused(conversations, []);
    pressCycle('KeyL');
    await flushPromises();
    expect(activeConversationId(wrapperNone)).toBe('c1');

    const wrapperOne = await mountWithFocused(conversations, ['c1']);
    pressCycle('KeyL');
    await flushPromises();
    expect(activeConversationId(wrapperOne)).toBe('c1');
  });

  it('fires from inside a conversation composer textarea — its primary trigger point — despite the blanket editing-context guard', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2']);
    expect(activeConversationId(wrapper)).toBe('c2');

    const composer = document.querySelector<HTMLTextAreaElement>('#composer-c2');
    expect(composer).not.toBeNull();
    composer!.focus();
    composer!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true, bubbles: true }));
    await flushPromises();

    expect(activeConversationId(wrapper)).toBe('c1');
  });

  // Bug 2 investigation: the "previous" direction above only ever exercised KeyH from a real
  // composer target — there was no equivalent test dispatching Ctrl+Alt+L (the reported-broken
  // "next" key) from a real element (only from `document`, in the wrapping test above). Adding it
  // closes that gap: this passes on the current code (confirming the in-app dispatch for KeyL, from
  // exactly the scenario a real user hits while typing, is correct — see the "regression: KeyL is
  // defined once..." test above for why the real bug lives outside this app's own code), and
  // Ctrl+Alt+N (this fix's new alternate) is exercised the same way right after.
  it('KeyL and its new KeyN alternate both fire from inside a conversation composer textarea', async () => {
    const conversations = [
      conversationFixture({ id: 'c1' }),
      conversationFixture({ id: 'c2' }),
      conversationFixture({ id: 'c3' }),
    ];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2', 'c3']);
    expect(activeConversationId(wrapper)).toBe('c3');

    let composer = document.querySelector<HTMLTextAreaElement>('#composer-c3');
    expect(composer).not.toBeNull();
    composer!.focus();
    composer!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true }));
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c1'); // wraps from the last (c3) to the first

    composer = document.querySelector<HTMLTextAreaElement>('#composer-c1');
    expect(composer).not.toBeNull();
    composer!.focus();
    composer!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', ctrlKey: true, altKey: true, bubbles: true }));
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c2');
  });

  it('does not fire while any modal dialog is open', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2']);
    expect(activeConversationId(wrapper)).toBe('c2');

    const overlay = document.createElement('div');
    overlay.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlay);

    pressCycle('KeyL');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c2');

    overlay.remove();
    pressCycle('KeyL');
    await flushPromises();
    expect(activeConversationId(wrapper)).toBe('c1');
  });

  it('does not fire from the document editor (a contenteditable surface)', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2']);
    expect(activeConversationId(wrapper)).toBe('c2');

    const editorEl = document.createElement('div');
    Object.defineProperty(editorEl, 'isContentEditable', { value: true });
    document.body.appendChild(editorEl);
    editorEl.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true }));
    await flushPromises();

    expect(activeConversationId(wrapper)).toBe('c2');
    editorEl.remove();
  });

  it('does not fire from the conversation-rename input', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2']);
    expect(activeConversationId(wrapper)).toBe('c2');

    const c2Panel = wrapper.findAllComponents(ConversationDetailPanel).find((p) => p.props('conversationId') === 'c2')!;
    await c2Panel.get('.thread-rename-button').trigger('click');
    await flushPromises();

    const nameInput = document.querySelector<HTMLInputElement>('.thread-title-input');
    expect(nameInput).not.toBeNull();
    nameInput!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true }));
    await flushPromises();

    expect(activeConversationId(wrapper)).toBe('c2');
  });

  // Composer-focus-after-switch: `useFocusTrap`'s `getPreferredInitialFocus` (focus-manager.ts),
  // wired up by `ConversationDetailPanel.vue`, moves keyboard focus into the newly-active panel's
  // own composer textarea rather than its "Close full view" button — both when a panel is first
  // focused and when cycling moves `lastInteractedId` to a different, already-focused panel.
  it('moves keyboard focus into the composer (not the close button) when a panel is first focused', async () => {
    const conversations = [conversationFixture({ id: 'c1' })];
    await mountWithFocused(conversations, ['c1']);
    await flushPromises();

    expect(document.activeElement?.id).toBe('composer-c1');
  });

  it('moves keyboard focus into the newly-active panel\'s composer after cycling', async () => {
    const conversations = [conversationFixture({ id: 'c1' }), conversationFixture({ id: 'c2' })];
    const wrapper = await mountWithFocused(conversations, ['c1', 'c2']);
    expect(activeConversationId(wrapper)).toBe('c2');
    expect(document.activeElement?.id).toBe('composer-c2');

    pressCycle('KeyH');
    await flushPromises();

    expect(activeConversationId(wrapper)).toBe('c1');
    expect(document.activeElement?.id).toBe('composer-c1');
  });
});
