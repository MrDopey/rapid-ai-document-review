import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type {
  ConversationDto,
  DiscardConversationResponse,
  MessageDto,
} from '@rapid-ai-document-review/shared/contracts/http';
import ConversationView from '../../src/components/conversation/ConversationView.vue';
import { useConversationsStore } from '../../src/stores/conversations.js';
import { httpClient } from '../../src/transport/http-client.js';

// jsdom doesn't implement `Element.scrollTo` — `ConversationView.vue`'s own sticky-auto-scroll
// (`scrollToBottomIfSticky`) calls it on every `messages`/`awaitingResponse` change, which would
// otherwise throw as an unhandled rejection (it runs inside an async `watch` callback) on every
// mount here. Not this feature's concern; stubbed so it's simply a no-op, same as a real browser
// scrolling an already-empty list.
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {};
}

// 005-canvas-conversation-threads follow-up: a branch placeholder conversation the user created
// and then closed without ever sending a message or leaving unsent draft text behind is discarded
// outright (`store.discardIfEmpty`) rather than kept as permanent clutter — but unsent draft text
// in this view's own composer always takes priority over that cleanup. `ConversationView.vue` is
// the one place that draft text lives (mirrored into `store.drafts` on every change — see its own
// doc comment), so these tests mount it directly rather than the whole App.vue/DetailPanel tree.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    getConversation: vi.fn(),
    listEdits: vi.fn(),
    discardConversation: vi.fn(),
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

function conversationFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
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
    expect(httpClient.discardConversation).toHaveBeenCalledWith('branch-2');
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
    expect(httpClient.discardConversation).toHaveBeenCalledWith('branch-3');
  });

  it('restores a previously left draft when the same conversation is reopened', async () => {
    const first = mountView('branch-4');
    await flushPromises();
    await first.wrapper.find<HTMLTextAreaElement>('#composer-branch-4').setValue('resume this later');
    first.wrapper.unmount();

    // Reopening (e.g. re-focusing the same conversation's panel after closing it) mounts a brand
    // new ConversationView instance — `store.drafts` is what carries the text across that gap.
    const second = mountView('branch-4');
    await flushPromises();
    expect(second.wrapper.find<HTMLTextAreaElement>('#composer-branch-4').element.value).toBe('resume this later');
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
      { id: 'm1', role: 'user', text: 'hi', reasoning: null, toolCalls: [], createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await flushPromises();

    const discarded = await store.discardIfEmpty('branch-5');
    expect(discarded).toBe(false);
    expect(httpClient.discardConversation).not.toHaveBeenCalled();
  });
});
