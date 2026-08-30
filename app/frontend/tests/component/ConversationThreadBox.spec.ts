import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { computeAnchorY, type AnchorPositionSource } from '../../src/components/canvas/anchorY.js';
import ConversationThreadBox from '../../src/components/conversation/ConversationThreadBox.vue';
import { useConversationsStore } from '../../src/stores/conversations.js';

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
    ...overrides,
  };
}

describe('ConversationThreadBox — focus-aware Focus/Close buttons', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountBox(props: { isFocused?: boolean; focusDisabled?: boolean; maxFocused?: number } = {}) {
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

  it('emits toggle-focus with this conversation\'s id when the Focus button is clicked', async () => {
    const wrapper = mountBox();
    await wrapper.find('.focus-button').trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['conv-1']);
  });

  it('renders no Close button, and no disabled affordance, when not focused and under the cap', () => {
    const wrapper = mountBox({ isFocused: false, focusDisabled: false });
    expect(wrapper.find('.close-button').exists()).toBe(false);
    const focusButton = wrapper.find('.focus-button');
    expect(focusButton.classes()).not.toContain('is-focused');
    expect(focusButton.classes()).not.toContain('focus-disabled');
    expect(focusButton.attributes('aria-disabled')).toBe('false');
  });

  it('renders a Close button (also wired to toggle-focus) and marks the Focus button pressed when focused', async () => {
    const wrapper = mountBox({ isFocused: true });
    const focusButton = wrapper.find('.focus-button');
    expect(focusButton.attributes('aria-pressed')).toBe('true');
    expect(focusButton.classes()).toContain('is-focused');

    const closeButton = wrapper.find('.close-button');
    expect(closeButton.exists()).toBe(true);
    await closeButton.trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['conv-1']);
  });

  it('dims and aria-disables the Focus button when focusing would exceed the cap, with a title naming the max', () => {
    const wrapper = mountBox({ isFocused: false, focusDisabled: true, maxFocused: 2 });
    const focusButton = wrapper.find('.focus-button');
    expect(focusButton.classes()).toContain('focus-disabled');
    expect(focusButton.attributes('aria-disabled')).toBe('true');
    expect(focusButton.attributes('title')).toMatch(/max 2/);
  });
});
