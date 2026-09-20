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
