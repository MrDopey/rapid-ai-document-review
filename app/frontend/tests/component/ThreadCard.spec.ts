import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import ThreadCard from '../../src/components/thread/ThreadCard.vue';
import ToolCallMessage from '../../src/components/conversation/ToolCallMessage.vue';
import { useThreadStore } from '../../src/stores/thread.js';
import { useSettingsStore } from '../../src/stores/settings.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';

// `ThreadCard.vue` never calls any of these directly in the scenarios below (messages/threads are
// seeded straight into the store, same convention as `ConversationThreadBox.spec.ts`, so its own
// `onMounted` guard skips a real `loadDetail()` call) — mocked only so importing `stores/thread.js`
// never risks touching a real network call.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listThreads: vi.fn(),
    getThreadMessages: vi.fn(),
    sendThreadMessage: vi.fn(),
    branchThread: vi.fn(),
    markThreadDone: vi.fn(),
    reopenThread: vi.fn(),
    retryThread: vi.fn(),
    renameThread: vi.fn(),
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

function threadFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
  return {
    name: overrides.id,
    kind: 'thread-root',
    parentId: null,
    branchDepth: 0,
    status: 'idle',
    isPrimary: false,
    isCurrentMain: false,
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

// jsdom's real `window.getSelection()` never reports a usable selection — `ThreadCard.vue`'s own
// `onMessageMouseUp` reads `toString()`/`rangeCount`/`getRangeAt(0).getBoundingClientRect()`, so
// this fakes exactly that shape rather than trying to drive a real text selection in jsdom.
function fakeSelection(text: string): Selection {
  return {
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 }),
    }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection;
}

async function selectTextInMessage(
  wrapper: ReturnType<typeof mount>,
  index: number,
  text = 'some highlighted text',
): Promise<void> {
  vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection(text));
  await wrapper.findAll('.thread-segment-message')[index]!.trigger('mouseup');
}

describe('ThreadCard — seed-message branch/quote gating', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('a root thread has no seed message — an earlier message still offers "Branch from here"', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];

    const wrapper = mountCard('root-1');
    await selectTextInMessage(wrapper, 0);

    expect(wrapper.find('.highlight-branch-menu').exists()).toBe(true);
    expect(wrapper.text()).toContain('Branch from here');
    expect(wrapper.text()).not.toContain('Quote from here');
  });

  it('a root thread\'s own tip message still offers "Quote from here"', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];

    const wrapper = mountCard('root-1');
    await selectTextInMessage(wrapper, 1);

    expect(wrapper.find('.highlight-branch-menu').exists()).toBe(true);
    expect(wrapper.text()).toContain('Quote from here');
    expect(wrapper.text()).not.toContain('Branch from here');
  });

  it("a selection inside a branch's own seed message (also its current tip) shows no popover at all", async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        seedExcerptText: 'the excerpt that seeded this branch',
      }),
    ];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('branch-1');
    await selectTextInMessage(wrapper, 0);

    expect(wrapper.find('.highlight-branch-menu').exists()).toBe(false);
  });

  it("a selection inside a branch's own seed message, once no longer the tip, still shows no popover", async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        seedExcerptText: 'the excerpt that seeded this branch',
      }),
    ];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0'), makeMessage('reply-1')];

    const wrapper = mountCard('branch-1');
    await selectTextInMessage(wrapper, 0);

    expect(wrapper.find('.highlight-branch-menu').exists()).toBe(false);
  });

  it('a branch\'s current tip message (not the seed) still offers "Quote from here"', async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        seedExcerptText: 'the excerpt that seeded this branch',
      }),
    ];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0'), makeMessage('reply-1')];

    const wrapper = mountCard('branch-1');
    await selectTextInMessage(wrapper, 1);

    expect(wrapper.find('.highlight-branch-menu').exists()).toBe(true);
    expect(wrapper.text()).toContain('Quote from here');
  });

  it('a branch\'s own earlier, non-seed message still offers "Branch from here" (seed exclusion is narrow)', async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        seedExcerptText: 'the excerpt that seeded this branch',
      }),
    ];
    store.messagesByThread['branch-1'] = [
      makeMessage('seed-0'),
      makeMessage('reply-1'),
      makeMessage('reply-2'),
    ];

    const wrapper = mountCard('branch-1');
    await selectTextInMessage(wrapper, 1);

    expect(wrapper.find('.highlight-branch-menu').exists()).toBe(true);
    expect(wrapper.text()).toContain('Branch from here');
    expect(wrapper.text()).not.toContain('Quote from here');
  });
});

