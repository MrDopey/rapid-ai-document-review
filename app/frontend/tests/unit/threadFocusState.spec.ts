import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useThreadFocusState } from '../../src/composables/threadFocusState.js';
import { useThreadStore } from '../../src/stores/thread.js';

// 011-linear-thread-mode: Thread mode's own equivalent of `focusPanelState.ts`, but with a single
// cursor (`activeThreadId`) rather than a multi-focus set — see that module's own doc comment.
// `HudPanel.vue` itself independently computes the "next id" for its own Ctrl+Alt+J/K, so these
// tests cover `threadFocusState.ts`'s own copy of that same cycle/wrap logic in isolation, plus
// that its `orderedThreadIds`/`orderedEntries` genuinely reflect the on-screen tree order (already
// covered in depth by `threadTreeOrder.spec.ts` — this file only needs to confirm the composable
// wires that ordering through correctly, not re-prove every ordering rule).

function threadFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
  return {
    name: overrides.id,
    kind: 'thread-root',
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
    seedSelection: null,
    anchorOrphaned: false,
    forkedFromMessageId: null,
    doneAt: null,
    seedExcerptText: null,
    ...overrides,
  };
}

describe('useThreadFocusState', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function seedThreeThreads(): void {
    const store = useThreadStore();
    store.threads = [
      threadFixture({ id: 'root-1', createdAt: '2026-01-01T00:00:00.000Z' }),
      threadFixture({ id: 'root-2', createdAt: '2026-01-01T00:01:00.000Z' }),
      threadFixture({ id: 'root-3', createdAt: '2026-01-01T00:02:00.000Z' }),
    ];
  }

  it('starts with no active thread and an empty-safe cycle (no-op on an empty tree)', () => {
    const focus = useThreadFocusState();
    expect(focus.activeThreadId.value).toBeNull();
    expect(() => focus.cycleByOffset(1)).not.toThrow();
    expect(focus.activeThreadId.value).toBeNull();
  });

  it('exposes threads in DFS/tree order via orderedThreadIds', () => {
    seedThreeThreads();
    const focus = useThreadFocusState();
    expect(focus.orderedThreadIds.value).toEqual(['root-1', 'root-2', 'root-3']);
  });

  it('cycleByOffset(1) with nothing active yet jumps to the first thread', () => {
    seedThreeThreads();
    const focus = useThreadFocusState();
    focus.cycleByOffset(1);
    expect(focus.activeThreadId.value).toBe('root-1');
  });

  it('cycleByOffset(1) advances forward and wraps from the last back to the first', () => {
    seedThreeThreads();
    const focus = useThreadFocusState();
    focus.jumpTo('root-3');
    focus.cycleByOffset(1);
    expect(focus.activeThreadId.value).toBe('root-1');
  });

  it('cycleByOffset(-1) moves backward and wraps from the first back to the last', () => {
    seedThreeThreads();
    const focus = useThreadFocusState();
    focus.jumpTo('root-1');
    focus.cycleByOffset(-1);
    expect(focus.activeThreadId.value).toBe('root-3');
  });

  it('jumpTo sets the cursor directly, independent of cycling', () => {
    seedThreeThreads();
    const focus = useThreadFocusState();
    focus.jumpTo('root-2');
    expect(focus.activeThreadId.value).toBe('root-2');
  });
});
