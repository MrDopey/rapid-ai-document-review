import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { computeAnchorY, type AnchorPositionSource } from '../../src/components/canvas/anchorY.js';
import ConversationThreadBox from '../../src/components/conversation/ConversationThreadBox.vue';
import { useConversationsStore } from '../../src/stores/conversations.js';
import { httpClient } from '../../src/transport/http-client.js';

// Rename UI (title edit) below drives `useConversationsStore().rename()`, which calls through to
// `httpClient.renameConversation` — mocked here (same convention as App.spec.ts) so these tests
// never hit a real network call.
// Branch-cap parity fix below also drives `useConversationsStore().branch()`, which calls through
// to `httpClient.branchConversation` — mocked here alongside the pre-existing rename mock.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    getConversation: vi.fn(),
    renameConversation: vi.fn(),
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

// Spec: specs/005-canvas-conversation-threads (data-model.md's ConversationLayout.anchorY, T011).
// Tests the anchor-Y helper directly against a fake `AnchorPositionSource` (a stand-in for
// EditorComponent.vue's exposed `anchorTop`, which itself wraps CodeMirror's `coordsAtPos`) rather
// than mounting the whole component tree, since the helper's logic is what T011 is actually about.

function fakeEditor(topByPos: Record<number, number | null>): AnchorPositionSource {
  return {
    anchorTop: (pos: number) => topByPos[pos] ?? null,
  };
}

describe('computeAnchorY', () => {
  it('returns 0 for a null seedSelection (Main, anchored to the top of the document)', () => {
    expect(computeAnchorY(null, fakeEditor({}))).toBe(0);
  });

  it('returns 0 when no editor is available yet, regardless of seedSelection', () => {
    expect(computeAnchorY({ from: 42, to: 60, text: 'excerpt' }, null)).toBe(0);
  });

  it('resolves the pixel Y of the selection start via the editor', () => {
    const editor = fakeEditor({ 42: 123.5 });
    expect(computeAnchorY({ from: 42, to: 60, text: 'excerpt' }, editor)).toBe(123.5);
  });

  it('falls back to 0 when the editor cannot resolve the position (e.g. an orphaned anchor past the end of a shorter document)', () => {
    const editor = fakeEditor({ 42: null });
    expect(computeAnchorY({ from: 42, to: 60, text: 'excerpt' }, editor)).toBe(0);
  });
});

// Spec: specs/005-canvas-conversation-threads (multi-focus overlay confirmed design). Covers the
// Focus button's `isFocused`/`focusDisabled`/`maxFocused` props — App.vue/DocumentCanvas.vue own
// the actual add/remove/cap logic; this only tests what this component itself emits and renders.

function conversationFixture(
  overrides: Partial<ConversationDto> & { id: string },
): ConversationDto {
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
    ...overrides,
  };
}

describe('ConversationThreadBox — focus-aware Focus/Close buttons', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountBox(
    props: { isFocused?: boolean; focusDisabled?: boolean; maxFocused?: number } = {},
  ) {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'conv-1', name: 'Conv One' })];
    // Seeds `messagesByConversation` so the component's own `onMounted` guard skips its real
    // `loadDetail()` HTTP call (this unit test has no server for it) — see `ConversationThreadBox.vue`'s
    // own doc comment on that guard.
    store.messagesByConversation['conv-1'] = [];
    return mount(ConversationThreadBox, {
      props: { conversationId: 'conv-1', ...props },
      global: { plugins: [pinia] },
    });
  }

  it("emits toggle-focus with this conversation's id when the Focus button is clicked", async () => {
    const wrapper = mountBox();
    await wrapper.find('[data-action="focus"]').trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['conv-1']);
  });

  it('renders no Close button, and no disabled affordance, when not focused and under the cap', () => {
    const wrapper = mountBox({ isFocused: false, focusDisabled: false });
    expect(wrapper.find('[data-action="close"]').exists()).toBe(false);
    const focusButton = wrapper.find('[data-action="focus"]');
    expect(focusButton.attributes('aria-pressed')).toBe('false');
    expect(focusButton.attributes('aria-disabled')).toBe('false');
  });

  it('renders a Close button (also wired to toggle-focus) and marks the Focus button pressed when focused', async () => {
    const wrapper = mountBox({ isFocused: true });
    const focusButton = wrapper.find('[data-action="focus"]');
    expect(focusButton.attributes('aria-pressed')).toBe('true');

    const closeButton = wrapper.find('[data-action="close"]');
    expect(closeButton.exists()).toBe(true);
    await closeButton.trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['conv-1']);
  });

  it('dims and aria-disables the Focus button when focusing would exceed the cap, with a title naming the max', () => {
    const wrapper = mountBox({ isFocused: false, focusDisabled: true, maxFocused: 2 });
    const focusButton = wrapper.find('[data-action="focus"]');
    expect(focusButton.attributes('aria-disabled')).toBe('true');
    expect(focusButton.attributes('title')).toMatch(/max 2/);
  });
});

