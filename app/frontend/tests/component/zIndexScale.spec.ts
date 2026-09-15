import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ConversationDto,
  DocumentDto,
  GetDocumentResponse,
  ListConversationsResponse,
  RevisionDto,
  UserSettingsDto,
} from '@rapid-ai-document-review/shared/contracts/http';

// Guardrail for the z-index scale defined in style.css's `:root` (see the big comment there) —
// added alongside the fix for HistoryPanel.vue's `.diff-overlay`, which previously shipped with NO
// z-index at all and so silently resolved to `auto`, painting *underneath*
// EditorComponent.vue's sticky `.editor-toolbar` instead of above it. Every overlay/sticky element
// this app knows about should reference one of the `--z-*` custom properties instead of a bare
// number — this file asserts, for each one, that:
//   1. style.css's `:root` still defines every token this app relies on, with the value this test
//      (and the component using it) expects.
//   2. the real, currently-mounted element's own `z-index` declaration references that same token
//      (not a bare magic number, and not left unset/`auto`/`0`).
//
// Caveat: jsdom's computed-style implementation does not resolve `var(...)` expressions at all —
// `getComputedStyle(el).zIndex` returns the *literal, unresolved* declaration text (e.g.
// `"var(--z-overlay, 50)"`), not a number. That's actually fine for this guardrail's real purpose:
// a future regression that drops the z-index declaration entirely (exactly what happened to
// `.diff-overlay`) still resolves to the literal string `"auto"`, which every assertion below
// explicitly rules out — and parsing the returned token name catches a *wrong* token (e.g. reusing
// `--z-overlay` where `--z-overlay-detail` belongs) just as reliably as a real resolved number
// would.

const STYLE_CSS_PATH = resolve(__dirname, '../../src/style.css');

function readZTokens(): Record<string, number> {
  const css = readFileSync(STYLE_CSS_PATH, 'utf-8');
  const tokens: Record<string, number> = {};
  for (const match of css.matchAll(/(--z-[\w-]+):\s*(-?\d+)\s*;/g)) {
    tokens[match[1]] = Number(match[2]);
  }
  return tokens;
}

/** Parses a computed `zIndex` string that's either a plain number (if some future environment
 *  *does* resolve custom properties) or jsdom's literal `"var(--token, fallback)"` text, and
 *  asserts it references `expectedToken` with a fallback matching `expectedValue` — while also
 *  ruling out the exact failure mode this guardrail exists for (`auto`/`""`/`"0"`). */
function expectZIndexToken(raw: string, expectedToken: string, expectedValue: number): void {
  expect(raw).not.toBe('auto');
  expect(raw).not.toBe('');
  expect(raw).not.toBe('0');
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(-?\d+)\s*)?\)$/);
  if (varMatch) {
    expect(varMatch[1]).toBe(expectedToken);
    if (varMatch[2] !== undefined) expect(Number(varMatch[2])).toBe(expectedValue);
  } else {
    // A real environment that does resolve var() would land here with a plain numeric string.
    expect(Number(raw)).toBe(expectedValue);
  }
}

/** Parses a computed `zIndex` string (see `expectZIndexToken`'s own doc comment on jsdom's
 *  unresolved-`var()` quirk) and asserts its resolved value is strictly greater than every tier
 *  name in `tiersToBeat` — the invariant that actually matters for a "must render above X" overlay
 *  (must outrank --z-overlay-detail/--z-overlay-primary), without pinning the test to one specific
 *  token name/value the way `expectZIndexToken` does. */
function expectZIndexAbove(
  raw: string,
  tokens: Record<string, number>,
  tiersToBeat: string[],
): void {
  expect(raw).not.toBe('auto');
  expect(raw).not.toBe('');
  expect(raw).not.toBe('0');
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(-?\d+)\s*)?\)$/);
  const resolved = varMatch
    ? varMatch[2] !== undefined
      ? Number(varMatch[2])
      : tokens[varMatch[1]]
    : Number(raw);
  for (const tier of tiersToBeat) {
    expect(resolved).toBeGreaterThan(tokens[tier]);
  }
}

