import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import MessageBubble from '../../src/components/conversation/MessageBubble.vue';
import ConversationThreadBox from '../../src/components/conversation/ConversationThreadBox.vue';
import ConversationDetailPanel from '../../src/components/conversation/ConversationDetailPanel.vue';
import { useConversationsStore, type ConversationMessageState } from '../../src/stores/conversations.js';
import { httpClient } from '../../src/transport/http-client.js';

// The new "Branch" parity test below (focused-view header action) drives
// `useConversationsStore().branch()`, which calls through to `httpClient.branchConversation` —
// mocked here (same convention as `ConversationThreadBox.spec.ts`) so it never hits a real network
// call.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    getConversation: vi.fn(),
    branchConversation: vi.fn(),
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

// Spec: specs/005-canvas-conversation-threads, User Story 3 (FR-008/FR-009), T024.
//
// `MessageBubble.vue`'s `overflowing` check reads the real DOM `scrollHeight` of its text element
// (data-model.md's MessageDisplayState — a per-message `expanded` flag, defaulting to `false`).
// jsdom never computes real layout, so `scrollHeight` is always 0 there; every test that needs the
// message to register as "too tall to show in full" overrides `scrollHeight` on the mounted text
// element before the component's post-flush overflow check runs (see `mockTallScrollHeight`).

