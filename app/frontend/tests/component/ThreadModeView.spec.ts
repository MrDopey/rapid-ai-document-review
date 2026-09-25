import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import ThreadModeView from '../../src/components/thread/ThreadModeView.vue';
import { useThreadStore } from '../../src/stores/thread.js';
import { useListItemsStore } from '../../src/stores/listItems.js';
import TodoParkingListsPanel from '../../src/components/TodoParkingListsPanel.vue';
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

  // Regression coverage for BOTH user-reported complaints about this HUD (see
  // `ThreadModeView.vue`'s own template/CSS doc comments for the full history), now fixed via the
  // same `.hud-bar-columns`/`.hud-bar-left`/`.hud-bar-right` split (style.css) canvas mode's own
  // toolbar uses — a literal shared ruleset, not a hand-copied look-alike:
  //  1. Original: the sticky `.thread-mode-hud` bar used to paint the visible box itself as a flat,
  //     full-viewport-bleed strip with no border/rounding/relationship to the narrower, centered,
  //     bordered `.thread-card` tree beneath it.
  //  2. Regression (from the first fix for #1): making the PAINTED box itself shrink to the tree's
  //     own content-driven width made the HUD read as "shrunk"/not covering the viewport for the
  //     common single-Thread case (confirmed visually via Playwright against canvas mode's own HUD,
  //     which stays full-width regardless of conversation count).
  // jsdom performs no real CSS layout, so none of this can assert actual rendered pixel widths —
  // these assertions only cover what jsdom CAN see: the wrapper elements exist, in the right
  // nesting, with the right classes. A real committed Playwright test
  // (`tests/e2e/thread-mode-hud.spec.ts`) covers the actual rendered-width regression this component
  // test structurally cannot.
  it('renders the shared HudPanel inside the left/right-split bar, nested inside the full-width sticky bar', () => {
    seedTree();
    const wrapper = mountView();
    const shell = wrapper.find('.thread-mode-hud');
    const columns = shell.find('.hud-bar-columns');
    expect(columns.exists()).toBe(true);
    const left = columns.find('.hud-bar-left');
    expect(left.exists()).toBe(true);
    expect(left.find('nav.hud-panel').exists()).toBe(true);
    // The outer bar itself must not also carry the inner split's class — they're deliberately two
    // distinct elements (full-width painted bar vs. the left/right-split content row it wraps), not
    // one dual-purpose element (that dual-purpose collapse is exactly what caused complaint #1).
    expect(shell.classes()).not.toContain('hud-bar-columns');
  });

  it('renders the Expand all/Export all/Done actions in the right-hand column, not the shared HUD header', () => {
    seedTree();
    const wrapper = mountView();
    // These document-wide actions no longer feed HudPanel's own `#actions` slot (`.hud-header`) —
    // they're sibling markup in `.hud-bar-right`, matching canvas mode's own HUD/Global-Actions
    // split (App.vue's `.hud-bar-left`/`.hud-bar-right`).
    const header = wrapper.find('.hud-header');
    expect(header.find('.thread-mode-bulk-toggle').exists()).toBe(false);
    const right = wrapper.find('.hud-bar-right');
    expect(right.find('.thread-mode-bulk-toggle').exists()).toBe(true);
    expect(right.find('.thread-mode-export-all').exists()).toBe(true);
    expect(right.find('.thread-mode-export-all').text()).toBe('Export all');
    expect(right.find('.thread-mode-done-toggle').text()).toContain('Done (0)');
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

  // Bug fix regression: before this fix, Ctrl+Alt+J/K silently did nothing while the keyboard
  // event's target was a Thread's own composer textarea — `HudPanel.vue`'s own `onGlobalKeydown`
  // never threaded a binding's `composerExempt` flag through to `isEditingContext` at all, and even
  // once it did, `isEditingContext`'s `allowComposer` id-prefix check only recognized canvas mode's
  // `composer-` prefix, not `ThreadComposer.vue`'s own `thread-composer-` one. Since a Thread's
  // composer is the one control a reviewer's cursor sits in most of the time in this mode (unlike
  // canvas mode, which has a separate, already-composer-exempt fallback hotkey), this made the
  // Ctrl+Alt+J/K hotkeys read as "not working" for their single most common real-world trigger
  // point. Dispatched with an explicit `target` (unlike the other tests here, which dispatch
  // targetless and rely on `isEditingContext`'s early-return for a target with no `.closest`) so
  // this actually exercises the composer-textarea branch.
  it('Ctrl+Alt+J still cycles the active thread while the keyboard event targets a Thread composer textarea', async () => {
    seedTree();
    const wrapper = mountView();

    const composerTextarea = wrapper.get('textarea[id^="thread-composer-"]').element;
    const event = new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: composerTextarea });
    document.dispatchEvent(event);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.thread-card[data-thread-id="root-1"]').classes()).toContain(
      'thread-card--active',
    );
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

  // Regression fix (report: focusing a message from the Todo/Parking Lot rail, HUD, or a hotkey,
  // then starting work in a DIFFERENT thread, left the reviewer unable to "refocus" the first
  // thread via any of those same normal means): re-selecting an ALREADY-active thread used to be a
  // silent no-op — `threadFocus.jumpTo` reassigning `activeThreadId` to its own current value never
  // fires a `watch`, so the scroll/composer-focus step this view drove off that watch never ran a
  // second time. Fixed by moving that step to an imperative call at every jump entry point
  // (`scrollActiveThreadIntoView`), the same pattern canvas mode's `onHudToggleFocus`/
  // `onHudCycleFocus` already use (calling `scrollBoxIntoView`/`scrollComposerIntoView` directly,
  // never via a `watch`).
  it("re-clicking an already-active thread's HUD row re-scrolls/re-focuses it (not a silent no-op)", async () => {
    seedTree();
    const wrapper = mountView();

    await wrapper.find('.conversation-row[data-conversation-id="root-1"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.thread-card[data-thread-id="root-1"]').classes()).toContain(
      'thread-card--active',
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    // Simulates the reported scenario: the reviewer has since interacted elsewhere (moving DOM
    // focus away, though nothing in this view ever moves `activeThreadId` off `root-1` on its
    // own), then tries the exact same HUD click again to come back.
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    (document.activeElement as HTMLElement | null)?.blur();

    await wrapper.find('.conversation-row[data-conversation-id="root-1"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.thread-card[data-thread-id="root-1"]').classes()).toContain(
      'thread-card--active',
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('thread-composer-root-1');
  });

  it('the exposed jumpToIndex accessor also re-scrolls/re-focuses an already-active thread on a repeat call', async () => {
    seedTree();
    const wrapper = mountView();

    wrapper.vm.jumpToIndex(0);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    wrapper.vm.jumpToIndex(0);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  // Bug fix (parity with canvas mode's `ConversationDetailPanel.vue`, whose `useFocusTrap` +
  // `getPreferredInitialFocus` moves DOM focus into a conversation's own `#composer-<id>` the
  // moment it's activated): activating a thread here — via a HUD row click OR Ctrl+Alt+J/K — used
  // to only scroll/highlight the target `ThreadCard`, never move actual focus into its composer.
  describe("auto-focuses the activated thread's own composer", () => {
    it('on a HUD row click', async () => {
      seedTree();
      const wrapper = mountView();

      await wrapper.find('.conversation-row[data-conversation-id="branch-1"]').trigger('click');
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(document.activeElement?.id).toBe('thread-composer-branch-1');
    });

    it('on Ctrl+Alt+J cycling', async () => {
      seedTree();
      const wrapper = mountView();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
      );
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(document.activeElement?.id).toBe('thread-composer-root-1');
    });

    it("on the exposed jumpToIndex accessor (App.vue's Ctrl+Alt+<N> dispatch point)", async () => {
      seedTree();
      const wrapper = mountView();

      wrapper.vm.jumpToIndex(1);
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(wrapper.find('.thread-card[data-thread-id="branch-1"]').classes()).toContain(
        'thread-card--active',
      );
      expect(document.activeElement?.id).toBe('thread-composer-branch-1');
    });
  });

  // Bug fix regression: App.vue's Ctrl+Alt+1..9 numbered-jump used to unconditionally index into
  // canvas mode's own conversation list regardless of mode, so it silently did nothing in Thread
  // mode. `jumpToIndex` is the narrow accessor this view now exposes for App.vue to call instead
  // (mirroring `DocumentCanvas.vue`'s own precedent of exposing specific methods/refs).
  it('exposes jumpToIndex, a no-op out of range', async () => {
    seedTree();
    const wrapper = mountView();

    wrapper.vm.jumpToIndex(99);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.thread-card--active').exists()).toBe(false);
  });

  // User Story 3: reopening a thread from DoneThreadsPanel.vue's column layout must both close the
  // Done overlay and land the reviewer on that thread in the normal list (this view's own
  // `onThreadReopened`, wired to `DoneThreadsPanel`'s `@reopened` emit) — reusing the exact same
  // "jump the cursor to this thread" mechanism a HUD row click/hotkey already drives.
  describe('reopening a thread from the Done overlay', () => {
    function seedWithOneDone(): void {
      const store = useThreadStore();
      store.loaded = true;
      store.threads = [
        threadFixture({ id: 'root-1', name: 'Root Thread', createdAt: '2026-01-01T00:00:00.000Z' }),
        threadFixture({
          id: 'done-1',
          name: 'Done Thread',
          parentId: 'root-1',
          kind: 'thread-branch',
          forkedFromMessageId: 'r0',
          doneAt: '2026-01-02T00:00:00.000Z',
          createdAt: '2026-01-01T00:02:00.000Z',
        }),
      ];
      store.messagesByThread['root-1'] = [makeMessage('r0')];
      store.messagesByThread['done-1'] = [makeMessage('d0')];
    }

    it('closes the Done overlay and focuses the reopened thread in the main list', async () => {
      vi.mocked(httpClient.reopenThread).mockResolvedValue(undefined as never);
      seedWithOneDone();
      const wrapper = mountView();

      await wrapper.find('.thread-mode-done-toggle').trigger('click');
      await wrapper.vm.$nextTick();
      expect(wrapper.find('.done-threads-overlay').exists()).toBe(true);
      expect(wrapper.find('.done-thread-column[data-thread-id="done-1"]').exists()).toBe(true);

      const reopenButton = wrapper
        .findAll('.done-thread-column-actions button')
        .find((b) => b.text() === 'Reopen')!;
      await reopenButton.trigger('click');
      await flushPromises();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(wrapper.find('.done-threads-overlay').exists()).toBe(false);
      expect(wrapper.find('.thread-card[data-thread-id="done-1"]').classes()).toContain(
        'thread-card--active',
      );
      expect(document.activeElement?.id).toBe('thread-composer-done-1');
    });
  });

  // 012-todo-parking-lists follow-up: a linked Todo/Parking Lot item's `focus-link` emit
  // (`TodoParkingListsPanel.vue`, rendered unstubbed here via the rail) drives this view's own
  // `focusListItemLink` — active thread jumps via the existing cursor mechanism and scrolls to the
  // specific message; a done thread opens the read-only Done panel instead, without reopening it.
  describe('Todo/Parking Lot list-item link click-to-focus', () => {
    it('scrolls to the linked message inside the correct thread-card for an active thread', async () => {
      seedTree();
      const wrapper = mountView();
      useListItemsStore().todo = [
        {
          id: 'li_1',
          text: 'linked item',
          contentHash: 'h1',
          conversationId: 'branch-1',
          messageId: 'b0',
        },
      ];
      await wrapper.vm.$nextTick();

      const rail = wrapper.findComponent(TodoParkingListsPanel);
      rail.vm.$emit('focus-link', 'branch-1', 'b0');
      await flushPromises();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(wrapper.find('.thread-card[data-thread-id="branch-1"]').classes()).toContain(
        'thread-card--active',
      );
      const target = wrapper.find('.thread-card[data-thread-id="branch-1"] [data-message-id="b0"]');
      expect(target.exists()).toBe(true);
      expect((target.element as HTMLElement).style.scrollMarginTop).toBe('0px');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it('opens the read-only Done panel and scrolls to the message, without reopening a done thread', async () => {
      const store = useThreadStore();
      const reopenSpy = vi.spyOn(store, 'reopen');
      seedTree();
      store.threads.push(
        threadFixture({
          id: 'done-1',
          name: 'Done Thread',
          parentId: 'root-1',
          kind: 'thread-branch',
          forkedFromMessageId: 'r0',
          doneAt: '2026-01-02T00:00:00.000Z',
          createdAt: '2026-01-01T00:02:00.000Z',
        }),
      );
      store.messagesByThread['done-1'] = [makeMessage('d0')];
      // `focusListItemLink`'s done-thread branch always awaits a real `store.loadDetail` call
      // (011-linear-thread-mode's own lazy-load idempotency, mirrored here rather than mocking it
      // away) — give it something to resolve to.
      vi.mocked(httpClient.getThreadMessages).mockResolvedValue({
        conversation: store.threads.find((t) => t.id === 'done-1')!,
        messages: [
          {
            id: 'd0',
            role: 'assistant',
            text: 'done reply',
            createdAt: '2026-01-01T00:02:00.000Z',
          },
        ],
      });
      const wrapper = mountView();
      useListItemsStore().parkingLot = [
        {
          id: 'li_2',
          text: 'linked to a done thread',
          contentHash: 'h2',
          conversationId: 'done-1',
          messageId: 'd0',
        },
      ];
      await wrapper.vm.$nextTick();

      const rail = wrapper.findComponent(TodoParkingListsPanel);
      rail.vm.$emit('focus-link', 'done-1', 'd0');
      await flushPromises();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(wrapper.find('.done-threads-overlay').exists()).toBe(true);
      expect(reopenSpy).not.toHaveBeenCalled();
      const target = wrapper.find(
        '.done-thread-column[data-thread-id="done-1"] [data-message-id="d0"]',
      );
      expect(target.exists()).toBe(true);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });
});
