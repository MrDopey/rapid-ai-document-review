import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThreadStore } from '../../src/stores/thread.js';

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
