import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThreadStore } from '../../src/stores/thread.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';
import { httpClient } from '../../src/transport/http-client.js';
import type { ServerFrame } from '../../src/transport/ws-client.js';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useDocumentStore } from '../../src/stores/document.js';

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    retryThread: vi.fn(),
    renameThread: vi.fn(),
  },
}));

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

// Parity fix (011-linear-thread-mode follow-up): before this, `handleServerFrame` silently ignored
// `conversation_status_changed`/`agent_error`/`agent_started` — a Thread's agent turn could fail
// with no visible signal and no way to retry. These events are emitted identically for a
// thread-kind conversation as for a canvas one; see `conversations.ts`'s own equivalent handling.
describe('thread store — handleServerFrame: agent-turn status/error events', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.retryThread).mockReset().mockResolvedValue({
      accepted: true,
      status: 'working',
    });
  });

  function statusChangedFrame(status: 'idle' | 'working' | 'errored' | 'closed'): ServerFrame {
    return {
      kind: 'event',
      frame: {
        type: 'conversation_status_changed',
        sequence: null,
        documentId: 'doc-1',
        conversationId: 'thread-1',
        at: new Date().toISOString(),
        data: { status, previousStatus: 'idle' },
      },
    } as unknown as ServerFrame;
  }

  function agentErrorFrame(): ServerFrame {
    return {
      kind: 'event',
      frame: {
        type: 'agent_error',
        sequence: null,
        documentId: 'doc-1',
        conversationId: 'thread-1',
        at: new Date().toISOString(),
        data: { message: 'The agent hit an error.', retryable: true },
      },
    } as unknown as ServerFrame;
  }

  it("conversation_status_changed updates the matching thread's status field", () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'thread-1', status: 'idle' })];

    store.handleServerFrame(statusChangedFrame('errored'));

    expect(store.findThread('thread-1')?.status).toBe('errored');
  });

  it('conversation_status_changed for an unknown thread id is a harmless no-op', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'thread-1', status: 'idle' })];
    const frame = statusChangedFrame('errored');
    (frame as { frame: { conversationId: string } }).frame.conversationId = 'some-other-thread';

    expect(() => store.handleServerFrame(frame)).not.toThrow();
    expect(store.findThread('thread-1')?.status).toBe('idle');
  });

  it('agent_error does not throw and leaves status alone (conversation_status_changed owns that)', () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'thread-1', status: 'idle' })];

    expect(() => store.handleServerFrame(agentErrorFrame())).not.toThrow();
    expect(store.findThread('thread-1')?.status).toBe('idle');
  });

  it('retry() calls httpClient.retryThread for the given thread id', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'thread-1', status: 'errored' })];
    useDocumentStore().activeDocumentId = 'doc-1';

    await store.retry('thread-1');

    expect(httpClient.retryThread).toHaveBeenCalledWith('doc-1', 'thread-1');
  });
});

// Parity fix (011-linear-thread-mode follow-up): a Thread's own name can be renamed exactly the
// same way a canvas conversation's can.
describe('thread store — rename', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.renameThread).mockReset();
  });

  it('calls httpClient.renameThread and upserts the returned DTO', async () => {
    const store = useThreadStore();
    store.threads = [threadFixture({ id: 'thread-1', name: 'Old Name' })];
    useDocumentStore().activeDocumentId = 'doc-1';
    vi.mocked(httpClient.renameThread).mockResolvedValue(
      threadFixture({ id: 'thread-1', name: 'New Name' }),
    );

    await store.rename('thread-1', 'New Name');

    expect(httpClient.renameThread).toHaveBeenCalledWith('doc-1', 'thread-1', 'New Name');
    expect(store.findThread('thread-1')?.name).toBe('New Name');
  });
});