describe('ThreadCard — per-thread "Expand all"/"Collapse all"', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('labels the bulk-toggle button "Expand all" while any of this thread\'s own messages is collapsed', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.expandedByMessage['root-1'] = { m0: false, m1: true };

    const wrapper = mountCard('root-1');
    const button = wrapper.find('[data-action="bulk-toggle"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toBe('Expand all');
  });

  it('clicking the bulk-toggle expands every message of THIS thread only, leaving another mounted thread untouched', async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({ id: 'root-2', kind: 'thread-root' }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.expandedByMessage['root-1'] = { m0: false, m1: true };
    // A second thread's own state, mounted elsewhere in the tree (not by this wrapper) — proves
    // the click below is scoped to just `root-1`, not `stores/thread.ts`'s document-wide toggle.
    store.messagesByThread['root-2'] = [makeMessage('m2')];
    store.expandedByMessage['root-2'] = { m2: false };

    const wrapper = mountCard('root-1');
    await wrapper.find('[data-action="bulk-toggle"]').trigger('click');

    expect(store.expandedByMessage['root-1']).toEqual({ m0: true, m1: true });
    expect(store.expandedByMessage['root-2']).toEqual({ m2: false });
    expect(wrapper.find('[data-action="bulk-toggle"]').text()).toBe('Collapse all');
  });

  it('clicking again collapses every message of this thread once all are expanded', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.expandedByMessage['root-1'] = { m0: true, m1: true };

    const wrapper = mountCard('root-1');
    await wrapper.find('[data-action="bulk-toggle"]').trigger('click');

    expect(store.expandedByMessage['root-1']).toEqual({ m0: false, m1: false });
  });
});

// Tool calls as their own message component (011-linear-thread-mode follow-up): a tool-call-carrier
// message inside a real Thread-mode transcript must render via `ToolCallMessage.vue`, with
// `data-message-id` present on its root — `composables/messageScroll.ts`'s
// `scrollMessageTopIntoView` depends on that exact selector for Thread mode's focus-jump hotkeys
// (Ctrl+Alt+J/K, fixed in `eba7130`), so a regression here would silently break that scroll target.
describe('ThreadCard — tool-call-carrier message renders via ToolCallMessage', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('renders a carrier message (with tool-call detail) via ToolCallMessage, carrying data-message-id', () => {
    useSettingsStore().settings = {
      thinkingVisible: false,
      revisionDebounceMs: 300_000,
      maxConcurrentAgents: 3,
      maxEditingDepth: 2,
      maxConversationDepth: 3,
      maxReplacementAttempts: 2,
      softWordCountThreshold: 20_000,
    };
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [
      makeMessage('m0'),
      makeMessage('tc-1', {
        text: '',
        isToolCallCarrier: true,
        toolCalls: [
          {
            toolCallId: 'tc_1',
            name: 'web_search',
            args: { query: 'x' },
            resultText: 'result',
            failureReason: null,
            stagedEditId: null,
          },
        ],
      }),
    ];
    store.expandedByMessage['root-1'] = { m0: true, 'tc-1': true };

    const wrapper = mountCard('root-1');

    const toolCallMessage = wrapper.findComponent(ToolCallMessage);
    expect(toolCallMessage.exists()).toBe(true);
    expect(toolCallMessage.props('message').id).toBe('tc-1');
    const root = wrapper.get('[data-message-kind="tool-call"]');
    expect(root.attributes('data-message-id')).toBe('tc-1');
  });
});