function makeMessage(overrides: Partial<ConversationMessageState> & { id: string }): ConversationMessageState {
  return {
    role: 'assistant',
    text: 'short text',
    reasoning: null,
    streaming: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockTallScrollHeight(el: Element, px = 400): void {
  Object.defineProperty(el, 'scrollHeight', { value: px, configurable: true });
}

describe('MessageBubble — per-message expand/collapse (FR-008)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountBubble(props: { message: ConversationMessageState; expanded?: boolean }) {
    return mount(MessageBubble, { props, global: { plugins: [pinia] } });
  }

  it('renders no toggle button when the message is short (nothing to expand/collapse)', async () => {
    const wrapper = mountBubble({ message: makeMessage({ id: 'm1', text: 'short' }), expanded: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.expand-toggle-button').exists()).toBe(false);
  });

  it('a long message defaults to collapsed and shows a "Show more" toggle', async () => {
    const wrapper = mountBubble({ message: makeMessage({ id: 'm1', text: 'a'.repeat(2000) }), expanded: false });
    mockTallScrollHeight(wrapper.get('.message-text').element);
    await wrapper.vm.$nextTick();

    const toggle = wrapper.find('.expand-toggle-button');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toBe('Show more');
    expect((wrapper.get('.message-text').element as HTMLElement).style.maxHeight).toBe('160px');
  });

  it('clicking the toggle emits update:expanded so a controlling parent can flip this one message', async () => {
    const wrapper = mountBubble({ message: makeMessage({ id: 'm1', text: 'a'.repeat(2000) }), expanded: false });
    mockTallScrollHeight(wrapper.get('.message-text').element);
    await wrapper.vm.$nextTick();

    await wrapper.find('.expand-toggle-button').trigger('click');
    expect(wrapper.emitted('update:expanded')).toEqual([[true]]);
  });

  it('when expanded=true, the clamp is lifted and the toggle reads "Show less"', async () => {
    const wrapper = mountBubble({ message: makeMessage({ id: 'm1', text: 'a'.repeat(2000) }), expanded: true });
    mockTallScrollHeight(wrapper.get('.message-text').element);
    await wrapper.vm.$nextTick();

    expect((wrapper.get('.message-text').element as HTMLElement).style.maxHeight).toBe('');
    expect(wrapper.find('.expand-toggle-button').text()).toBe('Show less');
  });

  it('defaults `expanded` to true when the prop is omitted (e.g. a read-only continuity-context message)', async () => {
    const wrapper = mountBubble({ message: makeMessage({ id: 'm1', text: 'a'.repeat(2000) }) });
    mockTallScrollHeight(wrapper.get('.message-text').element);
    await wrapper.vm.$nextTick();
    expect((wrapper.get('.message-text').element as HTMLElement).style.maxHeight).toBe('');
  });
});

/** Shared by every `ConversationThreadBox` component test below. */
function conversationFixture(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'conv1',
    name: 'Main',
    kind: 'main',
    parentId: null,
    branchDepth: 0,
    status: 'idle',
    isPrimary: true,
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
    ...overrides,
  };
}

describe('ConversationThreadBox — bulk expand/collapse (FR-009)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  function mountBox(messages: ConversationMessageState[]) {
    const store = useConversationsStore();
    store.conversations = [conversationFixture()];
    // Pre-seeding `messagesByConversation` satisfies ConversationThreadBox's onMounted guard, so
    // it never issues the real `loadDetail` HTTP call this unit test has no server for.
    store.messagesByConversation['conv1'] = messages;

    const wrapper = mount(ConversationThreadBox, {
      props: { conversationId: 'conv1' },
      global: { plugins: [pinia], stubs: { ConversationView: true } },
    });
    return wrapper;
  }

  it('renders no bulk toggle for a conversation with only one message', () => {
    const wrapper = mountBox([makeMessage({ id: 'm1' })]);
    expect(wrapper.find('.bulk-toggle-button').exists()).toBe(false);
  });

  it('bulk-expands every message at once, then an individual toggle overrides just that one message', async () => {
    const wrapper = mountBox([
      makeMessage({ id: 'm1', text: 'a'.repeat(2000) }),
      makeMessage({ id: 'm2', text: 'b'.repeat(2000) }),
    ]);
    const bubbles = wrapper.findAllComponents(MessageBubble);
    for (const bubble of bubbles) mockTallScrollHeight(bubble.get('.message-text').element);
    await wrapper.vm.$nextTick();

    // Both start collapsed (FR-008 default) — the bulk control offers to expand everything.
    expect(wrapper.get('.bulk-toggle-button').text()).toBe('Expand all');
    await wrapper.get('.bulk-toggle-button').trigger('click');
    await wrapper.vm.$nextTick();

    const expandedBubbles = wrapper.findAllComponents(MessageBubble);
    expect(expandedBubbles.every((b) => b.props('expanded') === true)).toBe(true);
    // Once every message is expanded, the same control offers to collapse everything instead.
    expect(wrapper.get('.bulk-toggle-button').text()).toBe('Collapse all');

    // Individual override: collapsing just the first message must not touch the second.
    await expandedBubbles[0]!.find('.expand-toggle-button').trigger('click');
    await wrapper.vm.$nextTick();
    const afterOverride = wrapper.findAllComponents(MessageBubble);
    expect(afterOverride[0]!.props('expanded')).toBe(false);
    expect(afterOverride[1]!.props('expanded')).toBe(true);
  });

  it('persists expand state to localStorage, keyed by message id, and restores it on next mount', async () => {
    const wrapper = mountBox([makeMessage({ id: 'm1', text: 'a'.repeat(2000) })]);
    mockTallScrollHeight(wrapper.getComponent(MessageBubble).get('.message-text').element);
    await wrapper.vm.$nextTick();

    await wrapper.getComponent(MessageBubble).find('.expand-toggle-button').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.getComponent(MessageBubble).props('expanded')).toBe(true);

    const stored = JSON.parse(localStorage.getItem('raidr:messageExpanded') ?? '{}');
    expect(stored.m1).toBe(true);

    // A fresh mount (e.g. the box remounting during layout reflow) must pick the persisted state
    // back up rather than resetting to the FR-008 default.
    const remount = mountBox([makeMessage({ id: 'm1', text: 'a'.repeat(2000) })]);
    expect(remount.getComponent(MessageBubble).props('expanded')).toBe(true);
  });
});

