import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThreadStore } from '../../src/stores/thread.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';

// "Quote from here" (companion to highlight-to-branch's `<branch-seed-excerpt>` seed, covered
// backend-side by tests/contract/thread-mode.test.ts's `expect(...).toContain('<branch-seed-excerpt>')`
// assertion): seeds this *same* Thread's own next composer message with the exact same
// XML-tagged excerpt format, via `buildThreadBranchSeedMessage`, rather than creating a branch.
describe('thread store — quoteHighlightIntoComposer / setThreadDraft', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('seeds an empty draft with the highlighted text wrapped in a matching <branch-seed-excerpt> tag pair', () => {
    const store = useThreadStore();
    store.quoteHighlightIntoComposer('thread-1', 'The specific highlighted passage.');

    expect(store.draftByThread['thread-1']).toBe(
      '<branch-seed-excerpt>\n\nThe specific highlighted passage.\n\n</branch-seed-excerpt>',
    );
  });

  it('appends to an already-started draft rather than overwriting it, separated by a blank line', () => {
    const store = useThreadStore();
    store.setThreadDraft('thread-1', "Here's my question about this:");
    store.quoteHighlightIntoComposer('thread-1', 'The specific highlighted passage.');

    expect(store.draftByThread['thread-1']).toBe(
      "Here's my question about this:" +
        '\n\n<branch-seed-excerpt>\n\nThe specific highlighted passage.\n\n</branch-seed-excerpt>',
    );
  });

  it('treats a whitespace-only existing draft the same as empty (no leading blank lines)', () => {
    const store = useThreadStore();
    store.setThreadDraft('thread-1', '   \n  ');
    store.quoteHighlightIntoComposer('thread-1', 'Some passage.');

    expect(store.draftByThread['thread-1']).toBe(
      '<branch-seed-excerpt>\n\nSome passage.\n\n</branch-seed-excerpt>',
    );
  });

  it('setThreadDraft writes a thread-scoped draft directly, independent of other threads', () => {
    const store = useThreadStore();
    store.setThreadDraft('thread-1', 'draft one');
    store.setThreadDraft('thread-2', 'draft two');

    expect(store.draftByThread['thread-1']).toBe('draft one');
    expect(store.draftByThread['thread-2']).toBe('draft two');
  });

  it('pruneStaleThreadState drops drafts for threads no longer in the live list', () => {
    const store = useThreadStore();
    store.setThreadDraft('stale-thread', 'leftover draft');
    store.threads = [];

    store.pruneStaleThreadState();

    expect(store.draftByThread['stale-thread']).toBeUndefined();
  });
});

// Per-branch sticky header (`ThreadCard.vue`'s own "Expand all"/"Collapse all"): the scoped
// counterpart of this store's pre-existing document-wide `anyMessageCollapsed`/`toggleAllMessages`
// (see those actions' own doc comments) — built on the exact same `expandableMessages.ts`
// primitives, but applied to a single thread's own messages only.
describe('thread store — anyMessageCollapsedForThread / toggleAllMessagesForThread', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function makeMessage(id: string): ConversationMessageState {
    return {
      id,
      role: 'assistant',
      text: 'hi',
      reasoning: null,
      isToolCallCarrier: false,
      toolCalls: [],
      streaming: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('reports collapsed when any message in that thread lacks an expanded entry', () => {
    const store = useThreadStore();
    store.messagesByThread['thread-1'] = [makeMessage('m1'), makeMessage('m2')];
    store.expandedByMessage['thread-1'] = { m1: true };

    expect(store.anyMessageCollapsedForThread('thread-1')).toBe(true);
  });

  it('reports not collapsed once every message in that thread is expanded', () => {
    const store = useThreadStore();
    store.messagesByThread['thread-1'] = [makeMessage('m1'), makeMessage('m2')];
    store.expandedByMessage['thread-1'] = { m1: true, m2: true };

    expect(store.anyMessageCollapsedForThread('thread-1')).toBe(false);
  });

  it('toggleAllMessagesForThread expands every message of that thread when any is collapsed, leaving other threads untouched', () => {
    const store = useThreadStore();
    store.messagesByThread['thread-1'] = [makeMessage('m1'), makeMessage('m2')];
    store.messagesByThread['thread-2'] = [makeMessage('m3')];
    store.expandedByMessage['thread-1'] = { m1: false, m2: true };
    store.expandedByMessage['thread-2'] = { m3: false };

    store.toggleAllMessagesForThread('thread-1');

    expect(store.expandedByMessage['thread-1']).toEqual({ m1: true, m2: true });
    // The scoped toggle never touches a sibling thread's own state — unlike the document-wide
    // `toggleAllMessages`, which deliberately folds every mounted thread together.
    expect(store.expandedByMessage['thread-2']).toEqual({ m3: false });
  });

  it('toggleAllMessagesForThread collapses every message of that thread once all are already expanded', () => {
    const store = useThreadStore();
    store.messagesByThread['thread-1'] = [makeMessage('m1'), makeMessage('m2')];
    store.expandedByMessage['thread-1'] = { m1: true, m2: true };

    store.toggleAllMessagesForThread('thread-1');

    expect(store.expandedByMessage['thread-1']).toEqual({ m1: false, m2: false });
  });
});