// Regression test for the bug fix described in `ThreadCard.vue`'s own `syncBranchAlignment` doc
// comment: `.thread-trunk` (the run-card chain) and `.thread-branches` (the branch column) are two
// independently-stacking flex columns with no CSS relationship between a `.thread-branch-group`'s
// position and the run-card it forked from — jsdom gives every element a zero-size
// `getBoundingClientRect()` by default (same caveat `App.spec.ts`/`DocumentCanvas.spec.ts` already
// document for their own layout-math tests), so this stubs the three elements the alignment math
// actually reads to prove the *arithmetic* itself is correct, not just that it runs without
// throwing. Since the Y-split redesign gives every forking segment its own dedicated `.thread-card`
// run-box (rather than one continuous box holding every segment), root-1's two segments (`m0`, the
// fork anchor, then `m1`, the tip) now render as TWO sibling `.thread-card`s inside one
// `.thread-trunk` — these tests stub the FIRST one's own bottom edge (the actual fork point) rather
// than a `.thread-segment` div's, matching what `syncBranchAlignment` itself now measures.
describe('ThreadCard — branch connector alignment (bug fix)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  function stubRect(el: Element, rect: Partial<DOMRect>): void {
    (el as HTMLElement).getBoundingClientRect = () => rect as DOMRect;
  }

  // `syncBranchAlignment` runs off a `requestAnimationFrame`/`setTimeout(cb, 0)`-scheduled callback
  // chained behind a `flush: 'post'` watcher's own `nextTick` — polling sidesteps having to
  // replicate that exact microtask/macrotask interleaving here.
  async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("nudges a branch group's margin-top so it lands level with the trunk segment it forked from", async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    // Let the initial (all-zero-rect) alignment pass run and settle before installing the stubs
    // below, so it can't race with — or mask — the assertions that follow.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Scoped to the ROOT thread's own `.thread-trunk` wrapper — the nested branch `ThreadCard`'s
    // own (sibling, not descendant, of the root's `.thread-trunk`) run-card(s) live under a
    // completely separate `.thread-branches` subtree, so an unscoped `wrapper.findAll` would
    // otherwise also pick those up.
    const trunkWrapper = wrapper.find('.thread-trunk');
    const trunkEl = trunkWrapper.element;
    const runCards = trunkWrapper.findAll('.thread-card');
    const groupEl = wrapper.find('.thread-branch-group').element;
    // One run-card ending at the fork anchor (m0), one for the tip segment (m1) — see `runs`' own
    // doc comment in `ThreadCard.vue`.
    expect(runCards.length).toBe(2);
    expect(groupEl).toBeTruthy();

    stubRect(trunkEl, { top: 100 } as DOMRect);
    // The forking run-card (ends at `m0`) sits far down the trunk (e.g. `m0` is a long message)…
    stubRect(runCards[0]!.element, { bottom: 500 } as DOMRect);
    // …while the branch column's own natural (un-nudged) stacking would put this group much higher.
    stubRect(groupEl, { top: 250 } as DOMRect);

    // Re-triggers `syncBranchAlignment` the same way a real expand/collapse toggle would (the
    // `watch([branchSegments, expandedByMessage], ...)` in `ThreadCard.vue`).
    await wrapper.find('[data-action="bulk-toggle"]').trigger('click');

    // target (run-card bottom, relative to trunk top) = 500 - 100 = 400
    // natural (group top, relative to trunk top) = 250 - 100 = 150
    // required nudge = 400 - 150 = 250px
    await waitFor(() => (groupEl as HTMLElement).style.marginTop === '250px');
    expect((groupEl as HTMLElement).style.marginTop).toBe('250px');
  });

  // Regression test for the "jiggle" bug: a naive implementation reset `margin-top` to `0px` before
  // every measurement, then wrote the real nudge back — two writes per pass, either of which changes
  // `.thread-branch-group`'s margin and so (since a flex column's auto height includes child
  // margins) `.thread-branches`' own rendered height, which is exactly what the `ResizeObserver`
  // below watches — a write-triggers-observer-triggers-write loop, made worse by `margin-top`'s own
  // `transition` restarting on every intermediate `0px` write. This proves the fix converges instead:
  // once a nudge is applied, re-running the exact same alignment pass against an UNCHANGED layout
  // (simulating the `ResizeObserver` re-firing itself, or any other spurious re-trigger) must not
  // write a different value — `style.marginTop` should hold steady, not oscillate — and must not
  // keep touching the style at all once converged, which is what actually breaks a real feedback
  // loop (a real browser only restarts the `transition`/re-fires `ResizeObserver` on an actual
  // change).
  it('converges instead of oscillating when re-run against an unchanged layout (no feedback loop)', async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const trunkWrapper = wrapper.find('.thread-trunk');
    const trunkEl = trunkWrapper.element;
    const runCards = trunkWrapper.findAll('.thread-card');
    const groupEl = wrapper.find('.thread-branch-group').element as HTMLElement;

    stubRect(trunkEl, { top: 100 } as DOMRect);
    stubRect(runCards[0]!.element, { bottom: 500 } as DOMRect);
    // Unlike the fixed-rect stubs the other two tests in this suite use, this one has to behave like
    // a REAL element's `getBoundingClientRect()` — i.e. move by however much `margin-top` currently
    // pushes it down — specifically so a second alignment pass over an unchanged layout re-measures
    // the group at its NEW (already-nudged) rendered position, the same way a real browser's layout
    // engine would after the previous pass's write actually took effect. A naive fixed-rect stub
    // can't exercise this regression at all: it would silently hide exactly the kind of
    // double-subtraction bug that made an earlier draft of this fix re-inflate `margin-top` by
    // another full nudge on every subsequent pass instead of converging.
    const groupNaturalTop = 250;
    groupEl.getBoundingClientRect = () =>
      ({ top: groupNaturalTop + (parseFloat(groupEl.style.marginTop) || 0) }) as DOMRect;

    await wrapper.find('[data-action="bulk-toggle"]').trigger('click');
    await waitFor(() => groupEl.style.marginTop === '250px');

    // Same rects, same story (nothing in the layout actually changed) — re-trigger alignment
    // several more times in a row, the way a self-triggering `ResizeObserver` would, and confirm the
    // margin never drifts away from its converged value (no oscillation) and no write is even
    // attempted once converged (a real no-op, matching what stops a real observer loop).
    let writeCount = 0;
    let currentValue = groupEl.style.marginTop;
    Object.defineProperty(groupEl.style, 'marginTop', {
      configurable: true,
      get: () => currentValue,
      set: (v: string) => {
        writeCount += 1;
        currentValue = v;
      },
    });

    for (let i = 0; i < 5; i += 1) {
      await wrapper.find('[data-action="bulk-toggle"]').trigger('click');
      await wrapper.find('[data-action="bulk-toggle"]').trigger('click');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(currentValue).toBe('250px');
    }
    expect(writeCount).toBe(0);
  });

  it('never nudges a branch group upward (never overlaps the group above it)', async () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const trunkWrapper = wrapper.find('.thread-trunk');
    const trunkEl = trunkWrapper.element;
    const runCards = trunkWrapper.findAll('.thread-card');
    const groupEl = wrapper.find('.thread-branch-group').element;

    stubRect(trunkEl, { top: 100 } as DOMRect);
    // The forking run-card sits HIGHER than the branch group's own natural stacking position —
    // the group must stay put (margin-top 0), never move up to "chase" it. Spied so the test can
    // positively confirm a sync pass actually re-read it (rather than just asserting a margin that
    // was already '' before the toggle, which would trivially "pass" without proving anything).
    const groupRectSpy = vi.fn(() => ({ top: 400 }) as DOMRect);
    stubRect(runCards[0]!.element, { bottom: 150 } as DOMRect);
    (groupEl as HTMLElement).getBoundingClientRect = groupRectSpy;

    await wrapper.find('[data-action="bulk-toggle"]').trigger('click');
    await waitFor(() => groupRectSpy.mock.calls.length > 0);

    expect((groupEl as HTMLElement).style.marginTop).toBe('');
  });

  // Regression test for the initial-load animation bug: a freshly mounted/refreshed page fires the
  // exact same `syncBranchAlignment` correction machinery `onMounted` already schedules, but a
  // static `transition: margin-top 0.1s ease` CSS rule made every one of those corrective mount-time
  // writes visibly animate — confirmed via Playwright against a real seeded multi-branch document to
  // take ~1-2s of visible motion end-to-end. `alignTransitionsReady`/`branchGroupStyle` (script)
  // suppress the transition (`transition: none`, inline) until this card's own alignment activity
  // has gone quiet for `ALIGN_SETTLE_QUIET_MS`, then flip it on permanently — this suite asserts that
  // state machine directly, mirroring `App.vue`'s `previewSplitDragging`/`DocumentCanvas.vue`'s
  // `editorSplitDragging` drag-suppression convention (a boolean-driven inline `transition`, not a
  // static CSS rule).
  describe('initial-mount transition suppression (no-visible-animation-on-load fix)', () => {
    it('suppresses the branch-group margin-top transition immediately after mount', () => {
      const store = useThreadStore();
      store.threads = [
        threadFixture({ id: 'root-1', kind: 'thread-root' }),
        threadFixture({
          id: 'branch-1',
          kind: 'thread-branch',
          parentId: 'root-1',
          forkedFromMessageId: 'm0',
          seedExcerptText: 'excerpt',
        }),
      ];
      store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
      store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

      const wrapper = mountCard('root-1');
      const groupEl = wrapper.find('.thread-branch-group').element as HTMLElement;

      // Mount just happened — `onMounted`'s own `scheduleAlignSync()` call has armed the settle
      // timer but it can't have fired yet (0ms have elapsed), so the transition must still read as
      // suppressed.
      expect(groupEl.style.transition).toBe('none');
    });

    it('enables the real margin-top transition once alignment activity goes quiet', async () => {
      const store = useThreadStore();
      store.threads = [
        threadFixture({ id: 'root-1', kind: 'thread-root' }),
        threadFixture({
          id: 'branch-1',
          kind: 'thread-branch',
          parentId: 'root-1',
          forkedFromMessageId: 'm0',
          seedExcerptText: 'excerpt',
        }),
      ];
      store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
      store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

      const wrapper = mountCard('root-1');
      const groupEl = wrapper.find('.thread-branch-group').element as HTMLElement;
      expect(groupEl.style.transition).toBe('none');

      // No further alignment activity is triggered here — the quiet timer armed at mount should
      // fire on its own and flip the transition on.
      await waitFor(() => groupEl.style.transition === 'margin-top 0.1s ease');
      expect(groupEl.style.transition).toBe('margin-top 0.1s ease');
    });

    it('never re-suppresses the transition for a later live interaction once settled', async () => {
      const store = useThreadStore();
      store.threads = [
        threadFixture({ id: 'root-1', kind: 'thread-root' }),
        threadFixture({
          id: 'branch-1',
          kind: 'thread-branch',
          parentId: 'root-1',
          forkedFromMessageId: 'm0',
          seedExcerptText: 'excerpt',
        }),
      ];
      store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
      store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

      const wrapper = mountCard('root-1');
      const groupEl = wrapper.find('.thread-branch-group').element as HTMLElement;
      await waitFor(() => groupEl.style.transition === 'margin-top 0.1s ease');

      // A genuine later live interaction (the same bulk-toggle-driven re-alignment the other tests
      // in this suite use) re-triggers `scheduleAlignSync()`/`markAlignActivity()` — this must NOT
      // re-arm suppression, or a real user action shortly after mount would silently lose its
      // animation too.
      await wrapper.find('[data-action="bulk-toggle"]').trigger('click');
      expect(groupEl.style.transition).toBe('margin-top 0.1s ease');
      // Still true after the interaction's own alignment pass has had time to run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(groupEl.style.transition).toBe('margin-top 0.1s ease');
    });
  });
});