// Branch-cap parity fix (005-canvas-conversation-threads follow-up): the sidebar's "Branch this
// conversation" button is now disabled — with the shared focus-limit tooltip — whenever
// `atFocusCap`, and auto-focuses the newly created branch (via `branch-created`) on every success,
// mirroring `ConversationView.vue`'s focus-view Branch button and `EditorComponent.vue`'s toolbar
// buttons.
describe('ConversationThreadBox — Branch button (cap gating + auto-focus)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.branchConversation).mockReset();
  });

  function mountBox(
    props: { atFocusCap?: boolean; maxFocused?: number; canBranch?: boolean } = {},
  ) {
    const store = useConversationsStore();
    store.conversations = [
      conversationFixture({ id: 'conv-1', name: 'Conv One', canBranch: props.canBranch ?? true }),
    ];
    store.messagesByConversation['conv-1'] = [];
    return mount(ConversationThreadBox, {
      props: {
        conversationId: 'conv-1',
        atFocusCap: props.atFocusCap,
        maxFocused: props.maxFocused,
      },
      global: { plugins: [pinia] },
    });
  }

  it('is enabled, with the plain "Branch this conversation" tooltip, when under the cap', () => {
    const wrapper = mountBox({ atFocusCap: false, maxFocused: 3 });
    const branchButton = wrapper.find('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeUndefined();
    expect(branchButton.attributes('title')).toBe('Branch this conversation');
  });

  it('is disabled, with a focus-limit tooltip naming the max, once at the cap', () => {
    const wrapper = mountBox({ atFocusCap: true, maxFocused: 2 });
    const branchButton = wrapper.find('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toMatch(/max 2/);
    expect(branchButton.attributes('aria-label')).toMatch(/max 2/);
  });

  it('prioritizes the existing "max depth reached" reason over the cap tooltip when both apply', () => {
    const wrapper = mountBox({ atFocusCap: true, maxFocused: 2, canBranch: false });
    const branchButton = wrapper.find('[data-action="branch"]');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toBe('Maximum conversation depth reached');
    expect(branchButton.attributes('title')).not.toMatch(/max 2/);
  });

  it('clicking while at the cap never calls the API and emits nothing', async () => {
    const wrapper = mountBox({ atFocusCap: true, maxFocused: 2 });
    await wrapper.find('[data-action="branch"]').trigger('click');
    expect(httpClient.branchConversation).not.toHaveBeenCalled();
    expect(wrapper.emitted('branch-created')).toBeUndefined();
  });

  it('branches successfully and emits branch-created with the new id when under the cap', async () => {
    vi.mocked(httpClient.branchConversation).mockResolvedValue(
      conversationFixture({ id: 'branch-9' }),
    );
    const wrapper = mountBox({ atFocusCap: false });
    await wrapper.find('[data-action="branch"]').trigger('click');
    await flushPromises();

    expect(httpClient.branchConversation).toHaveBeenCalledWith({ parentConversationId: 'conv-1' });
    expect(wrapper.emitted('branch-created')?.[0]).toEqual(['branch-9']);
  });
});

