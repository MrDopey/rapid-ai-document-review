import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useConversationStatusBadges } from '../../src/composables/conversationStatusBadges.js';
import { useConversationsStore } from '../../src/stores/conversations.js';

// Bug fix (this task): `ConversationView.vue` never rendered a Stale/Orphaned-anchor badge, unlike
// `HudPanel.vue` and `ConversationThreadBox.vue` — all three now share this one composable. These
// tests exercise the composable directly (status × isStale × anchorOrphaned combinations), rather
// than through any one component, since it's now the single source of truth all three surfaces
// render from.

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

describe('useConversationStatusBadges', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it('returns no badges when the conversation cannot be found', () => {
    useConversationsStore().conversations = [];
    const { badges } = useConversationStatusBadges(() => 'missing');
    expect(badges.value).toEqual([]);
  });

  it.each<ConversationDto['status']>(['idle', 'working', 'errored', 'closed'])(
    'always includes the primary status badge (status=%s), with no Stale/Orphaned badges when neither applies',
    (status) => {
      useConversationsStore().conversations = [conversationFixture({ id: 'c1', status })];
      const { badges } = useConversationStatusBadges(() => 'c1');
      expect(badges.value).toEqual([{ key: 'status', className: 'status-badge', dataStatus: status, label: status }]);
    },
  );

  it('adds a Stale badge (in addition to the status badge) when isStale is true', () => {
    useConversationsStore().conversations = [conversationFixture({ id: 'c1', status: 'idle', isStale: true })];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'stale']);
    const stale = badges.value.find((b) => b.key === 'stale')!;
    expect(stale.className).toBe('stale-badge');
    expect(stale.label).toBe('Stale');
    expect(stale.title).toMatch(/Refresh \+ Send/);
    expect(stale.dataStatus).toBeUndefined();
  });

  it('adds an Orphaned anchor badge (in addition to the status badge) when anchorOrphaned is true', () => {
    useConversationsStore().conversations = [conversationFixture({ id: 'c1', anchorOrphaned: true })];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'orphaned']);
    const orphaned = badges.value.find((b) => b.key === 'orphaned')!;
    expect(orphaned.className).toBe('orphaned-badge');
    expect(orphaned.label).toBe('Orphaned anchor');
    expect(orphaned.title).toMatch(/highlighted text/);
    // Unlike the other two badges, this one's accessible name is deliberately the fuller `title`
    // text, matching `ConversationThreadBox.vue`'s pre-existing behavior for this one badge.
    expect(orphaned.ariaLabel).toBe(orphaned.title);
  });

  it('renders all three badges together (status + Stale + Orphaned anchor), in that fixed order', () => {
    useConversationsStore().conversations = [
      conversationFixture({ id: 'c1', status: 'working', isStale: true, anchorOrphaned: true }),
    ];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'stale', 'orphaned']);
  });

  it('excludes pendingEditCount/queueInfo — those stay HudPanel.vue-only, out of scope here', () => {
    useConversationsStore().conversations = [conversationFixture({ id: 'c1', pendingEditCount: 5 })];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status']);
  });

  it('reacts to the underlying conversation changing (e.g. isStale flipping true -> false)', () => {
    const store = useConversationsStore();
    store.conversations = [conversationFixture({ id: 'c1', isStale: true })];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'stale']);

    store.conversations[0]!.isStale = false;
    expect(badges.value.map((b) => b.key)).toEqual(['status']);
  });
});