// Structural coverage for the Y-split fork redesign itself (`runs`, script above): a fork visually
// disconnects the trunk into sibling run-cards (this run's own continuation, plus one per active
// branch) rather than the trunk rendering as one continuous box the branch column merely sits beside.
describe('ThreadCard — Y-split fork layout (structural)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('a thread with no branches at all renders as a single run-card, with no fork connector', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];

    const wrapper = mountCard('root-1');

    expect(wrapper.find('.thread-trunk').findAll('.thread-card').length).toBe(1);
    expect(wrapper.find('.thread-fork-connector').exists()).toBe(false);
    expect(wrapper.find('.thread-branches').exists()).toBe(false);
  });

  it('a branch off a non-tip message splits the trunk into two sibling run-cards joined by a fork connector', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    const trunkWrapper = wrapper.find('.thread-trunk');

    // Two sibling boxes: one ending at the fork anchor (m0), one the trunk's own continuation (m1)
    // — never one continuous box spanning both, now that the trunk visually disconnects at m0.
    expect(trunkWrapper.findAll('.thread-card').length).toBe(2);
    expect(trunkWrapper.findAll('.thread-fork-connector').length).toBe(1);
    // The branch itself still renders in the sibling `.thread-branches` column, inside a
    // `.thread-branch-row` (now always the immediate wrapper — see the horizontal-column redesign's
    // doc comment), as the plain single-line `.thread-branch-fork` connector — never the fan/column
    // treatment, which only kicks in for 2+ siblings sharing the same fork point.
    expect(wrapper.find('.thread-branches .thread-branch-row .thread-branch-fork').exists()).toBe(
      true,
    );
    expect(wrapper.find('.thread-branch-group').classes()).not.toContain(
      'thread-branch-group--fan',
    );
    expect(wrapper.find('.thread-branches .thread-branch-column').exists()).toBe(false);
  });

  it('a branch off the actual tip message forks WITHOUT a trunk continuation (nothing follows it)', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
      }),
    ];
    // m0 is BOTH the fork anchor and the thread's only (so also tip) message.
    store.messagesByThread['root-1'] = [makeMessage('m0')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    const trunkWrapper = wrapper.find('.thread-trunk');

    // Nothing follows the fork point, so there is exactly one run-card and no continuation connector
    // — only the sideways branch connector, not a downward one.
    expect(trunkWrapper.findAll('.thread-card').length).toBe(1);
    expect(trunkWrapper.findAll('.thread-fork-connector').length).toBe(0);
    expect(wrapper.find('.thread-branches .thread-branch-fork').exists()).toBe(true);
  });

  it('two active branches off the very same segment share one fork point, laid out as a horizontal row of columns (2-way sibling fork)', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt one',
      }),
      threadFixture({
        id: 'branch-2',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt two',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];
    store.messagesByThread['branch-2'] = [makeMessage('seed-1')];

    const wrapper = mountCard('root-1');
    const trunkWrapper = wrapper.find('.thread-trunk');

    // Still just one fork point in the trunk (m0), so one continuation run-card + one connector...
    expect(trunkWrapper.findAll('.thread-card').length).toBe(2);
    expect(trunkWrapper.findAll('.thread-fork-connector').length).toBe(1);
    // ...but now 2 sibling columns sharing that SAME `.thread-branch-group`, marked as a fan (2+
    // active children) and laid out side by side inside one `.thread-branch-row`, each with its own
    // fan-bar drop arrow — never the old vertical `.thread-branch-spine` (removed by the
    // horizontal-column redesign; a fan bridges siblings left-to-right instead of top-to-bottom).
    const group = wrapper.find('.thread-branch-group');
    expect(group.classes()).toContain('thread-branch-group--fan');
    expect(wrapper.find('.thread-branch-spine').exists()).toBe(false);
    const row = group.find('.thread-branch-row');
    expect(row.exists()).toBe(true);
    const columns = row.findAll('.thread-branch-column');
    expect(columns.length).toBe(2);
    // Single-branch fork's own `.thread-branch-fork` connector never appears once this is a fan.
    expect(group.findAll('.thread-branch-fork').length).toBe(0);
    // Every column is a direct child of the row (side by side, not nested inside one another).
    expect(row.element.children.length).toBe(2);
    expect(
      Array.from(row.element.children).every(
        (el) => el === columns[0]!.element || el === columns[1]!.element,
      ),
    ).toBe(true);
    // Every column gets its own drop-arrow into its own box; only the LAST column skips the
    // rightward bridging segment (`::before`, unchecked here since jsdom can't compute pseudo-
    // element geometry) — the structural signal checkable here is the `--last` modifier class.
    expect(row.findAll('.thread-branch-fan-arrow').length).toBe(2);
    expect(columns[0]!.classes()).not.toContain('thread-branch-column--last');
    expect(columns[1]!.classes()).toContain('thread-branch-column--last');
  });

  it('three active branches off the very same segment fan out as a 3-column row (N-way fan-bar)', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt one',
      }),
      threadFixture({
        id: 'branch-2',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt two',
      }),
      threadFixture({
        id: 'branch-3',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt three',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];
    store.messagesByThread['branch-2'] = [makeMessage('seed-1')];
    store.messagesByThread['branch-3'] = [makeMessage('seed-2')];

    const wrapper = mountCard('root-1');
    const group = wrapper.find('.thread-branch-group');
    const row = group.find('.thread-branch-row');
    const columns = row.findAll('.thread-branch-column');

    expect(columns.length).toBe(3);
    expect(row.findAll('.thread-branch-fan-arrow').length).toBe(3);
    // Exactly one column (the 3rd) is marked last — the other two each still bridge rightward to
    // their own next sibling.
    expect(columns.filter((c) => c.classes().includes('thread-branch-column--last')).length).toBe(
      1,
    );
    expect(columns[2]!.classes()).toContain('thread-branch-column--last');
  });

  it('two independent fork points in the same trunk each get their own stacked `.thread-branch-group`', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt one',
      }),
      threadFixture({
        id: 'branch-2',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm1',
        seedExcerptText: 'excerpt two',
      }),
    ];
    // Three trunk messages: m0 (fork #1's anchor), m1 (fork #2's anchor), m2 (the tip, no branch).
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1'), makeMessage('m2')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];
    store.messagesByThread['branch-2'] = [makeMessage('seed-1')];

    const wrapper = mountCard('root-1');
    const trunkWrapper = wrapper.find('.thread-trunk');

    // Three run-cards (one ending at m0, one ending at m1, one for the m2 tip), two fork connectors.
    expect(trunkWrapper.findAll('.thread-card').length).toBe(3);
    expect(trunkWrapper.findAll('.thread-fork-connector').length).toBe(2);
    // Two SEPARATE groups, stacked top-to-bottom in `.thread-branches` — the horizontal-column
    // redesign only rotates the axis WITHIN one group, never merges independent fork points into
    // one row.
    const groups = wrapper.findAll('.thread-branch-group');
    expect(groups.length).toBe(2);
    // Neither is a fan (each has exactly one active child) — each keeps the plain single-line
    // `.thread-branch-fork` connector, not a `.thread-branch-row` fan/column.
    expect(groups.every((g) => !g.classes().includes('thread-branch-group--fan'))).toBe(true);
    expect(wrapper.findAll('.thread-branch-fork').length).toBe(2);
    expect(wrapper.findAll('.thread-branch-column').length).toBe(0);
  });

  it('a done branch never forks the trunk (segment break stays a plain dashed continuation, not a Y-split)', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
        doneAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    const trunkWrapper = wrapper.find('.thread-trunk');

    // m0's only child is done, so it never ends a run early — one continuous run-card, still split
    // into two `.thread-segment`s internally (the plain dashed border), no fork connector, no
    // branches column at all (done branches never render inline — see `activeChildIds`).
    expect(trunkWrapper.findAll('.thread-card').length).toBe(1);
    expect(trunkWrapper.find('.thread-card').findAll('.thread-segment').length).toBe(2);
    expect(trunkWrapper.findAll('.thread-fork-connector').length).toBe(0);
    expect(wrapper.find('.thread-branches').exists()).toBe(false);
  });

  it('recursively applies the same Y-split treatment one level deeper to a branch that itself gets branched from', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'r0',
        seedExcerptText: 'excerpt',
      }),
      threadFixture({
        id: 'nested-1',
        kind: 'thread-branch',
        parentId: 'branch-1',
        forkedFromMessageId: 'b0',
        seedExcerptText: 'nested excerpt',
      }),
    ];
    // root-1's own single message (r0) is both the fork anchor for branch-1 AND the tip — so
    // root-1 itself renders as one run-card (matching the "fork at the tip" case above).
    store.messagesByThread['root-1'] = [makeMessage('r0')];
    // branch-1 has two messages: b0 (the anchor nested-1 forks from) and b1 (its own tip) — so
    // branch-1 gets its OWN two-run-card Y-split, exactly like root-1 got for branch-1 above, one
    // recursion level deeper.
    store.messagesByThread['branch-1'] = [makeMessage('b0'), makeMessage('b1')];
    store.messagesByThread['nested-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');

    // root-1's own trunk: one run-card (fork is at the tip), one branch fork (to branch-1).
    const rootTrunk = wrapper.find('.thread-trunk');
    expect(rootTrunk.findAll('.thread-card').length).toBe(1);

    // branch-1 renders recursively inside root-1's `.thread-branches` — its OWN nested `ThreadCard`
    // gets its own `.thread-trunk`, independently split into 2 run-cards + 1 connector, with
    // nested-1 rendered in ITS OWN `.thread-branches` one level deeper.
    const branchNode = wrapper.find('.thread-branches .thread-branch-fork .thread-node');
    expect(branchNode.exists()).toBe(true);
    const branchTrunk = branchNode.find('.thread-trunk');
    expect(branchTrunk.findAll('.thread-card').length).toBe(2);
    expect(branchTrunk.findAll('.thread-fork-connector').length).toBe(1);
    expect(branchNode.find('.thread-branches .thread-branch-fork').exists()).toBe(true);
  });

  it('a depth-2 nested fork point (a fan inside a branch-of-a-branch) gets its own fan/row treatment independently of its ancestor', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'r0',
        seedExcerptText: 'excerpt',
      }),
      threadFixture({
        id: 'nested-1',
        kind: 'thread-branch',
        parentId: 'branch-1',
        forkedFromMessageId: 'b0',
        seedExcerptText: 'nested excerpt one',
      }),
      threadFixture({
        id: 'nested-2',
        kind: 'thread-branch',
        parentId: 'branch-1',
        forkedFromMessageId: 'b0',
        seedExcerptText: 'nested excerpt two',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('r0')];
    // branch-1's own two active children (nested-1, nested-2) both fork from b0 — a 2-way fan one
    // level deeper than root-1's own (single-branch, non-fan) fork point.
    store.messagesByThread['branch-1'] = [makeMessage('b0'), makeMessage('b1')];
    store.messagesByThread['nested-1'] = [makeMessage('seed-0')];
    store.messagesByThread['nested-2'] = [makeMessage('seed-1')];

    const wrapper = mountCard('root-1');

    // root-1's own fork point is still the plain single-branch case (depth 0 -> depth 1).
    expect(wrapper.find('.thread-branch-group').classes()).not.toContain(
      'thread-branch-group--fan',
    );

    // One level deeper, inside branch-1's own recursively-mounted `ThreadCard`, its fork point IS a
    // fan (2 active children sharing b0) — depth keeps growing rightward (this is still nested
    // inside root-1's `.thread-branch-fork .thread-node`) independently of the sibling-column axis
    // rotating within branch-1's own `.thread-branches`.
    const branchNode = wrapper.find('.thread-branches .thread-branch-fork .thread-node');
    const nestedGroup = branchNode.find('.thread-branch-group');
    expect(nestedGroup.classes()).toContain('thread-branch-group--fan');
    const nestedColumns = nestedGroup.find('.thread-branch-row').findAll('.thread-branch-column');
    expect(nestedColumns.length).toBe(2);
  });
});