// Regression test: the expand/collapse toggle (FR-008) must also work in the "focused" view — the
// multi-focus overlay panel (`ConversationDetailPanel.vue`, rendering `ConversationView.vue`), not
// just in the compact canvas thread box (`ConversationThreadBox.vue`, already covered above).
//
// Root cause of the original bug: `ConversationView.vue` rendered `MessageBubble` without either
// `:expanded` or `@update:expanded`, relying on `MessageBubble.vue`'s `expanded` prop defaulting to
// `true`. That default doesn't suppress the toggle button — the button renders whenever the
// message's real content overflows the clamp height, independent of `expanded` — so a long message
// in the focused view still grew a "Show less" button, but clicking it emitted `update:expanded`
// into the void (`ConversationView.vue` had nothing listening), so the toggle looked broken. Fixed
// by giving `ConversationView.vue` its own `expandedByMessage` state, the same shape as
// `ConversationThreadBox.vue`'s. This test mounts the real `ConversationDetailPanel.vue` (the exact
// wrapper used for the focused overlay in `App.vue`) with a real `ConversationView.vue` inside it —
// not `MessageBubble` in isolation — so a regression in that wiring fails here again.
describe('ConversationDetailPanel/ConversationView — expand/collapse toggle works in the focused view (regression)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  function mountFocusedPanel(messages: ConversationMessageState[]) {
    const store = useConversationsStore();
    store.conversations = [conversationFixture()];
    store.messagesByConversation['conv1'] = messages;
    // `ConversationView.vue`'s `onMounted` unconditionally calls `loadDetail` (unlike
    // `ConversationThreadBox.vue`, it has no "already loaded" guard) — stub it out so this test
    // never issues a real HTTP call and never clobbers the fixture seeded above.
    vi.spyOn(store, 'loadDetail').mockResolvedValue(undefined);

    return mount(ConversationDetailPanel, {
      props: { conversationId: 'conv1', active: true },
      // `EditsList` also fetches on mount via its own store — irrelevant to this toggle test, and
      // stubbed for the same reason `ConversationThreadBox.spec.ts` stubs `ConversationView` above.
      global: { plugins: [pinia], stubs: { EditsList: true } },
    });
  }

  it('a long message in the focused/detail-panel view defaults collapsed with a working "Show more" toggle', async () => {
    const wrapper = mountFocusedPanel([makeMessage({ id: 'm1', text: 'a'.repeat(2000) })]);
    mockTallScrollHeight(wrapper.getComponent(MessageBubble).get('.message-text').element);
    await wrapper.vm.$nextTick();

    const bubble = wrapper.getComponent(MessageBubble);
    expect(bubble.props('expanded')).toBe(false);
    const toggle = bubble.get('.expand-toggle-button');
    expect(toggle.text()).toBe('Show more');

    await toggle.trigger('click');
    await wrapper.vm.$nextTick();

    // The key regression assertion: clicking the toggle must actually flip the message's own
    // `expanded` prop (via `ConversationView.vue`'s `update:expanded` listener), not just emit an
    // event nobody catches.
    const bubbleAfter = wrapper.getComponent(MessageBubble);
    expect(bubbleAfter.props('expanded')).toBe(true);
    expect(bubbleAfter.get('.expand-toggle-button').text()).toBe('Show less');
    expect((bubbleAfter.get('.message-text').element as HTMLElement).style.maxHeight).toBe('');
  });

  it('persists the focused view\'s toggle to localStorage, keyed by message id (shared with the thread-box view)', async () => {
    const wrapper = mountFocusedPanel([makeMessage({ id: 'm1', text: 'a'.repeat(2000) })]);
    mockTallScrollHeight(wrapper.getComponent(MessageBubble).get('.message-text').element);
    await wrapper.vm.$nextTick();

    await wrapper.getComponent(MessageBubble).get('.expand-toggle-button').trigger('click');
    await wrapper.vm.$nextTick();

    const stored = JSON.parse(localStorage.getItem('raidr:messageExpanded') ?? '{}');
    expect(stored.m1).toBe(true);
  });
});