describe('z-index scale — style.css :root tokens', () => {
  const tokens = readZTokens();

  it.each([
    ['--z-raised', 1],
    ['--z-sticky', 2],
    ['--z-overlay', 50],
    ['--z-overlay-detail', 55],
    ['--z-overlay-primary', 60],
    ['--z-overlay-blocking', 70],
    ['--z-indicator', 1000],
  ])('defines %s: %i', (name, value) => {
    expect(tokens[name]).toBe(value);
  });
});

// One combined mock, covering every httpClient method any component mounted below might touch —
// vi.mock is hoisted per-file regardless of where it's written, so every describe block below
// shares this single mocked module (matching the rest of this suite's per-file convention of one
// httpClient mock serving several describe blocks, e.g. App.spec.ts).
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    getDocument: vi.fn(),
    listDocuments: vi.fn(),
    listConversations: vi.fn(),
    getSettings: vi.fn(),
    patchSettings: vi.fn(),
    getSystemPrompt: vi.fn(),
    getConversation: vi.fn(),
    listEdits: vi.fn(),
    previewEdit: vi.fn(),
    applyEdit: vi.fn(),
    dropEdit: vi.fn(),
    acceptRemaining: vi.fn(),
    dropRemaining: vi.fn(),
    discardConversation: vi.fn(),
    branchConversation: vi.fn(),
    renameConversation: vi.fn(),
    designatePrimary: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status = 0;
    code = 'UNKNOWN';
    details?: Record<string, unknown>;
    constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
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

import { httpClient } from '../../src/transport/http-client.js';
import { useConversationsStore } from '../../src/stores/conversations.js';
import { useDocumentStore } from '../../src/stores/document.js';
import ReconnectingIndicator from '../../src/components/hud/ReconnectingIndicator.vue';
import EditorComponent from '../../src/components/editor/EditorComponent.vue';
import ConversationDetailPanel from '../../src/components/conversation/ConversationDetailPanel.vue';
import ConversationThreadBox from '../../src/components/conversation/ConversationThreadBox.vue';
import HistoryPanel from '../../src/components/history/HistoryPanel.vue';
import EditsList from '../../src/components/edits/EditsList.vue';
import ConversationView from '../../src/components/conversation/ConversationView.vue';
import DocumentCanvas from '../../src/components/canvas/DocumentCanvas.vue';
import App from '../../src/App.vue';