// Structural coverage for the horizontal-column redesign's own locked-in width-cap decision
// (`MAX_VISIBLE_BRANCH_COLUMNS` in `ThreadCard.vue`'s script): jsdom never computes real CSS layout
// (no real box widths, no real `overflow-x` scrollbar), so this can't verify the actual visual
// scroll behavior with 5+ siblings — that's covered separately via Playwright against the real dev
// server per this repo's own convention (see the supervisor log). What IS checkable here is the
// STRUCTURAL/arithmetic precondition that visual behavior depends on: `.thread-branch-row`'s own
// inline `max-width` is computed from the real constant (`MAX_VISIBLE_BRANCH_COLUMNS` siblings' own
// column width, at the children's real depth, plus the gaps between them) rather than some
// unrelated/magic value, and every sibling (including the 5th, past the 4-column cap) still renders
// as a real column inside the row rather than being dropped or wrapped to a second row.
describe('ThreadCard — branch row width cap (structural)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('caps the row at exactly 4 columns worth of width, with a 5th sibling still rendered (no wrap) rather than dropped', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      ...['branch-1', 'branch-2', 'branch-3', 'branch-4', 'branch-5'].map((id) =>
        threadFixture({
          id,
          kind: 'thread-branch',
          parentId: 'root-1',
          forkedFromMessageId: 'm0',
          seedExcerptText: `excerpt for ${id}`,
        }),
      ),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    for (const id of ['branch-1', 'branch-2', 'branch-3', 'branch-4', 'branch-5']) {
      store.messagesByThread[id] = [makeMessage(`seed-${id}`)];
    }

    const wrapper = mountCard('root-1');
    const row = wrapper.find('.thread-branch-row');
    const columns = row.findAll('.thread-branch-column');

    // All 5 siblings render as real columns in the SAME row (no wrap to a second row, no dropped
    // sibling) — the width cap is purely a `max-width`/`overflow-x` concern, never a rendering limit.
    expect(columns.length).toBe(5);
    expect(row.element.children.length).toBe(5);
    // Only the LAST (5th) column is marked `--last`.
    expect(columns.filter((c) => c.classes().includes('thread-branch-column--last')).length).toBe(
      1,
    );

    // The row's own inline `max-width` budgets for exactly `MAX_VISIBLE_BRANCH_COLUMNS` (4) siblings
    // at their real per-depth column width (420px, depth 1's own `CARD_MAX_WIDTH_PX`) plus 3 gaps
    // between them (32px each, `BRANCH_COLUMN_GAP_PX`): 4*420 + 3*32 = 1680 + 96 = 1776px — NOT
    // sized for all 5 actual siblings (which would need a 4th gap too), which is exactly what forces
    // the 5th column past the cap into `overflow-x: auto` territory in a real browser.
    // (`overflow-x: auto`/no-wrap themselves are static CSS, not inline style — see this file's own
    // top-of-suite comment for why the real scroll behavior is verified via Playwright instead.)
    const style = row.attributes('style') ?? '';
    expect(style).toContain('1776px');
  });
});

