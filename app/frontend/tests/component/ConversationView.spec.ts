import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type {
  ConversationDto,
  DiscardConversationResponse,
  MessageDto,
} from '@rapid-ai-document-review/shared/contracts/http';
import ConversationView from '../../src/components/conversation/ConversationView.vue';
import MessageBubble from '../../src/components/conversation/MessageBubble.vue';
import ToolCallMessage from '../../src/components/conversation/ToolCallMessage.vue';
import {
  useConversationsStore,
  type ConversationMessageState,
} from '../../src/stores/conversations.js';
import { useDocumentStore } from '../../src/stores/document.js';
import { httpClient } from '../../src/transport/http-client.js';

// jsdom doesn't implement `Element.scrollTo` — `ConversationView.vue`'s own sticky-auto-scroll
// (`scrollToBottomIfSticky`) calls it on every `messages`/`awaitingResponse` change, which would
// otherwise throw as an unhandled rejection (it runs inside an async `watch` callback) on every
// mount here. Not this feature's concern; stubbed so it's simply a no-op, same as a real browser
// scrolling an already-empty list.
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {};
}
// jsdom doesn't implement `Element.scrollIntoView` either — bug fix (scroll-to-top-of-message)
// calls it once a new message actually arrives (composables/messageScroll.ts, via this view's own
// `lastMessageId` watcher). Stubbed as a `vi.fn()` (not a bare no-op) so the dedicated describe
// block below can assert on how/on-what it was called.
Element.prototype.scrollIntoView = vi.fn();

// 005-canvas-conversation-threads follow-up: a branch placeholder conversation the user created
// and then closed without ever sending a message or leaving unsent draft text behind is discarded
// outright (`store.discardIfEmpty`) rather than kept as permanent clutter — but unsent draft text
// in this view's own composer always takes priority over that cleanup. `ConversationView.vue` is
// the one place that draft text lives (mirrored into `store.drafts` on every change — see its own
// doc comment), so these tests mount it directly rather than the whole App.vue/DetailPanel tree.
// Branch-cap parity fix below also drives `useConversationsStore().branch()`, which calls through
// to `httpClient.branchConversation` — mocked here alongside the pre-existing mocks.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    getConversation: vi.fn(),
    listEdits: vi.fn(),
    discardConversation: vi.fn(),
    branchConversation: vi.fn(),
    renameConversation: vi.fn(),
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

