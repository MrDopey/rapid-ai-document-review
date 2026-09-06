import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import HudPanel from '../../src/components/hud/HudPanel.vue';
import { useConversationsStore } from '../../src/stores/conversations.js';

// Spec: specs/005-canvas-conversation-threads, User Story 4 (FR-010), T029.
//
// data-model.md's "HUD ordering": for each visible conversation, resolve its root ancestor (walk
// `parentId` to the nearest ancestor that actually has a `seedSelection`, or Main if none does),
// sort by that root's document-offset position ascending, Main always first, with every
// descendant of a given root grouped contiguously rather than independently re-sorted.

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

describe('HudPanel — root-anchor ordering (FR-010)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountHud(
    overrides: {
      activeId?: string | null;
      focusedIds?: ReadonlySet<string>;
      focusCap?: number;
    } = {},
  ) {
    return mount(HudPanel, {
      props: {
        activeId: overrides.activeId ?? null,
        focusedIds: overrides.focusedIds ?? new Set(),
        focusCap: overrides.focusCap ?? 3,
        filter: 'all',
      },
      global: { plugins: [pinia] },
    });
  }

  function rowNames(wrapper: ReturnType<typeof mountHud>): string[] {
    return wrapper.findAll('.conversation-row .name').map((el) => el.text());
  }

  it('lists Main first, then highlight-anchored conversations by distance from the top of the document, with a branch grouped at its root — regardless of store insertion order', () => {
    const store = useConversationsStore();
    // Pre-marking `loaded` satisfies HudPanel's onMounted guard, so it never issues the real
    // `store.load()` HTTP call this unit test has no server for.
    store.loaded = true;
    // Deliberately scrambled: Main is not first, the two highlights are out of document order,
    // and the branch of Highlight A is inserted right after it (which would already look "right"
    // by luck) — reordered again below to prove insertion order isn't what's driving the result.
    store.conversations = [
      conversationFixture({
        id: 'highlightB',
        name: 'Highlight B',
        kind: 'branch',
        parentId: 'main',
        branchDepth: 1,
        seedSelection: { from: 500, to: 520, text: 'later passage' },
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      conversationFixture({
        id: 'branchOfA',
        name: 'Branch of A',
        kind: 'branch',
        parentId: 'highlightA',
        branchDepth: 2,
        seedSelection: null,
        createdAt: '2026-01-01T00:03:00.000Z',
      }),
      conversationFixture({
        id: 'main',
        name: 'Main',
        kind: 'main',
        parentId: null,
        branchDepth: 0,
        seedSelection: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      conversationFixture({
        id: 'highlightA',
        name: 'Highlight A',
        kind: 'branch',
        parentId: 'main',
        branchDepth: 1,
        seedSelection: { from: 100, to: 120, text: 'earlier passage' },
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
    ];

    const wrapper = mountHud();
    expect(rowNames(wrapper)).toEqual(['Main', 'Highlight A', 'Branch of A', 'Highlight B']);
  });

  it('groups a branch with no seedSelection of its own (created via "Branch this conversation") alongside Main, not as an independent slot', () => {
    const store = useConversationsStore();
    // Pre-marking `loaded` satisfies HudPanel's onMounted guard, so it never issues the real
    // `store.load()` HTTP call this unit test has no server for.
    store.loaded = true;
    store.conversations = [
      conversationFixture({
        id: 'highlight',
        name: 'Highlight',
        parentId: 'main',
        branchDepth: 1,
        seedSelection: { from: 50, to: 60, text: 'x' },
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      conversationFixture({
        id: 'mainBranch',
        name: 'Main Branch',
        kind: 'branch',
        parentId: 'main',
        branchDepth: 1,
        seedSelection: null,
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      conversationFixture({
        id: 'main',
        name: 'Main',
        kind: 'main',
        parentId: null,
        branchDepth: 0,
        seedSelection: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ];

    const wrapper = mountHud();
    // "Main Branch" has no seedSelection anywhere in its own ancestry either (its parent is
    // Main), so it resolves to Main's own root and sits grouped with it, ahead of the genuinely
    // highlight-anchored conversation.
    expect(rowNames(wrapper)).toEqual(['Main', 'Main Branch', 'Highlight']);
  });

  it('respects the "active"/"all" filter prop passed down from App.vue while still applying root-anchor ordering', () => {
    const store = useConversationsStore();
    // Pre-marking `loaded` satisfies HudPanel's onMounted guard, so it never issues the real
    // `store.load()` HTTP call this unit test has no server for.
    store.loaded = true;
    store.conversations = [
      conversationFixture({
        id: 'closedOne',
        name: 'Closed One',
        status: 'closed',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      conversationFixture({
        id: 'main',
        name: 'Main',
        kind: 'main',
        parentId: null,
        seedSelection: null,
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ];

    const wrapper = mount(HudPanel, {
      props: { activeId: null, focusedIds: new Set(), focusCap: 3, filter: 'active' },
      global: { plugins: [pinia] },
    });
    expect(rowNames(wrapper)).toEqual(['Main']);
  });
});

// Spec: specs/005-canvas-conversation-threads (multi-focus overlay confirmed design), extending
// T029's coverage to the toggle/cap/focused-state behavior HudPanel.vue's rows now drive (App.vue
// owns the actual add/remove/cap logic — these tests only cover what HudPanel.vue itself emits and
// renders from its props, per the component-boundary this file already tests at).
describe('HudPanel — focus toggle/cap affordance', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountHud(
    overrides: {
      activeId?: string | null;
      focusedIds?: ReadonlySet<string>;
      focusCap?: number;
    } = {},
  ) {
    return mount(HudPanel, {
      props: {
        activeId: overrides.activeId ?? null,
        focusedIds: overrides.focusedIds ?? new Set(),
        focusCap: overrides.focusCap ?? 3,
        filter: 'all',
      },
      global: { plugins: [pinia] },
    });
  }

  function seedTwoConversations(): void {
    const store = useConversationsStore();
    store.loaded = true;
    store.conversations = [
      conversationFixture({
        id: 'main',
        name: 'Main',
        kind: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      conversationFixture({
        id: 'branch',
        name: 'Branch',
        parentId: 'main',
        branchDepth: 1,
        seedSelection: { from: 10, to: 20, text: 'x' },
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
    ];
  }

  it("a row click emits toggle-focus with that conversation's id, regardless of current focus state", async () => {
    seedTwoConversations();
    const wrapper = mountHud();
    await wrapper.find('.conversation-row[data-conversation-id="main"]').trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['main']);
  });

  it('marks a focused row with .is-focused and aria-pressed, and an unfocused one without', () => {
    seedTwoConversations();
    const wrapper = mountHud({ focusedIds: new Set(['main']) });
    const mainRow = wrapper.find('.conversation-row[data-conversation-id="main"]');
    const branchRow = wrapper.find('.conversation-row[data-conversation-id="branch"]');
    expect(mainRow.classes()).toContain('is-focused');
    expect(mainRow.find('.conversation-title').attributes('aria-pressed')).toBe('true');
    expect(branchRow.classes()).not.toContain('is-focused');
    expect(branchRow.find('.conversation-title').attributes('aria-pressed')).toBe('false');
  });

  it('dims and aria-disables a row that would exceed the live cap, with a title explaining why — but an already-focused row stays unaffected regardless of cap', () => {
    seedTwoConversations();
    // At cap (1) with only "main" focused: "branch" (not focused) can't be added — "main" itself
    // (already focused) must stay fully enabled since toggling off is never capped.
    const wrapper = mountHud({ focusedIds: new Set(['main']), focusCap: 1 });
    const mainRow = wrapper.find('.conversation-row[data-conversation-id="main"]');
    const branchRow = wrapper.find('.conversation-row[data-conversation-id="branch"]');

    expect(mainRow.classes()).not.toContain('focus-disabled');
    expect(mainRow.attributes('aria-disabled')).toBe('false');

    expect(branchRow.classes()).toContain('focus-disabled');
    expect(branchRow.attributes('aria-disabled')).toBe('true');
    expect(branchRow.attributes('title')).toMatch(/max 1/);
  });

  it('Ctrl+Alt+J/K emits cycle-focus (not toggle-focus) for the next/previous conversation from activeId', () => {
    seedTwoConversations();
    const wrapper = mountHud({ activeId: 'main' });
    // `onGlobalKeydown` is a `document`-level listener (mounted for the app's whole lifetime, not
    // scoped to this component's own root) — dispatch directly on `document` rather than
    // `wrapper.trigger`, which only dispatches (and bubbles from) the wrapper's own root element.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
    );
    expect(wrapper.emitted('cycle-focus')?.[0]).toEqual(['branch']);
    expect(wrapper.emitted('toggle-focus')).toBeUndefined();
  });
});

// Bug fix regression coverage (consolidation of `ConversationStatusBadges.vue`/
// `ConversationActionButtons.vue`, shared with `ConversationThreadBox.vue`/`ConversationView.vue`):
// this topnav panel is the one surface that mounts the shared status badges but deliberately never
// mounts `ConversationActionButtons` — no action icons show here by design, and clicking anywhere on
// the row (title, status cell, or badges) must keep meaning "toggle this conversation's focus",
// unaffected by the badges now living in a child component.
describe('HudPanel — shared status badges, no action buttons', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountHud(
    overrides: {
      activeId?: string | null;
      focusedIds?: ReadonlySet<string>;
      focusCap?: number;
    } = {},
  ) {
    return mount(HudPanel, {
      props: {
        activeId: overrides.activeId ?? null,
        focusedIds: overrides.focusedIds ?? new Set(),
        focusCap: overrides.focusCap ?? 3,
        filter: 'all',
      },
      global: { plugins: [pinia] },
    });
  }

  function seedStaleConversation(): void {
    const store = useConversationsStore();
    store.loaded = true;
    store.conversations = [
      conversationFixture({
        id: 'main',
        name: 'Main',
        kind: 'main',
        isStale: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
  }

  it('renders the Stale badge for a stale conversation, via the shared ConversationStatusBadges component', () => {
    seedStaleConversation();
    const wrapper = mountHud();
    const row = wrapper.find('.conversation-row[data-conversation-id="main"]');
    expect(row.find('.stale-badge').exists()).toBe(true);
    expect(row.find('.stale-badge').text()).toBe('Stale');
  });

  it('renders no action buttons for any row (topnav shows no action icons, by design)', () => {
    seedStaleConversation();
    const wrapper = mountHud();
    expect(wrapper.find('.action-button').exists()).toBe(false);
    expect(wrapper.find('[data-action]').exists()).toBe(false);
  });

  it('a click anywhere on the row (including over the badges) still emits toggle-focus', async () => {
    seedStaleConversation();
    const wrapper = mountHud();
    await wrapper.find('.stale-badge').trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['main']);
  });
});