// Regression test for the header containment bug (bug report: "the title and expand buttons render
// outside the threaded conversation"): the Y-split redesign moved `.thread-card-header` out of the
// single continuous `.thread-card` it used to be the first child of (needed so it stays sticky
// across the WHOLE run-card chain, not just whichever run-card would otherwise contain it), but left
// it a bare flex sibling of the run-card chain with no CSS relationship to it at all — so it read as
// floating above the bordered box rather than as that box's own lid. The real visual fix is CSS
// (`.thread-card-header`'s own border/padding, `.thread-run-chain > .thread-card:first-child`'s
// squared-off top corners, and the `.thread-card-header + .thread-run-chain` zero-gap seam) — jsdom
// doesn't compute layout, so what's actually checkable here is the STRUCTURAL precondition that CSS
// depends on: every trunk box (the run-card chain, or the zero-message composer-only card) is now
// grouped under one `.thread-run-chain` wrapper directly after the header, so `.thread-card-header +
// .thread-run-chain` can match and `.thread-run-chain > .thread-card:first-child` unambiguously
// identifies the one box the header is meant to sit flush against.
describe('ThreadCard — header containment (bug fix)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string, activeThreadId: string | null = null) {
    return mount(ThreadCard, {
      props: { threadId, activeThreadId },
      global: { plugins: [pinia] },
    });
  }

  it('wraps every run-card in one `.thread-run-chain` immediately after the header, so the header can sit flush against the first one', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'm0',
        seedExcerptText: 'excerpt',
      }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0'), makeMessage('m1')];
    store.messagesByThread['branch-1'] = [makeMessage('seed-0')];

    const wrapper = mountCard('root-1');
    const trunk = wrapper.find('.thread-trunk');
    const header = trunk.find('.thread-card-header');
    const runChain = trunk.find('.thread-run-chain');

    expect(header.exists()).toBe(true);
    expect(runChain.exists()).toBe(true);
    // The header is immediately followed by the run-chain in the trunk's own DOM order — the exact
    // adjacency `.thread-card-header + .thread-run-chain`'s CSS zero-gap rule depends on.
    expect(trunk.element.children[0]).toBe(header.element);
    expect(trunk.element.children[1]).toBe(runChain.element);
    // Both of this thread's own run-cards (the fork anchor's, and its continuation's) live INSIDE
    // the run-chain wrapper, not as bare trunk children beside the header.
    expect(runChain.findAll('.thread-card').length).toBe(2);
    expect(trunk.element.querySelectorAll(':scope > .thread-card').length).toBe(0);
  });

  it('a zero-message thread (composer-only card) still wraps that card in `.thread-run-chain`', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [];

    const wrapper = mountCard('root-1');
    const runChain = wrapper.find('.thread-trunk').find('.thread-run-chain');

    expect(runChain.findAll('.thread-card').length).toBe(1);
  });

  it('marks the header active in lockstep with its own run-card, so the HUD cursor ring wraps the whole unified box', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const activeWrapper = mountCard('root-1', 'root-1');
    expect(activeWrapper.find('.thread-card-header').classes()).toContain(
      'thread-card-header--active',
    );

    const inactiveWrapper = mountCard('root-1', 'some-other-thread');
    expect(inactiveWrapper.find('.thread-card-header').classes()).not.toContain(
      'thread-card-header--active',
    );
  });
});