// Parity fix: `HudPanel.vue`'s `.conversation-row.is-primary` indicator (left accent + tint) had no
// equivalent on this sidebar/canvas box — this proves the box now carries the same `.is-primary`
// class, driven by `conversation.isPrimary`, mirroring HudPanel's own binding.
describe('ConversationThreadBox — Primary conversation indicator', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountBox(isPrimary: boolean) {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'conv-1', name: 'Conv One', isPrimary })];
    store.messagesByConversation['conv-1'] = [];
    return mount(ConversationThreadBox, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
  }

  it('applies the is-primary class when the conversation is Primary', () => {
    const wrapper = mountBox(true);
    expect(wrapper.find('.conversation-thread-box').classes()).toContain('is-primary');
  });

  it('omits the is-primary class when the conversation is not Primary', () => {
    const wrapper = mountBox(false);
    expect(wrapper.find('.conversation-thread-box').classes()).not.toContain('is-primary');
  });
});

// Rename UI: click-to-edit title, save on Enter/blur, cancel on Escape, empty-name validation.
describe('ConversationThreadBox — rename UI', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.renameConversation).mockReset();
  });

  function mountBox() {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'conv-1', name: 'Original Name' })];
    store.messagesByConversation['conv-1'] = [];
    return {
      store,
      wrapper: mount(ConversationThreadBox, {
        props: { conversationId: 'conv-1' },
        global: { plugins: [pinia] },
      }),
    };
  }

  it('shows the plain-text title and a rename button by default, no input', () => {
    const { wrapper } = mountBox();
    expect(wrapper.find('.thread-title').text()).toBe('Original Name');
    expect(wrapper.find('.thread-rename-button').exists()).toBe(true);
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
  });

  it('clicking the rename button opens an input pre-filled with the current name', async () => {
    const { wrapper } = mountBox();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    expect(input.exists()).toBe(true);
    expect(input.element.value).toBe('Original Name');
    expect(wrapper.find('.thread-title').exists()).toBe(false);
  });

  it('saves the new name on Enter, calling the store/API and closing the editor', async () => {
    vi.mocked(httpClient.renameConversation).mockResolvedValue(
      conversationFixture({ id: 'conv-1', name: 'New Name' }),
    );
    const { wrapper, store } = mountBox();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('New Name');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(httpClient.renameConversation).toHaveBeenCalledWith('conv-1', 'New Name');
    expect(store.conversations[0]?.name).toBe('New Name');
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
    expect(wrapper.find('.thread-title').text()).toBe('New Name');
  });

  it('saves on blur, same as Enter', async () => {
    vi.mocked(httpClient.renameConversation).mockResolvedValue(
      conversationFixture({ id: 'conv-1', name: 'Blurred Name' }),
    );
    const { wrapper } = mountBox();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('Blurred Name');
    await input.trigger('blur');
    await flushPromises();

    expect(httpClient.renameConversation).toHaveBeenCalledWith('conv-1', 'Blurred Name');
    expect(wrapper.find('.thread-title').text()).toBe('Blurred Name');
  });

  it('cancels on Escape without calling the API, reverting to the original name', async () => {
    const { wrapper, store } = mountBox();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('Discarded edit');
    await input.trigger('keydown.escape');
    await flushPromises();

    expect(httpClient.renameConversation).not.toHaveBeenCalled();
    expect(store.conversations[0]?.name).toBe('Original Name');
    expect(wrapper.find('.thread-title-input').exists()).toBe(false);
    expect(wrapper.find('.thread-title').text()).toBe('Original Name');
  });

  it('rejects an empty (or whitespace-only) name inline, without calling the API, and keeps editing open', async () => {
    const { wrapper } = mountBox();
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
    const { wrapper } = mountBox();
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
    const { wrapper } = mountBox();
    await wrapper.find('.thread-rename-button').trigger('click');
    const input = wrapper.find<HTMLInputElement>('.thread-title-input');
    await input.setValue('New Name');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(wrapper.find('.rename-error').text()).toBe('Server exploded');
    expect(wrapper.find('.thread-title-input').exists()).toBe(true);
  });
});
