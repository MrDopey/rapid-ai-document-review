import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { h } from 'vue';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import HudPanel, { type HudItem } from '../../src/components/hud/HudPanel.vue';
import ConversationStatusBadges from '../../src/components/conversation/ConversationStatusBadges.vue';
import { useConversationsStore } from '../../src/stores/conversations.js';

// Spec: specs/005-canvas-conversation-threads, User Story 4 (FR-010), T029. Generalized for
// 011-linear-thread-mode (HudPanel.vue's own top doc comment): this component no longer reads
// `useConversationsStore()`/`orderConversationsByAnchor` itself — it is a pure, prop-driven shell
// over an already-filtered-and-ordered `items: HudItem[]` list, so these tests build that list by
// hand rather than seeding a store and letting the component derive it. Root-anchor
// ordering itself (which conversation ends up where in that list) is covered by
// `ConversationLayout.spec.ts` (the actual `orderConversationsByAnchor` unit under test) — this
// file only needs to prove HudPanel renders `items` in the order given, plus its own
// selection/focus/hotkey/badge-slot behavior.

function hudItem(overrides: Partial<HudItem> & { id: string; name: string }): HudItem {
  return { depth: 0, isPrimary: false, ...overrides };
}

function mountHud(
  overrides: {
    items?: HudItem[];
    activeId?: string | null;
    focusedIds?: ReadonlySet<string>;
    focusCap?: number;
  } = {},
) {
  return mount(HudPanel, {
    props: {
      items: overrides.items ?? [],
      activeId: overrides.activeId ?? null,
      focusedIds: overrides.focusedIds ?? new Set(),
      focusCap: overrides.focusCap ?? 3,
      filter: 'all',
    },
  });
}

function rowNames(wrapper: ReturnType<typeof mountHud>): string[] {
  return wrapper.findAll('.conversation-row .name').map((el) => el.text());
}

describe('HudPanel — renders `items` in the given order (prop-driven, no ordering of its own)', () => {
  it('renders one row per item, in exactly the order the `items` prop lists them', () => {
    const wrapper = mountHud({
      items: [
        hudItem({ id: 'b', name: 'Highlight B' }),
        hudItem({ id: 'a', name: 'Highlight A' }),
        hudItem({ id: 'main', name: 'Main' }),
      ],
    });
    expect(rowNames(wrapper)).toEqual(['Highlight B', 'Highlight A', 'Main']);
  });

  it('indents a row by `depth * 0.3rem`, for tree/branch-depth-driven callers (canvas mode, Thread mode)', () => {
    const wrapper = mountHud({
      items: [hudItem({ id: 'a', name: 'A', depth: 0 }), hudItem({ id: 'b', name: 'B', depth: 2 })],
    });
    const lis = wrapper.findAll('li');
    expect(lis[0]!.attributes('style')).toContain('padding-left: 0rem');
    expect(lis[1]!.attributes('style')).toContain('padding-left: 0.6rem');
  });

  it('respects a `label`/`ariaLabel` prop for the heading and nav landmark (e.g. "Threads" for Thread mode)', () => {
    const wrapper = mountHud({ items: [] });
    expect(wrapper.find('nav').attributes('aria-label')).toBe('Conversations');
    expect(wrapper.find('h2').text()).toBe('Conversations');
  });

  it('hides the Active/All filter toggle entirely when `showFilter` is false (Thread mode has no such concept)', () => {
    const wrapper = mount(HudPanel, {
      props: {
        items: [],
        activeId: null,
        focusedIds: new Set(),
        focusCap: 3,
        filter: 'all',
        showFilter: false,
      },
    });
    expect(wrapper.find('.filter-toggle-button').exists()).toBe(false);
  });

  it('renders the `#actions` slot inside the header, alongside the filter control', () => {
    const wrapper = mount(HudPanel, {
      props: { items: [], activeId: null, focusedIds: new Set(), focusCap: 3, filter: 'all' },
      slots: { actions: '<button class="extra-action">Extra</button>' },
    });
    expect(wrapper.find('.hud-header .extra-action').exists()).toBe(true);
  });
});