// Parity fix (011-linear-thread-mode follow-up): before this, a Thread's agent turn could fail
// (`status: 'errored'`) with no visible banner and no Retry action at all — `stores/thread.ts`
// silently ignored `conversation_status_changed`. Reuses `ConversationView.vue`'s exact banner
// shape (`.error-banner*`, `agentErrorBanner.ts`) rather than a second hand-rolled one.
describe('ThreadCard — agent-turn-errored banner + Retry (parity fix)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('shows no error banner while the thread is idle', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', status: 'idle' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');

    expect(wrapper.find('.error-banner').exists()).toBe(false);
  });

  it('shows the error banner with its message and a Retry button once the thread is errored', () => {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', status: 'errored', errorMessage: 'Upstream failure.' }),
    ];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');
    const banner = wrapper.find('.error-banner');

    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('Upstream failure.');
    expect(banner.text()).toContain('Retry');
  });

  it('falls back to a generic message when errorMessage is null', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', status: 'errored', errorMessage: null })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');

    expect(wrapper.find('.error-banner').text()).toContain('The agent hit an error.');
  });

  it('clicking Retry calls httpClient.retryThread for this thread', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', status: 'errored' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];
    const { httpClient } = await import('../../src/transport/http-client.js');

    const wrapper = mountCard('root-1');
    await wrapper.find('.error-banner-actions button').trigger('click');

    expect(httpClient.retryThread).toHaveBeenCalledWith(null, 'root-1');
  });

  it('clicking Dismiss hides the banner without changing status', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', status: 'errored' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');
    await wrapper.find('[aria-label="Dismiss error"]').trigger('click');

    expect(wrapper.find('.error-banner').exists()).toBe(false);
    expect(store.findThread('root-1')?.status).toBe('errored');
  });
});

