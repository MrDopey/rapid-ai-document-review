import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import ThreadModeView from '../../src/components/thread/ThreadModeView.vue';
import { useThreadStore } from '../../src/stores/thread.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';
import { httpClient, ApiError } from '../../src/transport/http-client.js';

// 011-linear-thread-mode: `ThreadModeView.vue` now mounts the shared `HudPanel.vue` (generalized
// from the canvas-only HUD it used to be exclusively) in place of its own former standalone
// `.thread-mode-toolbar`, driven by `threadFocusState.ts`'s single-cursor "active thread" model
// (see that module's own doc comment for why Thread mode has no real multi-focus set the way
// canvas mode does). This covers: the shared HUD renders correctly with Thread mode's own item
// list, Ctrl+Alt+J/K cycles the active thread and scrolls/highlights the matching `ThreadCard`, and
// a HUD row click jumps straight to that thread (Thread mode's `toggle-focus` === `cycle-focus`).

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listThreads: vi.fn(),
    getThreadMessages: vi.fn(),
    sendThreadMessage: vi.fn(),
    branchThread: vi.fn(),
    markThreadDone: vi.fn(),
    reopenThread: vi.fn(),
    exportDocumentSession: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status = 0;
    code = 'UNKNOWN';
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

// jsdom implements neither `Element.scrollIntoView` — same bug/gap other component tests
// (MessageBubble.spec.ts, ConversationView.spec.ts) already work around this same way.
Element.prototype.scrollIntoView = vi.fn();

function threadFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
  return {
    name: overrides.id,
    kind: 'thread-root',
    parentId: null,
    branchDepth: 0,
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
    seedSelection: null,
    anchorOrphaned: false,
    forkedFromMessageId: null,
    doneAt: null,
    seedExcerptText: null,
    ...overrides,
  };
}

function makeMessage(
  id: string,
  overrides: Partial<ConversationMessageState> = {},
): ConversationMessageState {
  return {
    id,
    role: 'assistant',
    text: `text for ${id}`,
    reasoning: null,
    isToolCallCarrier: false,
    toolCalls: [],
    streaming: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ThreadModeView — shared HudPanel + threadFocusState wiring', () => {
  let pinia: Pinia;
  let activeWrapper: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    // `mountView` below attaches to the real `document.body` (needed so the scroll-into-view
    // watcher's own `document.querySelector` — a real, global lookup, same as `App.vue`'s own
    // `scrollBoxIntoView` — can actually find the rendered `ThreadCard` elements; vue-test-utils'
    // default detached-fragment mount is invisible to `document.querySelector`). Unmounting here
    // keeps each test's own DOM out of the next test's `document.body`.
    activeWrapper?.unmount();
    activeWrapper = null;
    vi.clearAllMocks();
  });

  function seedTree(): void {
    const store = useThreadStore();
    store.loaded = true;
    store.threads = [
      threadFixture({
        id: 'root-1',
        name: 'Root Thread',
        kind: 'thread-root',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      threadFixture({
        id: 'branch-1',
        name: 'Branch Thread',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'r0',
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
    ];
    // Pre-seeded (not loaded via `loadDetail`) so `ThreadCard.vue`'s own `onMounted` guard never
    // issues a real request this test has no server for — same convention as `ThreadCard.spec.ts`.
    store.messagesByThread['root-1'] = [makeMessage('r0')];
    store.messagesByThread['branch-1'] = [makeMessage('b0')];
  }

  function mountView() {
    const wrapper = mount(ThreadModeView, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    activeWrapper = wrapper;
    return wrapper;
  }

  it('renders the shared HudPanel labeled "Threads", with no Active/All filter toggle, listing both threads', () => {
    seedTree();
    const wrapper = mountView();
    expect(wrapper.find('nav.hud-panel').attributes('aria-label')).toBe('Threads');
    expect(wrapper.find('.hud-panel h2').text()).toBe('Threads');
    expect(wrapper.find('.filter-toggle-button').exists()).toBe(false);
    expect(wrapper.findAll('.hud-panel .conversation-row .name').map((n) => n.text())).toEqual([
      'Root Thread',
      'Branch Thread',
    ]);
  });

  it('keeps the Expand all/Export all/Done actions inside the shared HUD header', () => {
    seedTree();
    const wrapper = mountView();
    const header = wrapper.find('.hud-header');
    expect(header.find('.thread-mode-bulk-toggle').exists()).toBe(true);
    expect(header.find('.thread-mode-export-all').exists()).toBe(true);
    expect(header.find('.thread-mode-export-all').text()).toBe('Export all');
    expect(header.find('.thread-mode-done-toggle').text()).toContain('Done (0)');
  });

  it('clicking "Export all" calls threadStore.exportDocumentSession and opens the result in a new tab', async () => {
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(httpClient.exportDocumentSession).mockResolvedValue('<html>exported</html>');

    seedTree();
    const wrapper = mountView();
    const exportButton = wrapper.find('.thread-mode-export-all');
    expect(exportButton.exists()).toBe(true);

    await exportButton.trigger('click');
    await flushPromises();

    expect(httpClient.exportDocumentSession).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('blob:mock-url', '_blank');

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('shows an inline error when "Export all" is refused as empty', async () => {
    vi.mocked(httpClient.exportDocumentSession).mockRejectedValue(
      new ApiError(409, 'EMPTY_DOCUMENT_EXPORT', 'empty'),
    );

    seedTree();
    const wrapper = mountView();
    await wrapper.find('.thread-mode-export-all').trigger('click');
    await flushPromises();

    expect(wrapper.find('.thread-mode-export-error').text()).toContain('nothing to export');
  });

  it('Ctrl+Alt+J cycles the active thread forward, highlighting and scrolling the matching ThreadCard', async () => {
    seedTree();
    const wrapper = mountView();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
    );
    // `ThreadModeView.vue`'s own `watch` handler schedules its `scrollIntoView` call inside a
    // further `nextTick` of its own (on top of the ref update's own `nextTick`-flushed DOM
    // update) — flush a few rounds of the microtask queue so both resolve before asserting.
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const rootCard = wrapper.find('.thread-card[data-thread-id="root-1"]');
    const branchCard = wrapper.find('.thread-card[data-thread-id="branch-1"]');
    expect(rootCard.classes()).toContain('thread-card--active');
    expect(branchCard.classes()).not.toContain('thread-card--active');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
    );
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.thread-card[data-thread-id="root-1"]').classes()).not.toContain(
      'thread-card--active',
    );
    expect(wrapper.find('.thread-card[data-thread-id="branch-1"]').classes()).toContain(
      'thread-card--active',
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('Ctrl+Alt+J wraps from the last thread back to the first', async () => {
    seedTree();
    const wrapper = mountView();
    const dispatchCycleNext = () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
      );

    dispatchCycleNext(); // -> root-1
    await wrapper.vm.$nextTick();
    dispatchCycleNext(); // -> branch-1
    await wrapper.vm.$nextTick();
    dispatchCycleNext(); // -> wraps back to root-1
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.thread-card[data-thread-id="root-1"]').classes()).toContain(
      'thread-card--active',
    );
  });

  it('clicking a HUD row jumps straight to that thread (toggle-focus behaves like cycle-focus in Thread mode)', async () => {
    seedTree();
    const wrapper = mountView();

    await wrapper.find('.conversation-row[data-conversation-id="branch-1"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.thread-card[data-thread-id="branch-1"]').classes()).toContain(
      'thread-card--active',
    );
  });
});