describe('ConversationView — draft-aware discard-on-close', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.discardConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  /** Mounts `ConversationView` for a fresh, zero-message branch conversation (mirroring what
   *  `ConversationDetailPanel.vue` renders once a branch has been created but nothing sent yet).
   *  `httpClient.getConversation` (this view's own `onMounted` load) resolves to that same
   *  zero-message state, so the mount settles without needing a real server. */
  function mountView(
    conversationId: string,
    conversationOverrides: Partial<ConversationDto> = {},
    messages: MessageDto[] = [],
  ) {
    useDocumentStore().activeDocumentId = 'doc-1';
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: conversationId, ...conversationOverrides });
    store.conversations = [conversation];
    store.messagesByConversation[conversationId] = messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      reasoning: m.reasoning ?? null,
      streaming: false,
      createdAt: m.createdAt,
    }));
    // Fed the identical `messages` back on this view's own `onMounted` reload, so that async
    // refresh (fired-and-forgotten by `load()`) settles to the same state seeded above instead of
    // clobbering it with something different once `flushPromises()` lets it resolve.
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages,
      stagedEdits: [],
    });
    const wrapper = mount(ConversationView, {
      props: { conversationId },
      global: { plugins: [pinia] },
    });
    return { store, wrapper };
  }

  it('mirrors composer text into store.drafts as the user types', async () => {
    const { store, wrapper } = mountView('branch-1');
    await flushPromises();

    const textarea = wrapper.find<HTMLTextAreaElement>('#composer-branch-1');
    expect(textarea.exists()).toBe(true);
    await textarea.setValue('a half-written question');

    expect(store.drafts['branch-1']).toBe('a half-written question');
  });

  it('discardIfEmpty leaves an untouched branch with draft text in place, preserving the draft', async () => {
    const { store, wrapper } = mountView('branch-1');
    await flushPromises();
    await wrapper.find<HTMLTextAreaElement>('#composer-branch-1').setValue('do not delete me');

    const discarded = await store.discardIfEmpty('branch-1');

    expect(discarded).toBe(false);
    expect(httpClient.discardConversation).not.toHaveBeenCalled();
    expect(store.conversations.some((c) => c.id === 'branch-1')).toBe(true);
    expect(store.drafts['branch-1']).toBe('do not delete me');
  });

  it('discardIfEmpty removes a truly untouched branch (no messages, no draft)', async () => {
    const { store, wrapper } = mountView('branch-2');
    await flushPromises();
    // Never typed into — composer stays at its initial empty value.
    expect(wrapper.find<HTMLTextAreaElement>('#composer-branch-2').element.value).toBe('');

    const response: DiscardConversationResponse = { conversationId: 'branch-2', discarded: true };
    vi.mocked(httpClient.discardConversation).mockResolvedValue(response);

    const discarded = await store.discardIfEmpty('branch-2');

    expect(discarded).toBe(true);
    expect(httpClient.discardConversation).toHaveBeenCalledWith('doc-1', 'branch-2');
    expect(store.conversations.some((c) => c.id === 'branch-2')).toBe(false);
  });

  it('discards through whitespace-only draft text — only non-whitespace content blocks it', async () => {
    const { store, wrapper } = mountView('branch-3');
    await flushPromises();
    await wrapper.find<HTMLTextAreaElement>('#composer-branch-3').setValue('   \n  ');

    // Whitespace-only text can never actually be sent (Send/Refresh+Send both trim-and-check
    // before calling the store), so it isn't real draft *content* — the trigger condition is
    // specifically "non-whitespace draft text", matching the composer's own send-eligibility check.
    const response: DiscardConversationResponse = { conversationId: 'branch-3', discarded: true };
    vi.mocked(httpClient.discardConversation).mockResolvedValue(response);

    const discarded = await store.discardIfEmpty('branch-3');
    expect(discarded).toBe(true);
    expect(httpClient.discardConversation).toHaveBeenCalledWith('doc-1', 'branch-3');
  });

  it('restores a previously left draft when the same conversation is reopened', async () => {
    const first = mountView('branch-4');
    await flushPromises();
    await first.wrapper
      .find<HTMLTextAreaElement>('#composer-branch-4')
      .setValue('resume this later');
    first.wrapper.unmount();

    // Reopening (e.g. re-focusing the same conversation's panel after closing it) mounts a brand
    // new ConversationView instance — `store.drafts` is what carries the text across that gap.
    const second = mountView('branch-4');
    await flushPromises();
    expect(second.wrapper.find<HTMLTextAreaElement>('#composer-branch-4').element.value).toBe(
      'resume this later',
    );
  });

  it('does not discard a conversation that is not a branch (e.g. Main), regardless of messages/draft', async () => {
    const { store } = mountView('main-1', { kind: 'main' });
    await flushPromises();

    const discarded = await store.discardIfEmpty('main-1');
    expect(discarded).toBe(false);
    expect(httpClient.discardConversation).not.toHaveBeenCalled();
    expect(store.conversations.some((c) => c.id === 'main-1')).toBe(true);
  });

  it('does not discard a branch that already has a sent message', async () => {
    const { store } = mountView('branch-5', {}, [
      {
        id: 'm1',
        role: 'user',
        text: 'hi',
        reasoning: null,
        toolCalls: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await flushPromises();

    const discarded = await store.discardIfEmpty('branch-5');
    expect(discarded).toBe(false);
    expect(httpClient.discardConversation).not.toHaveBeenCalled();
  });
});

// Bug fix (this task): `ConversationView.vue` (the focus/detail overlay content) used to read
// `conversation.isStale` only to toggle an `.emphasized` CSS class on the "Refresh + Send" button —
// unlike `HudPanel.vue` (topnav) and `ConversationThreadBox.vue` (sidebar/canvas box), it never
// actually rendered a "Stale"/"Orphaned" badge of its own. Now shares
// `ConversationStatusBadges.vue` with both those surfaces (see `conversationStatusBadges.ts`), so
// this is the regression test proving the badges now appear here too.
describe('ConversationView — Stale/Orphaned badges (bug fix regression)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  function mountView(overrides: Partial<ConversationDto> = {}) {
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1', ...overrides });
    store.conversations = [conversation];
    store.messagesByConversation['conv-1'] = [];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: [],
      stagedEdits: [],
    });
    return mount(ConversationView, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
  }

  it('renders the Stale badge in the header when the conversation is stale', async () => {
    const wrapper = mountView({ isStale: true });
    await flushPromises();
    const staleBadge = wrapper.find('.header-top .stale-badge');
    expect(staleBadge.exists()).toBe(true);
    expect(staleBadge.text()).toBe('Stale');
  });

  it('renders the Orphaned badge in the header when the conversation is anchor-orphaned', async () => {
    const wrapper = mountView({ anchorOrphaned: true });
    await flushPromises();
    const orphanedBadge = wrapper.find('.header-top .orphaned-badge');
    expect(orphanedBadge.exists()).toBe(true);
    expect(orphanedBadge.text()).toBe('Orphaned');
  });

  it('renders neither badge when the conversation is neither stale nor anchor-orphaned', async () => {
    const wrapper = mountView({ isStale: false, anchorOrphaned: false });
    await flushPromises();
    expect(wrapper.find('.stale-badge').exists()).toBe(false);
    expect(wrapper.find('.orphaned-badge').exists()).toBe(false);
  });

  it('still renders the primary status badge alongside the Stale badge', async () => {
    const wrapper = mountView({ isStale: true, status: 'working' });
    await flushPromises();
    const statusBadge = wrapper.find('.header-top .status-badge');
    expect(statusBadge.exists()).toBe(true);
    expect(statusBadge.attributes('data-status')).toBe('working');
  });
});

