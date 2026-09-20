import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import ThreadCard from '../../src/components/thread/ThreadCard.vue';
import { useThreadStore } from '../../src/stores/thread.js';
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
    // The branch itself still renders in the sibling `.thread-branches` column, one fork, no spine
    // link needed (a spine only bridges 2+ siblings sharing the same fork point).
    expect(wrapper.find('.thread-branches .thread-branch-fork').exists()).toBe(true);
    expect(wrapper.find('.thread-branches .thread-branch-spine').exists()).toBe(false);
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

  it('two active branches off the very same segment share one fork point, joined by a spine link (3-way fork: continuation + 2 branches)', () => {
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
    // ...but now 2 branch forks sharing that SAME `.thread-branch-group`, bridged by exactly one
    // spine link (N forks need N-1 spine links).
    const group = wrapper.find('.thread-branch-group');
    expect(group.findAll('.thread-branch-fork').length).toBe(2);
    expect(group.findAll('.thread-branch-spine').length).toBe(1);
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
});