function conversationFixture(
  overrides: Partial<ConversationDto> & { id: string },
): ConversationDto {
  return {
    name: overrides.id,
    kind: 'branch',
    parentId: 'main-1',
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

function makeRevision(overrides: Partial<RevisionDto> & { revision: number }): RevisionDto {
  return {
    source: 'user',
    origin: 'manual_debounce',
    conversationId: null,
    conversationName: null,
    stagedEditId: null,
    restoredFrom: null,
    note: null,
    autoApplied: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('z-index scale — cheaply-mounted real components reference the expected token', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it("ReconnectingIndicator.vue's .reconnecting-indicator uses --z-indicator", () => {
    const wrapper = mount(ReconnectingIndicator, { props: { reconnecting: true } });
    const el = wrapper.find('.reconnecting-indicator');
    expect(el.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(el.element).zIndex, '--z-indicator', 1000);
  });

  it("EditorComponent.vue's sticky .editor-toolbar uses --z-sticky", () => {
    const wrapper = mount(EditorComponent, { props: { modelValue: 'Hello world.' } });
    const el = wrapper.find('.editor-toolbar');
    expect(el.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(el.element).zIndex, '--z-sticky', 2);
  });

  it("ConversationDetailPanel.vue's .close-detail-button uses --z-raised", () => {
    const wrapper = mount(ConversationDetailPanel, {
      props: { conversationId: 'conv-1', active: true },
      global: { plugins: [pinia], stubs: { ConversationView: true } },
    });
    const el = wrapper.find('.close-detail-button');
    expect(el.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(el.element).zIndex, '--z-raised', 1);
  });

  it("ConversationThreadBox.vue's sticky .thread-header uses --z-raised", () => {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'conv-1', name: 'Conv One' })];
    store.messagesByConversation['conv-1'] = [];
    const wrapper = mount(ConversationThreadBox, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    const el = wrapper.find('.thread-header');
    expect(el.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(el.element).zIndex, '--z-raised', 1);
  });

  it("HistoryPanel.vue's .diff-overlay uses --z-overlay-blocking once the Diff modal is open", async () => {
    const store = useDocumentStore();
    store.revisions = [
      makeRevision({ revision: 2, createdAt: '2026-01-02T00:00:00.000Z' }),
      makeRevision({ revision: 1, origin: 'creation', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const wrapper = mount(HistoryPanel, {
      global: { plugins: [pinia], stubs: { RevisionDiffViewer: true } },
    });
    const row = wrapper.findAll('.history-entry').find((r) => r.find('strong').text() === 'v2');
    if (!row) throw new Error('no history-entry row found for revision 2');
    const diffButton = row
      .find('.actions')
      .findAll('button')
      .find((btn) => btn.text() === 'Diff');
    if (!diffButton) throw new Error('no Diff button found for revision 2');
    await diffButton.trigger('click');
    await flushPromises();

    const overlay = wrapper.find('.diff-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(overlay.element).zIndex, '--z-overlay-blocking', 70);
  });
});

describe('z-index scale — EditsList.vue .preview-overlay uses --z-overlay-blocking', () => {
  let pinia: Pinia;
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.previewEdit).mockReset();
  });

  afterEach(() => {
    // Same reason as EditsList.spec.ts's own equivalent: DiffViewer's `useFocusTrap` registers a
    // document-level keydown listener for as long as it's mounted.
    wrapper?.unmount();
    wrapper = null;
  });

  it('resolves --z-overlay-blocking once a preview is open', async () => {
    vi.mocked(httpClient.listEdits).mockResolvedValue({
      stagedEdits: [
        {
          id: 'edit-1',
          conversationId: 'conv-1',
          piToolCallId: 'tool-edit-1',
          summary: 'edit-1',
          sourceRevision: 1,
          status: 'pending',
          autoApplied: false,
          operationCount: 1,
          supersedesId: null,
          conflictDetail: null,
          appliedRevision: null,
          resolvedAt: null,
          createdAt: '2026-01-01T00:00:10.000Z',
        },
      ],
    });
    vi.mocked(httpClient.previewEdit).mockResolvedValue({
      stagedEditId: 'edit-1',
      reconcilable: true,
      fullPreview: 'full document text',
      hunks: [
        {
          operationIndex: 0,
          contextBefore: 'before',
          removed: 'old text',
          added: 'new text',
          contextAfter: 'after',
        },
      ],
      conflictDetail: null,
    });

    wrapper = mount(EditsList, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    await wrapper.get('[aria-label="Preview: edit-1"]').trigger('click');
    await flushPromises();

    const overlay = wrapper.find('.preview-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(overlay.element).zIndex, '--z-overlay-blocking', 70);
  });
});

describe('z-index scale — ConversationView.vue .close-dialog-overlay uses --z-overlay-primary', () => {
  let pinia: Pinia;

  // jsdom doesn't implement these — ConversationView.vue calls them on mount/message-change,
  // same stubs ConversationView.spec.ts uses for the same reason.
  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {};
  }
  Element.prototype.scrollIntoView = vi.fn();

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  it('resolves --z-overlay-primary once the Archive/close confirmation is open', async () => {
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1', kind: 'branch', status: 'idle' });
    store.conversations = [conversation];
    store.messagesByConversation['conv-1'] = [];
    // ConversationView.vue's onMounted unconditionally calls `store.loadDetail`, which hits this
    // directly (no guard to pre-seed around, unlike ConversationThreadBox.vue) — resolved so it
    // doesn't reject with an unhandled promise rejection during the test.
    vi.mocked(httpClient.getConversation).mockResolvedValue({ conversation, messages: [] });

    const wrapper = mount(ConversationView, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();

    await wrapper.get('[data-action="archive"]').trigger('click');
    await flushPromises();

    const overlay = wrapper.find('.close-dialog-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(overlay.element).zIndex, '--z-overlay-primary', 60);
  });
});

describe('z-index scale — ConversationThreadBox.vue .primary-busy-dialog-overlay uses --z-overlay-primary', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.designatePrimary).mockReset();
  });

  it('resolves --z-overlay-primary once the Primary-busy warning is open', async () => {
    const store = useConversationsStore();
    store.loaded = true;
    store.conversations = [
      conversationFixture({ id: 'active-1', kind: 'branch', status: 'idle', isPrimary: false }),
    ];
    store.messagesByConversation['active-1'] = [];
    vi.mocked(httpClient.designatePrimary).mockRejectedValue(
      new (await import('../../src/transport/http-client.js')).ApiError(
        409,
        'PRIMARY_TARGET_BUSY',
        'Primary conversation is busy',
        { currentPrimaryId: null, busyConversationId: 'active-1' },
      ),
    );

    // 006-toolbar-reorg (second refactor): the busy-switch dialog moved off the HUD's per-row
    // button (that list is purely informational now) onto `ConversationThreadBox.vue`'s own
    // Make/Clear Primary action button, via the shared `usePrimaryAction` composable.
    const wrapper = mount(ConversationThreadBox, {
      props: { conversationId: 'active-1' },
      global: { plugins: [pinia] },
    });

    await wrapper.get('[data-action="primary"]').trigger('click');
    await flushPromises();

    const overlay = wrapper.find('.primary-busy-dialog-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(overlay.element).zIndex, '--z-overlay-primary', 60);
  });
});

describe('z-index scale — App.vue overlays', () => {
  let pinia: Pinia;

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
    SystemPromptDialog: true,
  };

  async function mountApp(): Promise<VueWrapper> {
    const wrapper = mount(App, { global: { plugins: [pinia], stubs: STUBS } });
    await flushPromises();
    return wrapper;
  }

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(true);
    localStorage.clear();
    vi.mocked(httpClient.getDocument).mockReset().mockResolvedValue(getDocumentResponse);
    vi.mocked(httpClient.listDocuments)
      .mockReset()
      .mockResolvedValue({
        documents: [
          {
            id: documentFixture.id,
            title: documentFixture.title,
            isActive: true,
            lastActiveAt: documentFixture.updatedAt,
          },
        ],
      });
    vi.mocked(httpClient.listConversations)
      .mockReset()
      .mockResolvedValue(listConversationsResponse);
    vi.mocked(httpClient.getSettings).mockReset().mockResolvedValue(settingsFixture);
    vi.mocked(httpClient.patchSettings).mockReset().mockResolvedValue(settingsFixture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('.blocking-overlay outranks --z-overlay-detail/--z-overlay-primary once the shortcuts dialog is open', async () => {
    const wrapper = await mountApp();
    await wrapper.get('[aria-label="Keyboard shortcuts"]').trigger('click');
    await flushPromises();
    const overlay = wrapper.find('.blocking-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexAbove(getComputedStyle(overlay.element).zIndex, readZTokens(), [
      '--z-overlay-detail',
      '--z-overlay-primary',
    ]);
  });

  it('.blocking-overlay outranks --z-overlay-detail/--z-overlay-primary once the help dialog is open', async () => {
    const wrapper = await mountApp();
    await wrapper.get('[aria-label="Help"]').trigger('click');
    await flushPromises();
    const overlay = wrapper.find('.blocking-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexAbove(getComputedStyle(overlay.element).zIndex, readZTokens(), [
      '--z-overlay-detail',
      '--z-overlay-primary',
    ]);
  });

  it('.blocking-overlay outranks --z-overlay-detail/--z-overlay-primary once the system prompt dialog is open', async () => {
    const wrapper = await mountApp();
    await wrapper.get('[aria-label="System prompt"]').trigger('click');
    await flushPromises();
    const overlay = wrapper.find('.blocking-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexAbove(getComputedStyle(overlay.element).zIndex, readZTokens(), [
      '--z-overlay-detail',
      '--z-overlay-primary',
    ]);
  });

  it('.conversation-detail-overlay uses --z-overlay-detail once a conversation is focused', async () => {
    const wrapper = await mountApp();
    const conversationsStore = useConversationsStore();
    conversationsStore.conversations = [
      conversationFixture({ id: 'main-1', kind: 'main', parentId: null, branchDepth: 0 }),
    ];

    const canvas = wrapper.findComponent(DocumentCanvas);
    canvas.vm.$emit('toggle-focus', 'main-1');
    await flushPromises();

    const overlay = wrapper.find('.conversation-detail-overlay');
    expect(overlay.exists()).toBe(true);
    expectZIndexToken(getComputedStyle(overlay.element).zIndex, '--z-overlay-detail', 55);
  });
});
