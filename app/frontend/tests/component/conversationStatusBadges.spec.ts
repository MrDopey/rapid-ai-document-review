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
    // specs/006-archivable-main-conversation T001/T002: required on ConversationDto since US1;
    // defaulted false here (only Main conversations are ever `true`) so every existing fixture call
    // below that doesn't care about it still satisfies the type.
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
      expect(badges.value).toEqual([
        { key: 'status', className: 'status-badge', dataStatus: status, label: status },
      ]);
    },
  );

  it('adds a Stale badge (in addition to the status badge) when isStale is true', () => {
    useConversationsStore().conversations = [
      conversationFixture({ id: 'c1', status: 'idle', isStale: true }),
    ];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'stale']);
    const stale = badges.value.find((b) => b.key === 'stale')!;
    expect(stale.className).toBe('stale-badge');
    expect(stale.label).toBe('Stale');
    expect(stale.title).toMatch(/Refresh \+ Send/);
    expect(stale.dataStatus).toBeUndefined();
  });

  it('adds an Orphaned badge (in addition to the status badge) when anchorOrphaned is true', () => {
    useConversationsStore().conversations = [
      conversationFixture({ id: 'c1', anchorOrphaned: true }),
    ];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'orphaned']);
    const orphaned = badges.value.find((b) => b.key === 'orphaned')!;
    expect(orphaned.className).toBe('orphaned-badge');
    expect(orphaned.label).toBe('Orphaned');
    expect(orphaned.title).toBe(
      'This conversation was originally attached to a specific highlighted passage, but that text has since been edited or removed.',
    );
    // Unlike the other two badges, this one's accessible name is deliberately the fuller `title`
    // text, matching `ConversationThreadBox.vue`'s pre-existing behavior for this one badge.
    expect(orphaned.ariaLabel).toBe(orphaned.title);
  });

  it('renders all three badges together (status + Stale + Orphaned), in that fixed order', () => {
    useConversationsStore().conversations = [
      conversationFixture({ id: 'c1', status: 'working', isStale: true, anchorOrphaned: true }),
    ];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'stale', 'orphaned']);
  });

  it('includes a pending-count badge by default ("full" variant) — parity fix, no longer HudPanel.vue-only', () => {
    useConversationsStore().conversations = [
      conversationFixture({ id: 'c1', pendingEditCount: 5 }),
    ];
    const { badges } = useConversationStatusBadges(() => 'c1');
    expect(badges.value.map((b) => b.key)).toEqual(['status', 'pending']);
    expect(badges.value.find((b) => b.key === 'pending')?.label).toBe('5');
  });

  it('"compact" variant excludes pendingEditCount/queueInfo badges', () => {
    useConversationsStore().conversations = [
      conversationFixture({ id: 'c1', pendingEditCount: 5 }),
    ];
    const { badges } = useConversationStatusBadges(() => 'c1', 'compact');
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

  // specs/006-archivable-main-conversation, T027 (US3): an "Archived Main" badge distinguishes a
  // closed former-current Main from the current Main and from any other closed conversation, when
  // browsing conversation history (spec.md FR-010, research.md §6). Not yet implemented — T029
  // (a separate implementation pass) adds this case to `useConversationStatusBadges`; expected to
  // FAIL until then.
  describe('Archived Main badge (kind === "main" && status === "closed")', () => {
    it('renders an "Archived Main" badge (in addition to the status badge) for a closed Main conversation', () => {
      useConversationsStore().conversations = [
        conversationFixture({ id: 'c1', kind: 'main', status: 'closed', isCurrentMain: false }),
      ];
      const { badges } = useConversationStatusBadges(() => 'c1');
      expect(badges.value.map((b) => b.key)).toEqual(['status', 'archived-main']);
      const archivedMain = badges.value.find((b) => b.key === 'archived-main')!;
      expect(archivedMain.label).toBe('Archived Main');
    });

    it('does NOT render the "Archived Main" badge for the current Main (isCurrentMain: true), regardless of status', () => {
      useConversationsStore().conversations = [
        conversationFixture({ id: 'c1', kind: 'main', status: 'idle', isCurrentMain: true }),
      ];
      const { badges } = useConversationStatusBadges(() => 'c1');
      expect(badges.value.map((b) => b.key)).not.toContain('archived-main');
    });

    it('does NOT render the "Archived Main" badge for a closed non-Main conversation (e.g. a closed branch)', () => {
      useConversationsStore().conversations = [
        conversationFixture({ id: 'c1', kind: 'branch', status: 'closed', isCurrentMain: false }),
      ];
      const { badges } = useConversationStatusBadges(() => 'c1');
      expect(badges.value.map((b) => b.key)).not.toContain('archived-main');
    });
  });
});