// Bug fix (005-canvas-conversation-threads follow-up): `ConversationThreadBox.vue` (the sidebar
// box) has always rendered a freshly-created branch's parent's last user+assistant message as
// read-only "continuity context" (see `MessageBubble.spec.ts`'s own
// "ConversationThreadBox — continuity context..." suite) — but this focused/detail view
// (`ConversationView.vue`, hosted by `ConversationDetailPanel.vue`) never had the equivalent, so
// the same continuity context silently disappeared once a branch's detail panel was opened, even
// though it kept rendering correctly in the sidebar box for the exact same conversation. Both call
// sites now share the same `useConversationContinuity` composable.
describe('ConversationView — continuity context for a freshly-created placeholder branch (focus-view parity)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  function makeMessage(
    overrides: Partial<ConversationMessageState> & { id: string },
  ): ConversationMessageState {
    return {
      role: 'assistant',
      text: 'short text',
      reasoning: null,
      streaming: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
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

  /** Seeds both the branch conversation (focused) AND its parent's already-loaded messages —
   *  mirroring what `DocumentCanvas.vue` guarantees in the real app (every conversation, parent
   *  included, mounts its own `ConversationThreadBox` which independently loads its own messages,
   *  regardless of which conversation currently has a focused detail panel open). */
  function mountFocusView(branchOverrides: Partial<ConversationDto> = {}) {
    const store = useConversationsStore();
    const parent = conversationFixture({ id: 'parent-1', kind: 'main', parentId: null });
    const branch = conversationFixture({
      id: 'branch-1',
      parentId: 'parent-1',
      forkedFromMessageId: 'm4',
      ...branchOverrides,
    });
    store.conversations = [parent, branch];
    store.messagesByConversation['parent-1'] = PARENT_HISTORY;
    store.messagesByConversation['branch-1'] = [];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation: branch,
      messages: [],
      stagedEdits: [],
    });
    return mount(ConversationView, {
      props: { conversationId: 'branch-1' },
      global: { plugins: [pinia] },
    });
  }

  it("renders the parent's last user and last assistant message up to the fork point as read-only context", async () => {
    const wrapper = mountFocusView();
    await flushPromises();

    const context = wrapper.find('.continuity-context');
    expect(context.exists()).toBe(true);
    expect(context.text()).toContain('Continued from');

    const contextBubbles = context.findAllComponents(MessageBubble);
    expect(contextBubbles).toHaveLength(2);
    expect(contextBubbles.map((b) => b.props('message').text)).toEqual([
      'second question',
      'second answer — this is the fork point',
    ]);
    expect(wrapper.text()).not.toContain('post-fork question');
    expect(wrapper.text()).not.toContain('post-fork answer');
  });

  it('renders no continuity context when there is no forkedFromMessageId', async () => {
    const wrapper = mountFocusView({ forkedFromMessageId: null });
    await flushPromises();

    expect(wrapper.find('.continuity-context').exists()).toBe(false);
  });
});