// Spec: specs/005-canvas-conversation-threads (multi-focus overlay confirmed design), extending
// T029's coverage to the toggle/cap/focused-state behavior HudPanel.vue's rows now drive (the
// caller owns the actual add/remove/cap logic — these tests only cover what HudPanel.vue itself
// emits and renders from its props, per the component-boundary this file already tests at).
describe('HudPanel — focus toggle/cap affordance', () => {
  function seedTwoItems(): HudItem[] {
    return [hudItem({ id: 'main', name: 'Main' }), hudItem({ id: 'branch', name: 'Branch' })];
  }

  it("a row click emits toggle-focus with that item's id, regardless of current focus state", async () => {
    const wrapper = mountHud({ items: seedTwoItems() });
    await wrapper.find('.conversation-row[data-conversation-id="main"]').trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['main']);
  });

  it('marks a focused row with .is-focused and aria-pressed, and an unfocused one without', () => {
    const wrapper = mountHud({ items: seedTwoItems(), focusedIds: new Set(['main']) });
    const mainRow = wrapper.find('.conversation-row[data-conversation-id="main"]');
    const branchRow = wrapper.find('.conversation-row[data-conversation-id="branch"]');
    expect(mainRow.classes()).toContain('is-focused');
    expect(mainRow.find('.conversation-title').attributes('aria-pressed')).toBe('true');
    expect(branchRow.classes()).not.toContain('is-focused');
    expect(branchRow.find('.conversation-title').attributes('aria-pressed')).toBe('false');
  });

  it('dims and aria-disables a row that would exceed the live cap, with a title explaining why — but an already-focused row stays unaffected regardless of cap', () => {
    // At cap (1) with only "main" focused: "branch" (not focused) can't be added — "main" itself
    // (already focused) must stay fully enabled since toggling off is never capped.
    const wrapper = mountHud({ items: seedTwoItems(), focusedIds: new Set(['main']), focusCap: 1 });
    const mainRow = wrapper.find('.conversation-row[data-conversation-id="main"]');
    const branchRow = wrapper.find('.conversation-row[data-conversation-id="branch"]');

    expect(mainRow.classes()).not.toContain('focus-disabled');
    expect(mainRow.attributes('aria-disabled')).toBe('false');

    expect(branchRow.classes()).toContain('focus-disabled');
    expect(branchRow.attributes('aria-disabled')).toBe('true');
    expect(branchRow.attributes('title')).toMatch(/max 1/);
  });

  it('Ctrl+Alt+J/K emits cycle-focus (not toggle-focus) for the next/previous item from activeId', () => {
    const wrapper = mountHud({ items: seedTwoItems(), activeId: 'main' });
    // `onGlobalKeydown` is a `document`-level listener (mounted for the app's whole lifetime, not
    // scoped to this component's own root) — dispatch directly on `document` rather than
    // `wrapper.trigger`, which only dispatches (and bubbles from) the wrapper's own root element.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
    );
    expect(wrapper.emitted('cycle-focus')?.[0]).toEqual(['branch']);
    expect(wrapper.emitted('toggle-focus')).toBeUndefined();
  });

  it("only reacts to its own `hotkeyScope`'s bindings — a 'Thread list'-scoped instance ignores Ctrl+Alt+J/K bound to 'Conversation list' bindings sharing the same physical combo, and vice versa (both dispatch off the same document-level keydown, filtered by scope)", () => {
    const wrapper = mountHud({ items: seedTwoItems(), activeId: 'main' });
    // Default `hotkeyScope` is 'Conversation list' — this still fires (sanity check the next
    // assertion's negative result isn't just "nothing ever fires").
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
    );
    expect(wrapper.emitted('cycle-focus')).toHaveLength(1);
  });
});

describe('HudPanel — Thread-mode wiring (hotkeyScope + no filter)', () => {
  function seedTwoItems(): HudItem[] {
    return [hudItem({ id: 't1', name: 'Root' }), hudItem({ id: 't2', name: 'Branch' })];
  }

  it("a 'Thread list'-scoped instance cycles on Ctrl+Alt+J/K", () => {
    const wrapper = mount(HudPanel, {
      props: {
        items: seedTwoItems(),
        activeId: 't1',
        focusedIds: new Set(),
        focusCap: Infinity,
        filter: 'all',
        showFilter: false,
        hotkeyScope: 'Thread list',
        label: 'Threads',
      },
    });
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
    );
    expect(wrapper.emitted('cycle-focus')?.[0]).toEqual(['t2']);
  });
});

// Bug fix regression coverage (consolidation of `ConversationStatusBadges.vue`/
// `ConversationActionButtons.vue`, shared with `ConversationThreadBox.vue`/`ConversationView.vue`):
// this topnav panel is the one surface that mounts the shared status badges (now via the `#badge`
// scoped slot, since HudPanel.vue itself no longer knows what a "conversation status" is) but
// deliberately never mounts `ConversationActionButtons` — no action icons show here by design, and
// clicking anywhere on the row (title, status cell, or badges) must keep meaning "toggle this
// item's focus", unaffected by the badges now living in a slotted child component.
describe('HudPanel — badge slot, no action buttons', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function conversationFixture(
    overrides: Partial<ConversationDto> & { id: string },
  ): ConversationDto {
    return {
      name: overrides.id,
      kind: 'main',
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

  function mountWithBadgeSlot(items: HudItem[]) {
    return mount(HudPanel, {
      props: { items, activeId: null, focusedIds: new Set(), focusCap: 3, filter: 'all' },
      global: { plugins: [pinia] },
      slots: {
        badge: (slotProps: { item: HudItem }) =>
          h(ConversationStatusBadges, { conversationId: slotProps.item.id }),
      },
    });
  }

  it('renders the Stale badge for a stale conversation, via the `#badge` slot', () => {
    const store = useConversationsStore();
    store.loaded = true;
    store.conversations = [conversationFixture({ id: 'main', isStale: true })];

    const wrapper = mountWithBadgeSlot([hudItem({ id: 'main', name: 'Main' })]);
    const row = wrapper.find('.conversation-row[data-conversation-id="main"]');
    expect(row.find('.stale-badge').exists()).toBe(true);
    expect(row.find('.stale-badge').text()).toBe('Stale');
  });

  it('renders no action buttons for any row (topnav shows no action icons, by design)', () => {
    const wrapper = mountHud({ items: [hudItem({ id: 'main', name: 'Main' })] });
    expect(wrapper.find('.action-button').exists()).toBe(false);
    expect(wrapper.find('[data-action]').exists()).toBe(false);
  });

  it('a click anywhere on the row (including over the badges) still emits toggle-focus', async () => {
    const store = useConversationsStore();
    store.loaded = true;
    store.conversations = [conversationFixture({ id: 'main', isStale: true })];

    const wrapper = mountWithBadgeSlot([hudItem({ id: 'main', name: 'Main' })]);
    await wrapper.find('.stale-badge').trigger('click');
    expect(wrapper.emitted('toggle-focus')?.[0]).toEqual(['main']);
  });
});
