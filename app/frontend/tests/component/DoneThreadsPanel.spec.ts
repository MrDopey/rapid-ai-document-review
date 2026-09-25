import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import DoneThreadsPanel from '../../src/components/thread/DoneThreadsPanel.vue';
import { useThreadStore } from '../../src/stores/thread.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';

// Same convention as ThreadCard.spec.ts/ThreadModeView.spec.ts: messages/threads are seeded
// straight into the store, so `DoneThreadColumn.vue`'s own `onMounted` `loadDetail` guard never
// issues a real request this test has no server for.
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

// jsdom implements neither `Element.scrollIntoView` — same workaround as ThreadModeView.spec.ts.
Element.prototype.scrollIntoView = vi.fn();

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

describe('DoneThreadsPanel — column layout', () => {
  let pinia: Pinia;
  let activeWrapper: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = null;
    vi.clearAllMocks();
  });

  /** root-1 (active) -> branch-1 (active) -> branch-2 (DONE): a two-level ancestor chain for the
   *  one done thread this suite exercises. */
  function seedChain(): void {
    const store = useThreadStore();
    store.loaded = true;
    store.threads = [
      threadFixture({ id: 'root-1', name: 'Root Thread', kind: 'thread-root' }),
      threadFixture({
        id: 'branch-1',
        name: 'Branch Thread',
        kind: 'thread-branch',
        parentId: 'root-1',
        forkedFromMessageId: 'r2',
      }),
      threadFixture({
        id: 'branch-2',
        name: 'Grandchild Thread',
        kind: 'thread-branch',
        parentId: 'branch-1',
        forkedFromMessageId: 'b1',
        doneAt: '2026-01-02T00:00:00.000Z',
      }),
    ];
    store.messagesByThread['root-1'] = [
      makeMessage('r0'),
      makeMessage('r1'),
      makeMessage('r2'),
      makeMessage('r3'),
    ];
    store.messagesByThread['branch-1'] = [makeMessage('b0'), makeMessage('b1'), makeMessage('b2')];
    store.messagesByThread['branch-2'] = [makeMessage('g0'), makeMessage('g1')];
  }

  function mountPanel() {
    const wrapper = mount(DoneThreadsPanel, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    activeWrapper = wrapper;
    return wrapper;
  }

  it('shows the empty state when there are no done threads', () => {
    const store = useThreadStore();
    store.loaded = true;
    store.threads = [threadFixture({ id: 'root-1', name: 'Root Thread' })];
    const wrapper = mountPanel();

    expect(wrapper.find('.done-threads-empty').exists()).toBe(true);
    expect(wrapper.find('.done-thread-column').exists()).toBe(false);
  });

  it('renders one column per done thread', async () => {
    seedChain();
    const wrapper = mountPanel();
    await flushPromises();

    const columns = wrapper.findAll('.done-thread-column');
    expect(columns).toHaveLength(1);
    expect(columns[0]!.attributes('data-thread-id')).toBe('branch-2');
    expect(columns[0]!.find('.done-thread-column-name').text()).toBe('Grandchild Thread');
  });

  it('renders the full ancestor chain root-first, each ancestor sliced up to its own fork boundary, with a marker after each', async () => {
    seedChain();
    const wrapper = mountPanel();
    await flushPromises();

    const column = wrapper.get('.done-thread-column');
    const labels = column.findAll('.done-thread-ancestor-label').map((l) => l.text());
    expect(labels).toEqual(['── Root Thread ──', '── Branch Thread ──']);

    const markers = column.findAll('.done-thread-fork-marker').map((m) => m.text());
    expect(markers).toEqual([
      '⑂ forked from "Root Thread" here — from here, this is a unique conversation',
      '⑂ forked from "Branch Thread" here — from here, this is a unique conversation',
    ]);

    // Only the LAST marker (bordering this thread's own unique content) carries the scroll target.
    expect(column.findAll('.done-thread-fork-marker[data-fork-marker-tip="true"]')).toHaveLength(1);
    expect(markers[1]).toBe(column.find('[data-fork-marker-tip="true"]').text());

    // root-1's own message list is [r0, r1, r2, r3] — sliced to [r0, r1, r2] (up to branch-1's own
    // forkedFromMessageId, 'r2'); r3 belongs to a sibling path, not this lineage.
    const bubbleIds = column.findAll('.message-bubble').map((b) => b.attributes('data-message-id'));
    expect(bubbleIds).toEqual(['r0', 'r1', 'r2', 'b0', 'b1', 'g0', 'g1']);
  });

  it('renders no ThreadComposer anywhere in the DOM (strictly read-only)', async () => {
    seedChain();
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.findAll('[id^="thread-composer-"]')).toHaveLength(0);
  });

  it('Expand all/Collapse all loops the existing per-thread bulk toggle over every thread in the chain', async () => {
    seedChain();
    const store = useThreadStore();
    const wrapper = mountPanel();
    await flushPromises();

    // Nothing has been expanded yet for any of the three chain threads — everything defaults to
    // collapsed for a user-role message per `expandableMessages.ts`'s own seeding rule, but these
    // fixtures are all 'assistant' role (defaults to expanded) — force a collapsed baseline so the
    // toggle has real work to do.
    for (const id of ['root-1', 'branch-1', 'branch-2']) {
      for (const m of store.messagesFor(id)) store.setMessageExpanded(id, m.id, false);
    }
    await wrapper.vm.$nextTick();

    const toggleButton = wrapper.get('.done-thread-bulk-toggle');
    expect(toggleButton.text()).toBe('Expand all');

    await toggleButton.trigger('click');

    for (const id of ['root-1', 'branch-1', 'branch-2']) {
      for (const m of store.messagesFor(id)) {
        expect(store.expandedByMessage[id]?.[m.id]).toBe(true);
      }
    }
  });

  it('Reopen calls store.reopen, removing the thread from the done list and emitting reopened', async () => {
    seedChain();
    const store = useThreadStore();
    const { httpClient } = await import('../../src/transport/http-client.js');
    vi.mocked(httpClient.reopenThread).mockResolvedValue(undefined as never);

    const wrapper = mountPanel();
    await flushPromises();

    await wrapper
      .get('.done-thread-column-actions button:not(.done-thread-bulk-toggle)')
      .trigger('click');
    await flushPromises();

    expect(httpClient.reopenThread).toHaveBeenCalledWith(null, 'branch-2');
    expect(store.findThread('branch-2')?.doneAt).toBeNull();
    expect(wrapper.emitted('reopened')).toEqual([['branch-2']]);
    // The reopened thread no longer qualifies as "done" — the column disappears on next render.
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.done-thread-column').exists()).toBe(false);
    expect(wrapper.find('.done-threads-empty').exists()).toBe(true);
  });
});