// Branch-cap parity fix (005-canvas-conversation-threads follow-up): the focus-view's own "Branch"
// button is now disabled — with the shared focus-limit tooltip — whenever `atFocusCap` (threaded
// down from App.vue via ConversationDetailPanel.vue), and auto-focuses the newly created branch (via
// `branch-created`) on every success, mirroring `ConversationThreadBox.vue`'s sidebar Branch button
// and `EditorComponent.vue`'s toolbar buttons.
describe('ConversationView — Branch button (cap gating + auto-focus)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.branchConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  function mountView(
    props: { atFocusCap?: boolean; maxFocused?: number; canBranch?: boolean } = {},
  ) {
    useDocumentStore().activeDocumentId = 'doc-1';
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1', canBranch: props.canBranch ?? true });
    store.conversations = [conversation];
    store.messagesByConversation['conv-1'] = [];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: [],
      stagedEdits: [],
    });
    return mount(ConversationView, {
      props: {
        conversationId: 'conv-1',
        atFocusCap: props.atFocusCap,
        maxFocused: props.maxFocused,
      },
      global: { plugins: [pinia] },
    });
  }

  it('is enabled, with the plain "Branch this conversation" tooltip, when under the cap', async () => {
    const wrapper = mountView({ atFocusCap: false, maxFocused: 3 });
    await flushPromises();
    const branchButton = wrapper.find('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeUndefined();
    expect(branchButton.attributes('title')).toBe('Branch this conversation');
  });

  it('is disabled, with a focus-limit tooltip naming the max, once at the cap', async () => {
    const wrapper = mountView({ atFocusCap: true, maxFocused: 2 });
    await flushPromises();
    const branchButton = wrapper.find('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toMatch(/max 2/);
    expect(branchButton.attributes('aria-label')).toMatch(/max 2/);
  });

  it('prioritizes the existing "max depth reached" reason over the cap tooltip when both apply', async () => {
    const wrapper = mountView({ atFocusCap: true, maxFocused: 2, canBranch: false });
    await flushPromises();
    const branchButton = wrapper.find('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toBe('Maximum conversation depth reached');
    expect(branchButton.attributes('title')).not.toMatch(/max 2/);
  });

  it('clicking while at the cap never calls the API and emits nothing', async () => {
    const wrapper = mountView({ atFocusCap: true, maxFocused: 2 });
    await flushPromises();
    await wrapper.find('[data-action="branch"]').trigger('click');
    expect(httpClient.branchConversation).not.toHaveBeenCalled();
    expect(wrapper.emitted('branch-created')).toBeUndefined();
  });

  it('branches successfully and emits branch-created with the new id when under the cap', async () => {
    const wrapper = mountView({ atFocusCap: false });
    await flushPromises();
    vi.mocked(httpClient.branchConversation).mockResolvedValue(
      conversationFixture({ id: 'branch-9' }),
    );

    await wrapper.find('[data-action="branch"]').trigger('click');
    await flushPromises();

    expect(httpClient.branchConversation).toHaveBeenCalledWith('doc-1', {
      parentConversationId: 'conv-1',
    });
    expect(wrapper.emitted('branch-created')?.[0]).toEqual(['branch-9']);
  });
});

// Rename UI parity fix (005-canvas-conversation-threads follow-up): `ConversationThreadBox.vue`'s
// (sidebar) rename affordance — click-to-edit title, save on Enter/blur, cancel on Escape,
// empty-name validation — is now also available from this focused/detail view. Mirrors
// `ConversationThreadBox.spec.ts`'s own "rename UI" suite exactly, mounting `ConversationView`
// instead.
describe('ConversationView — rename UI', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.renameConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  function mountView() {
    useDocumentStore().activeDocumentId = 'doc-1';
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1', name: 'Original Name' });
    store.conversations = [conversation];
    store.messagesByConversation['conv-1'] = [];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: [],
      stagedEdits: [],
    });
    return {
      store,
      wrapper: mount(ConversationView, {
        props: { conversationId: 'conv-1' },
        global: { plugins: [pinia] },
      }),
    };
  }

  it('shows the plain-text title and a rename button by default, no input', async () => {
    const { wrapper } = mountView();
    await flushPromises();
    expect(wrapper.find('h2').text()).toBe('Original Name');
    expect(wrapper.find('.thread-rename-button').exists()).toBe(true);
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
  });

  it('clicking the rename button opens an input pre-filled with the current name', async () => {
    const { wrapper } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    expect(input.exists()).toBe(true);
    expect(input.element.value).toBe('Original Name');
    expect(wrapper.find('h2').exists()).toBe(false);
  });

  it('saves the new name on Enter, calling the store/API and closing the editor', async () => {
    vi.mocked(httpClient.renameConversation).mockResolvedValue(
      conversationFixture({ id: 'conv-1', name: 'New Name' }),
    );
    const { wrapper, store } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('New Name');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(httpClient.renameConversation).toHaveBeenCalledWith('doc-1', 'conv-1', 'New Name');
    expect(store.conversations[0]?.name).toBe('New Name');
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
    expect(wrapper.find('h2').text()).toBe('New Name');
  });

  it('saves on blur, same as Enter', async () => {
    vi.mocked(httpClient.renameConversation).mockResolvedValue(
      conversationFixture({ id: 'conv-1', name: 'Blurred Name' }),
    );
    const { wrapper } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('Blurred Name');
    await input.trigger('blur');
    await flushPromises();

    expect(httpClient.renameConversation).toHaveBeenCalledWith('doc-1', 'conv-1', 'Blurred Name');
    expect(wrapper.find('h2').text()).toBe('Blurred Name');
  });

  it('cancels on Escape without calling the API, reverting to the original name', async () => {
    const { wrapper, store } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('Discarded edit');
    await input.trigger('keydown.escape');
    await flushPromises();

    expect(httpClient.renameConversation).not.toHaveBeenCalled();
    expect(store.conversations[0]?.name).toBe('Original Name');
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
    expect(wrapper.find('h2').text()).toBe('Original Name');
  });

  it('rejects an empty (or whitespace-only) name inline, without calling the API, and keeps editing open', async () => {
    const { wrapper } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('   ');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(httpClient.renameConversation).not.toHaveBeenCalled();
    expect(wrapper.find('.rename-error').exists()).toBe(true);
    expect(wrapper.find('.thread-title-input').exists()).toBe(true);
  });

  it('does not call the API when saving with the name unchanged, and just closes the editor', async () => {
    const { wrapper } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(httpClient.renameConversation).not.toHaveBeenCalled();
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
  });

  it('shows an inline error and keeps editing open when the API call fails', async () => {
    const { ApiError } = await import('../../src/transport/http-client.js');
    vi.mocked(httpClient.renameConversation).mockRejectedValue(
      new ApiError(500, 'UNKNOWN', 'Server exploded'),
    );
    const { wrapper } = mountView();
    await flushPromises();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('New Name');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(wrapper.find('.rename-error').text()).toBe('Server exploded');
    expect(wrapper.find('.thread-title-input').exists()).toBe(true);
  });
});

