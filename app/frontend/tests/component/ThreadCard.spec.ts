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

// Structural coverage for the Y-split fork design (`runs`, script above): a fork visually
// disconnects the trunk into sibling run-cards (this run's own continuation, self-mounted one
// `runStartIndex` deeper, plus one nested `ThreadCard` per active branch) rather than the trunk
// rendering as one continuous box a separate branch column merely sits beside. Since the
// column-packing redesign made this whole layout flex/DOM-flow-driven (no more
// `getBoundingClientRect()`-measured `margin-top` alignment — a fork's own `.thread-branch-row`
// renders as a plain block with a fixed `margin-left` indent, and the continuation renders strictly
// AFTER it, never beside it as a flex-row sibling — see `ThreadCard.vue`'s own top doc comment for
// why), there is no separate "alignment" test suite to keep in sync with this one anymore.
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

    expect(wrapper.findAll('.thread-card').length).toBe(1);
    expect(wrapper.find('.thread-fork-connector').exists()).toBe(false);
    expect(wrapper.find('.thread-branch-row').exists()).toBe(false);
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

    // Two sibling boxes for root-1 itself: one ending at the fork anchor (m0), the other its own
    // continuation (m1, self-mounted one `runStartIndex` deeper) — never one continuous box
    // spanning both, now that the trunk visually disconnects at m0.
    expect(wrapper.findAll('.thread-card[data-thread-id="root-1"]').length).toBe(2);
    expect(wrapper.findAll('.thread-fork-connector').length).toBe(1);
    // The branch itself renders inside a `.thread-branch-row` (now always the immediate wrapper —
    // see the horizontal-column redesign's doc comment), as the plain single-line
    // `.thread-branch-fork` connector — never the fan/column treatment, which only kicks in for
    // 2+ siblings sharing the same fork point.
    expect(wrapper.find('.thread-branch-row .thread-branch-fork').exists()).toBe(true);
    expect(wrapper.find('.thread-branch-column').exists()).toBe(false);
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

    // Nothing follows the fork point, so there is exactly one run-card and no continuation connector
    // — only the sideways branch connector, not a downward one.
    expect(wrapper.findAll('.thread-card[data-thread-id="root-1"]').length).toBe(1);
    expect(wrapper.find('.thread-fork-connector').exists()).toBe(false);
    expect(wrapper.find('.thread-branch-fork').exists()).toBe(true);
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

    // Still just one fork point in the trunk (m0), so one continuation run-card + one connector...
    expect(wrapper.findAll('.thread-card[data-thread-id="root-1"]').length).toBe(2);
    expect(wrapper.findAll('.thread-fork-connector').length).toBe(1);
    // ...but now 2 sibling columns laid out side by side inside one `.thread-branch-row` — never the
    // old vertical `.thread-branch-spine` (removed by the horizontal-column redesign; a fan bridges
    // siblings left-to-right instead of top-to-bottom).
    expect(wrapper.find('.thread-branch-spine').exists()).toBe(false);
    const row = wrapper.find('.thread-branch-row');
    expect(row.exists()).toBe(true);
    const columns = row.findAll('.thread-branch-column');
    expect(columns.length).toBe(2);
    // Single-branch fork's own `.thread-branch-fork` connector never appears once this is a fan.
    expect(wrapper.find('.thread-branch-fork').exists()).toBe(false);
    // Every column is a direct child of the row (side by side, not nested inside one another).
    expect(row.element.children.length).toBe(2);
    expect(
      Array.from(row.element.children).every(
        (el) => el === columns[0]!.element || el === columns[1]!.element,
      ),
    ).toBe(true);
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
    const row = wrapper.find('.thread-branch-row');
    const columns = row.findAll('.thread-branch-column');

    expect(columns.length).toBe(3);
  });

  it('two independent fork points in the same trunk each get their own `.thread-branch-row`, chained via the trunk continuation', () => {
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

    // Three run-cards (one ending at m0, one ending at m1, one for the m2 tip) — root-1 itself
    // self-mounted three deep (`runStartIndex` 0, 1, 2) — two fork connectors chaining them.
    expect(wrapper.findAll('.thread-card[data-thread-id="root-1"]').length).toBe(3);
    expect(wrapper.findAll('.thread-fork-connector').length).toBe(2);
    // Two SEPARATE `.thread-branch-row`s, one per fork point, each still just a single-branch
    // (non-fan) `.thread-branch-fork` — the horizontal-column redesign only rotates the axis WITHIN
    // one fork point's own row, never merges independent fork points into one row.
    expect(wrapper.findAll('.thread-branch-row').length).toBe(2);
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

    // m0's only child is done, so it never ends a run early — one continuous run-card, still split
    // into two `.thread-segment`s internally (the plain dashed border), no fork connector, no
    // branch row at all (done branches never render inline — see `activeChildIds`).
    expect(wrapper.findAll('.thread-card[data-thread-id="root-1"]').length).toBe(1);
    expect(wrapper.find('.thread-card').findAll('.thread-segment').length).toBe(2);
    expect(wrapper.find('.thread-fork-connector').exists()).toBe(false);
    expect(wrapper.find('.thread-branch-row').exists()).toBe(false);
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

    // root-1's own run: one run-card (fork is at the tip), one branch fork (to branch-1).
    expect(wrapper.findAll('.thread-card[data-thread-id="root-1"]').length).toBe(1);

    // branch-1 renders recursively inside root-1's own `.thread-branch-fork` — its OWN nested
    // `ThreadCard` gets its own independently self-mounted 2 run-cards + 1 connector, with
    // nested-1 rendered one level deeper still.
    const branchNode = wrapper.find('.thread-branch-fork .thread-node');
    expect(branchNode.exists()).toBe(true);
    expect(branchNode.findAll('.thread-card[data-thread-id="branch-1"]').length).toBe(2);
    expect(branchNode.find('.thread-fork-connector').exists()).toBe(true);
    expect(branchNode.find('.thread-branch-fork').exists()).toBe(true);
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

    // root-1's own fork point is still the plain single-branch case (depth 0 -> depth 1): exactly
    // one `.thread-branch-fork` connector anywhere in the tree (root-1's own), not a fan row.
    const branchNode = wrapper.find('.thread-branch-fork .thread-node');
    expect(branchNode.exists()).toBe(true);
    expect(wrapper.findAll('.thread-branch-fork').length).toBe(1);

    // One level deeper, inside branch-1's own recursively-mounted `ThreadCard`, its fork point IS a
    // fan (2 active children sharing b0) — depth keeps growing rightward (this is still nested
    // inside root-1's `.thread-branch-fork .thread-node`) independently of root-1's own
    // single-branch fork point.
    const nestedRow = branchNode.find('.thread-branch-row');
    expect(nestedRow.exists()).toBe(true);
    expect(nestedRow.findAll('.thread-branch-column').length).toBe(2);
  });
});

