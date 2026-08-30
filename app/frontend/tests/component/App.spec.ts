import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { DocumentDto, GetDocumentResponse, ListConversationsResponse, UserSettingsDto } from '@rapid-ai-document-review/shared/contracts/http';

// New feature: synchronized scrolling between the Editor and Preview panes. This covers the
// toolbar-level bits App.vue itself owns (per specs/005-canvas-conversation-threads' toolbar
// conventions — 006-toolbar-reorg's "Global Actions" box and its Ctrl+Alt+<letter> shortcuts, both
// documented in a11y/keymap-registry.ts): the "Sync scroll" checkbox's label/state in
// `.actions-group`, alongside "Show reasoning"/"History", and its Ctrl+Alt+Y shortcut — mirroring
// the existing Ctrl+Alt+R ("Show reasoning")/Ctrl+Alt+H ("History") shortcuts App.vue already
// implements the same way. The scroll-linking mechanics themselves (ratio mapping, feedback-loop
// guard) are covered directly in scrollSync.spec.ts; this file only covers the toggle's own
// UI/keyboard wiring, so the heavy panes (DocumentCanvas, PreviewComponent) and the toolbar's other
// boxes (HudPanel, PrimaryPanel) are stubbed out — nothing here exercises their internals.
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
  },
  ApiError: class ApiError extends Error {},
}));

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
  PrimaryPanel: true,
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

  it('renders unchecked by default, labeled "Sync scroll", alongside "Show reasoning" and "History" in .actions-group', async () => {
    const wrapper = await mountApp(pinia);
    const actionsGroup = wrapper.find('.actions-group');
    expect(actionsGroup.exists()).toBe(true);

    const labels = actionsGroup.findAll('.reasoning-toggle').map((el) => el.text());
    expect(labels).toEqual(['Show reasoning', 'Sync scroll']);
    expect(actionsGroup.text()).toContain('History');

    const checkbox = syncScrollCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  it('clicking the checkbox toggles the checked state', async () => {
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);

    await checkbox.setValue(true);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    await checkbox.setValue(false);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  it('Ctrl+Alt+Y toggles the checkbox, matching the Ctrl+Alt+R/Ctrl+Alt+H sibling shortcuts', async () => {
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, altKey: true }));
    await wrapper.vm.$nextTick();
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  it('ignores Ctrl+Alt+Y while focus is in an editing context (matching the sibling shortcuts\' guard)', async () => {
    const wrapper = await mountApp(pinia);
    const checkbox = syncScrollCheckbox(wrapper);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, altKey: true, bubbles: true }));
    await wrapper.vm.$nextTick();

    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
    input.remove();
  });
});