// Parity fix (011-linear-thread-mode follow-up): a Thread's own name can be renamed exactly the
// same way a canvas conversation's can — reuses the exact same `useConversationRename` composable
// as `ConversationThreadBox.vue`/`ConversationView.vue` (generalized to a `{ find, rename }`
// source), not a second hand-rolled implementation.
describe('ThreadCard — rename (parity fix)', () => {
  let pinia: Pinia;

  beforeEach(async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    const { httpClient } = await import('../../src/transport/http-client.js');
    vi.mocked(httpClient.renameThread).mockReset();
  });

  function mountCard(threadId: string) {
    return mount(ThreadCard, {
      props: { threadId },
      global: { plugins: [pinia] },
    });
  }

  it('shows the plain-text title and a rename button by default, no input', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', name: 'Original Thread Name' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');

    expect(wrapper.find('.thread-card-title').text()).toBe('Original Thread Name');
    expect(wrapper.find('.thread-rename-button').exists()).toBe(true);
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
  });

  it('clicking the rename button opens an input pre-filled with the current name', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', name: 'Original Thread Name' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');

    expect(input.exists()).toBe(true);
    expect(input.element.value).toBe('Original Thread Name');
    expect(wrapper.find('.thread-card-title').exists()).toBe(false);
  });

  it('saves the new name on Enter, calling httpClient.renameThread and updating the store', async () => {
    const { httpClient } = await import('../../src/transport/http-client.js');
    vi.mocked(httpClient.renameThread).mockResolvedValue(
      threadFixture({ id: 'root-1', name: 'New Thread Name' }),
    );
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', name: 'Original Thread Name' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('New Thread Name');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(httpClient.renameThread).toHaveBeenCalledWith(null, 'root-1', 'New Thread Name');
    expect(store.findThread('root-1')?.name).toBe('New Thread Name');
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
    expect(wrapper.find('.thread-card-title').text()).toBe('New Thread Name');
  });

  it('cancels on Escape without calling the API, reverting to the original name', async () => {
    const { httpClient } = await import('../../src/transport/http-client.js');
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', name: 'Original Thread Name' })];
    store.messagesByThread['root-1'] = [makeMessage('m0')];

    const wrapper = mountCard('root-1');
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('Discarded edit');
    await input.trigger('keydown.escape');
    await flushPromises();

    expect(httpClient.renameThread).not.toHaveBeenCalled();
    expect(store.findThread('root-1')?.name).toBe('Original Thread Name');
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
  });
});