// Structural coverage for the branch row's own explicit no-cap decision: `.thread-branch-row` no
// longer carries a `max-width` (or any `overflow-x`) of its own — a 3+ column fan must render every
// sibling column fully, side by side, growing the row as wide as needed, rather than clipping/
// scrolling past some fixed number of columns. jsdom never computes real CSS layout (no real box
// widths), so this can't verify actual on-screen pixel visibility — that's confirmed separately by
// hand against the real dev server. What IS checkable here is the STRUCTURAL precondition: every
// sibling renders as a real column inside the one row (never dropped or wrapped to a second row),
// and the row's own inline style carries no leftover `max-width` clamp.
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

  it('renders all 5 sibling columns in one uncapped row, with no max-width/overflow-x clamp', () => {
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
    // sibling, no cap on how many render).
    expect(columns.length).toBe(5);
    expect(row.element.children.length).toBe(5);
    // No `--last` modifier class anywhere — it was only ever used to bridge a fan-bar connector
    // between columns, and that connector was removed per explicit request.
    expect(columns.some((c) => c.classes().includes('thread-branch-column--last'))).toBe(false);

    // The row's own inline style carries no `max-width` clamp — it grows unbounded to fit however
    // many sibling columns this fork has (`branchRowStyle` in `ThreadCard.vue` only sets
    // `margin-left` and the `--thread-branch-fan-gap` custom property now).
    const style = row.attributes('style') ?? '';
    expect(style).not.toContain('max-width');
  });
});

// Regression test for the header containment bug (bug report: "the title and expand buttons render
// outside the threaded conversation"): a Thread's header must read as this box's own lid rather
// than floating disconnected above it. The column-packing redesign dropped the old
// `.thread-run-chain` wrapper (each `ThreadCard` instance renders at most one run-card of its own
// now, rather than a whole thread's run-chain in one go — see this file's own top doc comment), so
// the fix is now a direct `.thread-card-header + .thread-card` adjacency plus the
// `.thread-card--flush-header` class (applied only to the `runStartIndex === 0` instance's own
// run-card) squaring off that one box's top corners — see `ThreadCard.vue`'s own CSS doc comments.
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

  it("the header sits directly before this thread's own first run-card, which alone gets the flush-header treatment", () => {
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
    const node = wrapper.find('.thread-node');
    const header = node.find('.thread-card-header');
    const firstCard = node.find('.thread-card');

    expect(header.exists()).toBe(true);
    expect(firstCard.exists()).toBe(true);
    // The header is immediately followed by this instance's own run-card in the node's own DOM
    // order — the exact adjacency `.thread-card-header + .thread-card.thread-card--flush-header`'s
    // CSS zero-gap rule depends on.
    expect(node.element.children[0]).toBe(header.element);
    expect(node.element.children[1]).toBe(firstCard.element);
    expect(firstCard.classes()).toContain('thread-card--flush-header');

    // The thread's own continuation (self-mounted one `runStartIndex` deeper) has no header of its
    // own, so its run-card keeps full rounding rather than the flush-header treatment.
    const rootCards = wrapper.findAll('.thread-card[data-thread-id="root-1"]');
    expect(rootCards.length).toBe(2);
    const continuationCard = rootCards[1]!;
    expect(continuationCard.classes()).not.toContain('thread-card--flush-header');
  });

  it('a zero-message thread still renders its composer-only card with the flush-header treatment', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'root-1', kind: 'thread-root' })];
    store.messagesByThread['root-1'] = [];

    const wrapper = mountCard('root-1');
    const card = wrapper.find('.thread-card');

    expect(card.exists()).toBe(true);
    expect(card.classes()).toContain('thread-card--flush-header');
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