// specs/005-canvas-conversation-threads — NEW desired behavior, not yet implemented.
//
// Today, branching always auto-sends a seed message as the branch's first (and, at creation time,
// only) message — see conversation-service.ts's `branch()` — so a freshly-created branch never
// actually renders as an empty box. The new behavior instead makes branch creation NOT send any
// seed message at all (the branch starts with zero of its own messages), and — since a blank box
// with no messages and no `seedSelection` breadcrumb would otherwise be a jarring dead end —
// `ConversationThreadBox` borrows exactly two messages from its parent for read-only display: the
// last user message and the last assistant message, up to and including the parent message this
// branch forked from (the NEW `forkedFromMessageId` field tested in
// `conversation-mapper.test.ts`/`branch-continuity.test.ts`). Borrowed messages are never written
// into this conversation's own `messagesByConversation[conversationId]` — they come from the
// parent's own already-loaded message list (`store.messagesFor(parentId)`), which every
// conversation on the canvas already fetches independently (`onMounted` in this same component).
//
// This test's own contract for what that looks like in the DOM (a `.continuity-context` wrapper
// around two `MessageBubble`s) is this suite's own choice, not dictated by the spec — a real
// implementation is free to use different markup as long as the underlying behavior (which two
// messages, sourced from where, never counted as this conversation's own) holds.
describe('ConversationThreadBox — continuity context for a freshly-created placeholder branch (NEW behavior)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  function mountBranchBox(opts: {
    branchOverrides?: Partial<ConversationDto>;
    parentMessages?: ConversationMessageState[];
    branchMessages?: ConversationMessageState[];
  }) {
    const store = useConversationsStore();
    store.conversations = [
      conversationFixture({ id: 'parent1', name: 'Parent' }),
      // NEW field `forkedFromMessageId` doesn't exist on `ConversationDto` yet — cast documents
      // the shape this test expects once a separate implementation pass adds it.
      {
        ...conversationFixture({
          id: 'branch1',
          name: 'Branch',
          parentId: 'parent1',
          kind: 'branch',
          branchDepth: 1,
        }),
        ...(opts.branchOverrides ?? {}),
      } as ConversationDto,
    ];
    if (opts.parentMessages) store.messagesByConversation['parent1'] = opts.parentMessages;
    store.messagesByConversation['branch1'] = opts.branchMessages ?? [];

    return mount(ConversationThreadBox, {
      props: { conversationId: 'branch1' },
      global: { plugins: [pinia], stubs: { ConversationView: true } },
    });
  }

  const PARENT_HISTORY: ConversationMessageState[] = [
    makeMessage({ id: 'm1', role: 'user', text: 'root question' }),
    makeMessage({ id: 'm2', role: 'assistant', text: 'root answer' }),
    makeMessage({ id: 'm3', role: 'user', text: 'second question' }),
    makeMessage({ id: 'm4', role: 'assistant', text: 'second answer — this is the fork point' }),
    // Sent in the parent AFTER this branch was created — must never leak into the branch's
    // borrowed context, which is fixed at the fork point.
    makeMessage({ id: 'm5', role: 'user', text: 'post-fork question' }),
    makeMessage({ id: 'm6', role: 'assistant', text: 'post-fork answer' }),
  ];

  it("renders the parent's last user and last assistant message up to the fork point as read-only context, and they are not part of this conversation's own messages", async () => {
    const wrapper = mountBranchBox({
      branchOverrides: { forkedFromMessageId: 'm4' } as Partial<ConversationDto>,
      parentMessages: PARENT_HISTORY,
      branchMessages: [],
    });
    await wrapper.vm.$nextTick();

    const context = wrapper.find('.continuity-context');
    expect(context.exists()).toBe(true);

    const contextBubbles = context.findAllComponents(MessageBubble);
    expect(contextBubbles).toHaveLength(2);
    expect(contextBubbles.map((b) => b.props('message').text)).toEqual([
      'second question',
      'second answer — this is the fork point',
    ]);
    // Post-fork parent messages must never appear.
    expect(wrapper.text()).not.toContain('post-fork question');
    expect(wrapper.text()).not.toContain('post-fork answer');

    // Borrowed messages are display-only — this conversation's own message list stays empty.
    const store = useConversationsStore();
    expect(store.messagesFor('branch1')).toEqual([]);
    expect(wrapper.find('.thread-messages').findAllComponents(MessageBubble)).toHaveLength(0);
  });

  it('renders no continuity context once the branch has sent its own first message (no longer a blank-slate placeholder)', async () => {
    const wrapper = mountBranchBox({
      branchOverrides: { forkedFromMessageId: 'm4' } as Partial<ConversationDto>,
      parentMessages: PARENT_HISTORY,
      branchMessages: [makeMessage({ id: 'own1', role: 'user', text: "the branch's own first message" })],
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.continuity-context').exists()).toBe(false);
  });

  it('renders no continuity context when there is no forkedFromMessageId (e.g. a branch created from a document selection, with no message-level fork point)', async () => {
    const wrapper = mountBranchBox({
      branchOverrides: { forkedFromMessageId: null } as Partial<ConversationDto>,
      parentMessages: PARENT_HISTORY,
      branchMessages: [],
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.continuity-context').exists()).toBe(false);
  });
});

// Parity fix (005-canvas-conversation-threads follow-up): the sidebar's compact
// `ConversationThreadBox.vue` offers "Expand all"/"Collapse all" and "Branch" header actions that
// the focused/detail view (`ConversationDetailPanel.vue` hosting `ConversationView.vue`) previously
// lacked entirely. Mounts the same real `ConversationDetailPanel.vue` used for the focused overlay
// in `App.vue` (not `ConversationView.vue` in isolation), the same convention as the
// expand/collapse regression suite above.
describe('ConversationDetailPanel/ConversationView — Expand all/Branch parity with the sidebar box', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    vi.mocked(httpClient.branchConversation).mockReset();
  });

  function mountFocusedPanel(
    messages: ConversationMessageState[],
    conversationOverrides: Partial<ConversationDto> = {},
  ) {
    const store = useConversationsStore();
    store.conversations = [conversationFixture(conversationOverrides)];
    store.messagesByConversation['conv1'] = messages;
    vi.spyOn(store, 'loadDetail').mockResolvedValue(undefined);

    return { store, wrapper: mount(ConversationDetailPanel, {
      props: { conversationId: 'conv1', active: true },
      global: { plugins: [pinia], stubs: { EditsList: true } },
    }) };
  }

  it('renders no bulk toggle for a conversation with only one message', () => {
    const { wrapper } = mountFocusedPanel([makeMessage({ id: 'm1' })]);
    expect(wrapper.find('.bulk-toggle-button').exists()).toBe(false);
  });

  it('bulk-expands every message at once via the focused view\'s own "Expand all" button, same as the sidebar box', async () => {
    const { wrapper } = mountFocusedPanel([
      makeMessage({ id: 'm1', text: 'a'.repeat(2000) }),
      makeMessage({ id: 'm2', text: 'b'.repeat(2000) }),
    ]);
    const bubbles = wrapper.findAllComponents(MessageBubble);
    for (const bubble of bubbles) mockTallScrollHeight(bubble.get('.message-text').element);
    await wrapper.vm.$nextTick();

    expect(wrapper.get('.bulk-toggle-button').text()).toBe('Expand all');
    await wrapper.get('.bulk-toggle-button').trigger('click');
    await wrapper.vm.$nextTick();

    const expandedBubbles = wrapper.findAllComponents(MessageBubble);
    expect(expandedBubbles.every((b) => b.props('expanded') === true)).toBe(true);
    expect(wrapper.get('.bulk-toggle-button').text()).toBe('Collapse all');
  });

  it('renders a Branch button, calling store.branch (httpClient.branchConversation) with this conversation as parent', async () => {
    vi.mocked(httpClient.branchConversation).mockResolvedValue(
      conversationFixture({ id: 'branch1', name: 'Branch', parentId: 'conv1', kind: 'branch' }),
    );
    const { wrapper } = mountFocusedPanel([makeMessage({ id: 'm1' })]);

    const branchButton = wrapper.get('.branch-button');
    expect(branchButton.attributes('disabled')).toBeUndefined();
    await branchButton.trigger('click');
    await flushPromises();

    expect(httpClient.branchConversation).toHaveBeenCalledWith({ parentConversationId: 'conv1' });
  });

  it('disables the Branch button when the server-computed canBranch is false (e.g. max depth reached)', () => {
    const { wrapper } = mountFocusedPanel([makeMessage({ id: 'm1' })], { canBranch: false });
    const branchButton = wrapper.get('.branch-button');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toMatch(/maximum conversation depth/i);
  });
});
