import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useConversationBranchAction, useBulkToggleAction } from '../../src/composables/conversationActions.js';
import { useConversationsStore, type ConversationMessageState } from '../../src/stores/conversations.js';
import { httpClient } from '../../src/transport/http-client.js';

// Extracted from `ConversationThreadBox.vue` and `ConversationView.vue`, both of which hand-
// duplicated this exact logic (their own doc comments called it out) — these tests exercise the
// composables directly, covering the disabled-reason priority and bulk-toggle label/visibility
// combinations both call sites relied on.

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
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

function conversationFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
  return {
    name: overrides.id,
    kind: 'branch',
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
    anchorOrphaned: false,
    seedSelection: null,
    forkedFromMessageId: null,
    ...overrides,
  };
}

describe('useConversationBranchAction', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.branchConversation).mockReset();
  });

  function setup(conversationOverrides: Partial<ConversationDto> = {}, atFocusCap = false, maxFocused = 3) {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'c1', ...conversationOverrides })];
    const onBranchCreated = vi.fn();
    const result = useConversationBranchAction(() => 'c1', {
      atFocusCap: () => atFocusCap,
      maxFocused: () => maxFocused,
      onBranchCreated,
    });
    return { store, onBranchCreated, ...result };
  }

  it('is enabled with the plain tooltip when canBranch and under the cap', () => {
    const { action } = setup({ canBranch: true });
    expect(action.value.disabled).toBe(false);
    expect(action.value.title).toBe('Branch this conversation');
    expect(action.value.ariaLabel).toBe('Branch this conversation');
    expect(action.value.label).toBe('Branch');
    expect(action.value.key).toBe('branch');
  });

  it('prioritizes "max depth reached" (canBranch=false) over the cap reason when both apply', () => {
    const { action } = setup({ canBranch: false }, true, 2);
    expect(action.value.disabled).toBe(true);
    expect(action.value.title).toBe('Maximum conversation depth reached');
    expect(action.value.title).not.toMatch(/max 2/);
  });

  it('falls back to the cap tooltip (naming maxFocused) once canBranch is true but at the cap', () => {
    const { action } = setup({ canBranch: true }, true, 2);
    expect(action.value.disabled).toBe(true);
    expect(action.value.title).toMatch(/max 2/);
    expect(action.value.ariaLabel).toMatch(/max 2/);
  });

  it('never calls the API and never fires onBranchCreated when clicked while disabled', async () => {
    const { action, onBranchCreated } = setup({ canBranch: false }, true);
    action.value.onClick();
    await flushPromises();
    expect(httpClient.branchConversation).not.toHaveBeenCalled();
    expect(onBranchCreated).not.toHaveBeenCalled();
  });

  it('branches successfully and calls onBranchCreated with the new id', async () => {
    vi.mocked(httpClient.branchConversation).mockResolvedValue(conversationFixture({ id: 'branch-9' }));
    const { action, onBranchCreated } = setup({ canBranch: true });
    action.value.onClick();
    await flushPromises();
    expect(httpClient.branchConversation).toHaveBeenCalledWith({ parentConversationId: 'c1' });
    expect(onBranchCreated).toHaveBeenCalledWith('branch-9');
  });

  it('surfaces a failed branch attempt via the returned error ref', async () => {
    const { ApiError } = await import('../../src/transport/http-client.js');
    vi.mocked(httpClient.branchConversation).mockRejectedValue(new ApiError(500, 'UNKNOWN', 'Server exploded'));
    const { action, error } = setup({ canBranch: true });
    action.value.onClick();
    await flushPromises();
    expect(error.value).toBe('Server exploded');
  });
});

describe('useBulkToggleAction', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function makeMessage(overrides: Partial<ConversationMessageState> & { id: string }): ConversationMessageState {
    return {
      role: 'user',
      text: 'hi',
      reasoning: null,
      streaming: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('is not visible for a conversation with 0 or 1 messages', () => {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'c1' })];
    store.messagesByConversation['c1'] = [makeMessage({ id: 'm1' })];
    const { visible } = useBulkToggleAction(() => 'c1');
    expect(visible.value).toBe(false);
  });

  it('is visible once there is more than one message, labeled "Expand all" while any is collapsed', () => {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'c1' })];
    store.messagesByConversation['c1'] = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
    store.expandedByMessage['c1'] = { m1: false, m2: false };
    const { action, visible } = useBulkToggleAction(() => 'c1');
    expect(visible.value).toBe(true);
    expect(action.value.label).toBe('Expand all');
    expect(action.value.ariaLabel).toBe('Expand all messages in this conversation');
  });

  it('flips to "Collapse all" once every message is expanded', () => {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'c1' })];
    store.messagesByConversation['c1'] = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
    store.expandedByMessage['c1'] = { m1: true, m2: true };
    const { action } = useBulkToggleAction(() => 'c1');
    expect(action.value.label).toBe('Collapse all');
  });

  // Bug fix (0470e9f): this composable no longer takes a host-local `expandedByMessage` ref — it
  // now reads/writes `conversationsStore.expandedByMessage[conversationId]` directly (via
  // `store.setMessagesExpanded`), so both `ConversationThreadBox.vue` and `ConversationView.vue`
  // act on the exact same shared state instead of two refs that could silently diverge. Assert
  // against the store slice itself rather than a local ref.
  it('clicking mutates the shared store.expandedByMessage slice for every message at once', () => {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'c1' })];
    store.messagesByConversation['c1'] = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
    store.expandedByMessage['c1'] = { m1: false, m2: true };
    const { action } = useBulkToggleAction(() => 'c1');

    // Any collapsed (m1) -> clicking expands every message.
    action.value.onClick();
    expect(store.expandedByMessage['c1']).toEqual({ m1: true, m2: true });

    // Now all expanded -> clicking collapses every message.
    action.value.onClick();
    expect(store.expandedByMessage['c1']).toEqual({ m1: false, m2: false });
  });
});