// Parity fix: `HudPanel.vue`'s `.conversation-row.is-primary` indicator (left accent + tint) had no
// equivalent on this focused/detail view's own root — this proves the view now carries the same
// `.is-primary` class, driven by `conversation.isPrimary`, mirroring HudPanel's own binding.
describe('ConversationView — Primary conversation indicator', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  function mountView(isPrimary: boolean) {
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1', isPrimary });
    store.conversations = [conversation];
    store.messagesByConversation['conv-1'] = [];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: [],
      stagedEdits: [],
    });
    return mount(ConversationView, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
  }

  it('applies the is-primary class when the conversation is Primary', async () => {
    const wrapper = mountView(true);
    await flushPromises();
    expect(wrapper.find('.conversation-view').classes()).toContain('is-primary');
  });

  it('omits the is-primary class when the conversation is not Primary', async () => {
    const wrapper = mountView(false);
    await flushPromises();
    expect(wrapper.find('.conversation-view').classes()).not.toContain('is-primary');
  });
});

// specs/006-archivable-main-conversation (US1): `archiveOrReviewAction` used to gate "Archive"
// behind `kind !== 'main'` — closing Main was refused outright by the backend
// (`CannotCloseMainConversationError`), so this view never offered the action for it. Now that
// archiving Main is a supported operation (it atomically archives the current Main and replaces it
// with a fresh one), Main gets the same "Archive" action any other open conversation already has —
// unchanged for every other kind/status combination.
describe('ConversationView — archiveOrReviewAction (specs/006-archivable-main-conversation)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  function mountView(overrides: Partial<ConversationDto>) {
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1', ...overrides });
    store.conversations = [conversation];
    store.messagesByConversation['conv-1'] = [];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: [],
      stagedEdits: [],
    });
    return mount(ConversationView, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
  }

  // `archiveOrReviewAction` (ConversationView.vue) branches only on `status`, never on `kind` —
  // consolidated via `it.each` across all three kinds per status branch (rather than one full test
  // body per kind) so this still proves there's no kind-gating (the actual regression this describe
  // block guards against) without three redundant copies of the same status-branch assertion.
  it.each(['main', 'branch', 'review'] as const)(
    'renders the "Archive" action for an open (non-closed) %s conversation',
    async (kind) => {
      const wrapper = mountView({ kind, status: 'idle' });
      await flushPromises();
      const archiveButton = wrapper.find('[data-action="archive"]');
      expect(archiveButton.exists()).toBe(true);
      expect(archiveButton.text()).toBe('Archive');
    },
  );

  it.each(['main', 'branch', 'review'] as const)(
    'renders "Request review", not "Archive", for a closed %s conversation',
    async (kind) => {
      const wrapper = mountView({ kind, status: 'closed' });
      await flushPromises();
      expect(wrapper.find('[data-action="archive"]').exists()).toBe(false);
      expect(wrapper.find('[data-action="request-review"]').exists()).toBe(true);
    },
  );
});

// Bug fix (scroll-to-top-of-message): a new assistant message arriving used to always scroll the
// whole transcript to its bottom (`scrollToBottomIfSticky`, previously wired to a `deep` watch over
// `messages`) — for a long reply, that could show only whatever the tail currently looks like as it
// streams in, never the beginning. Opening a conversation still lands at the bottom of its existing
// history (most-recent-first, same as before this fix); it's only a message arriving *after* that
// which now scrolls to its own top instead. See `ConversationView.vue`'s own `lastMessageId`
// watcher and composables/messageScroll.ts for the implementation.
describe('ConversationView — scroll-to-top-of-message on new/expanded messages', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
  });

  function makeMessage(
    overrides: Partial<ConversationMessageState> & { id: string },
  ): ConversationMessageState {
    return {
      role: 'assistant',
      text: 'short text',
      reasoning: null,
      streaming: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  /** Seeds `messagesByConversation` before mounting (so the very first render already has history
   *  to land at the bottom of) AND feeds the same messages back through the mocked `getConversation`
   *  response, so this view's own unconditional `onMounted` reload settles to the same state rather
   *  than clobbering it with something else once `flushPromises()` lets it resolve. */
  function mountView(conversationId: string, existingMessages: ConversationMessageState[] = []) {
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: conversationId });
    store.conversations = [conversation];
    store.messagesByConversation[conversationId] = existingMessages;
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: existingMessages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        reasoning: m.reasoning,
        toolCalls: [],
        createdAt: m.createdAt,
      })),
      stagedEdits: [],
    });
    const wrapper = mount(ConversationView, {
      props: { conversationId },
      global: { plugins: [pinia] },
    });
    return { store, wrapper };
  }

  it('lands at the bottom of existing history when a conversation is first opened, not scrollIntoView on any one message', async () => {
    const scrollToSpy = vi.spyOn(Element.prototype, 'scrollTo');
    mountView('conv-1', [
      makeMessage({ id: 'm1', role: 'user', text: 'hi' }),
      makeMessage({ id: 'm2', role: 'assistant', text: 'hello' }),
    ]);
    await flushPromises();

    expect(scrollToSpy).toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls a newly-arrived assistant message's own top edge into view, not the list's bottom", async () => {
    const { store } = mountView('conv-1', [
      makeMessage({ id: 'm1', role: 'user', text: 'question' }),
    ]);
    await flushPromises();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // Simulates conversations.ts's `message_started` handler pushing a new streaming message.
    store.messagesByConversation['conv-1']!.push(
      makeMessage({ id: 'm2', role: 'assistant', text: '', streaming: true }),
    );
    await flushPromises();

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    const [target] = vi.mocked(Element.prototype.scrollIntoView).mock.contexts;
    expect((target as HTMLElement).getAttribute('data-message-id')).toBe('m2');
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls[0]?.[0]).toMatchObject({
      block: 'start',
    });
  });

  it('does not re-scroll on every streaming token delta to the same message, only once when it first appears', async () => {
    const { store } = mountView('conv-1', [
      makeMessage({ id: 'm1', role: 'user', text: 'question' }),
    ]);
    await flushPromises();

    store.messagesByConversation['conv-1']!.push(
      makeMessage({ id: 'm2', role: 'assistant', text: 'Hel', streaming: true }),
    );
    await flushPromises();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // A token delta (conversations.ts's `text_delta` handler) mutates the SAME message's `.text` in
    // place — no new id, so this must not trigger another scroll.
    const existing = store.messagesByConversation['conv-1']!.find((m) => m.id === 'm2')!;
    existing.text += 'lo there';
    await flushPromises();

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not auto-scroll a new message into view once the user has deliberately scrolled away from the bottom', async () => {
    const { store, wrapper } = mountView('conv-1', [
      makeMessage({ id: 'm1', role: 'user', text: 'question' }),
    ]);
    await flushPromises();

    const listEl = wrapper.get('.message-list').element;
    Object.defineProperty(listEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(listEl, 'scrollTop', { value: 0, configurable: true, writable: true });
    listEl.dispatchEvent(new Event('scroll'));
    await flushPromises();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    store.messagesByConversation['conv-1']!.push(
      makeMessage({ id: 'm2', role: 'assistant', text: 'reply' }),
    );
    await flushPromises();

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  // Regression test: `conversations.ts`'s WS handlers (`message_started`/`text_delta`) append a
  // brand-new message to `messagesByConversation[id]` via `.push()` on the SAME array instance,
  // rather than reassigning it — a plain `watch(messages, ...)` (where `messages` is a computed
  // wrapping that array) never re-fires for that kind of in-place mutation, since the computed's
  // own tracked dependency is only the outer `messagesByConversation[id]` lookup, not the array's
  // contents. Without watching `messages.value.length` instead, a message that streams in AFTER
  // this view's initial mount never gets seeded into `expandedByMessage`, so it silently falls
  // back to the template's own `?? false` (collapsed) default instead of the role-aware "assistant
  // replies start expanded" default `ensureMessageExpandedSeeded` is supposed to apply.
  it('seeds a newly-pushed assistant message as expanded, not just messages present at mount', async () => {
    const { store } = mountView('conv-1', [
      makeMessage({ id: 'm1', role: 'user', text: 'question' }),
    ]);
    await flushPromises();
    expect(store.expandedByMessage['conv-1']).toEqual({ m1: false });

    store.messagesByConversation['conv-1']!.push(
      makeMessage({ id: 'm2-live', role: 'assistant', text: 'reply', streaming: true }),
    );
    await flushPromises();

    expect(store.expandedByMessage['conv-1']).toEqual({ m1: false, 'm2-live': true });
  });
});

// Tool calls as their own message component (011-linear-thread-mode follow-up): a tool-call-carrier
// message inside a real focused-view transcript must render via `ToolCallMessage.vue`, with
// `data-message-id` present on its root — `composables/messageScroll.ts`'s
// `scrollMessageTopIntoView` depends on that exact selector (this view's own scroll-to-top-of-
// message behavior, covered above for plain messages), so a regression here would silently break
// that scroll target for a carrier message too.
describe('ConversationView — tool-call-carrier message renders via ToolCallMessage', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.getConversation).mockReset();
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
  });

  it('renders a carrier message (with tool-call detail) via ToolCallMessage, carrying data-message-id', async () => {
    const store = useConversationsStore();
    const conversation = conversationFixture({ id: 'conv-1' });
    store.conversations = [conversation];
    const carrier: ConversationMessageState = {
      id: 'tc-1',
      role: 'assistant',
      text: '',
      reasoning: null,
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
      streaming: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    store.messagesByConversation['conv-1'] = [carrier];
    vi.mocked(httpClient.getConversation).mockResolvedValue({
      conversation,
      messages: [
        {
          id: 'tc-1',
          role: 'assistant',
          text: '',
          reasoning: null,
          isToolCallCarrier: true,
          toolCalls: carrier.toolCalls,
          createdAt: carrier.createdAt,
        },
      ],
      stagedEdits: [],
    });

    const wrapper = mount(ConversationView, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();

    const toolCallMessage = wrapper.findComponent(ToolCallMessage);
    expect(toolCallMessage.exists()).toBe(true);
    expect(toolCallMessage.props('message').id).toBe('tc-1');
    const root = wrapper.get('[data-message-kind="tool-call"]');
    expect(root.attributes('data-message-id')).toBe('tc-1');
  });
});
