import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDocumentStore } from '../../src/stores/document.js';
import { httpClient, ApiError } from '../../src/transport/http-client.js';
import type { ServerFrame } from '../../src/transport/ws-client.js';

// Covers stores/document.ts's 409-terminal/resync behavior (bf220af/6db3ae1/6c1d3db) and its
// WS event-sequence gap-resync path (01fe287/0470e9f).
vi.mock('../../src/transport/http-client.js', () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;
    constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  return {
    httpClient: {
      getDocument: vi.fn(),
      patchDocument: vi.fn(),
      listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
    },
    ApiError: MockApiError,
  };
});

describe('document store — patchContent 409/retry behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.getDocument).mockReset();
    vi.mocked(httpClient.patchDocument).mockReset();
  });

  it('a genuine-conflict 409 stops retrying, resyncs the document, and sets conflictMessage', async () => {
    const store = useDocumentStore();
    store.activeDocumentId = 'doc-1'; // a real tab always has one active before it can ever patch
    vi.mocked(httpClient.patchDocument).mockRejectedValue(
      new ApiError(409, 'UNKNOWN', 'Document has changed since baseRevision 3'),
    );
    vi.mocked(httpClient.getDocument).mockResolvedValue({
      document: { id: 'doc-1', title: 'Doc', currentRevision: 5, createdAt: '', updatedAt: '' },
      content: 'server-authoritative content',
      eventSequence: 10,
    });

    await store.patchContent(3, [{ from: 0, to: 0, insert: 'x' }]);

    // Never retried beyond the single rejected attempt.
    expect(httpClient.patchDocument).toHaveBeenCalledTimes(1);
    // Resynced from the server rather than keeping this tab's stale local state.
    expect(httpClient.getDocument).toHaveBeenCalledTimes(1);
    expect(store.content).toBe('server-authoritative content');
    expect(store.document?.currentRevision).toBe(5);
    // The rejected edit's own offsets are never resent — conflictMessage is left for the UI
    // instead of silently dropping or corrupting anything.
    expect(store.conflictMessage).toMatch(/wasn't saved|not saved/i);
    expect(store.pendingPatchCount).toBe(0);
  });

  it('clearConflictMessage clears it', async () => {
    const store = useDocumentStore();
    store.conflictMessage = 'This document changed elsewhere while you were editing.';
    store.clearConflictMessage();
    expect(store.conflictMessage).toBeNull();
  });

  // 6c1d3db: a baseRevision gap that only crossed a benign manual_debounce checkpoint no longer
  // produces a 409 at all (fixed server-side, document-service.ts) — from this store's point of
  // view that just means patchDocument resolves normally, same as any other successful patch. The
  // edit is never dropped and no conflictMessage is set.
  it('a baseRevision gap that resolves without a 409 (e.g. only a benign manual_debounce checkpoint in between) succeeds normally, without dropping the edit', async () => {
    const store = useDocumentStore();
    vi.mocked(httpClient.patchDocument).mockResolvedValue({
      currentRevision: 4,
      revisionCreated: false,
    });

    await store.patchContent(3, [{ from: 0, to: 0, insert: 'x' }]);

    expect(httpClient.patchDocument).toHaveBeenCalledTimes(1);
    expect(httpClient.getDocument).not.toHaveBeenCalled();
    expect(store.conflictMessage).toBeNull();
    expect(store.pendingPatchCount).toBe(0);
  });

  it('a non-409 failure (e.g. network error) retries rather than giving up', async () => {
    vi.useFakeTimers();
    try {
      const store = useDocumentStore();
      vi.mocked(httpClient.patchDocument)
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ currentRevision: 4, revisionCreated: false });

      const promise = store.patchContent(3, [{ from: 0, to: 0, insert: 'x' }]);
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(httpClient.patchDocument).toHaveBeenCalledTimes(2);
      expect(store.conflictMessage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('document store — WS event-sequence gap resync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.getDocument).mockReset();
    vi.mocked(httpClient.patchDocument).mockReset();
  });

  function subscribedFrame(sequence: number): ServerFrame {
    return {
      kind: 'subscribed',
      frame: {
        currentSequence: sequence,
        replayCount: 0,
        snapshot: {
          document: {
            id: 'doc-1',
            title: 'Doc',
            currentRevision: 1,
            createdAt: '',
            updatedAt: '',
            content: 'v1',
          },
          conversations: [],
        },
      },
    } as unknown as ServerFrame;
  }

  function eventFrame(sequence: number): ServerFrame {
    return {
      kind: 'event',
      frame: {
        type: 'revision_created',
        sequence,
        documentId: 'doc-1',
        conversationId: null,
        at: new Date().toISOString(),
        data: { revision: sequence },
      },
    } as unknown as ServerFrame;
  }

  it('a duplicate/backward sequence number triggers a resync rather than being applied', async () => {
    const store = useDocumentStore();
    await store.handleServerFrame(subscribedFrame(5));
    store.loaded = true; // established baseline, per handleServerFrame's own gap-check guard
    expect(store.eventSequence).toBe(5);

    vi.mocked(httpClient.getDocument).mockResolvedValue({
      document: {
        id: 'doc-1',
        title: 'Doc',
        currentRevision: 9,
        createdAt: '',
        updatedAt: '',
        updatedAtServer: '',
      } as never,
      content: 'resynced content',
      eventSequence: 9,
    });

    // A backward/duplicate sequence (4, when we've already seen 5) is a gap just as much as one
    // that jumps forward — never applied as the new baseline.
    await store.handleServerFrame(eventFrame(4));

    expect(httpClient.getDocument).toHaveBeenCalledTimes(1);
    expect(store.content).toBe('resynced content');
    expect(store.eventSequence).toBe(9);
  });

  it('a forward gap (skipping sequence numbers) also triggers a resync', async () => {
    const store = useDocumentStore();
    await store.handleServerFrame(subscribedFrame(5));
    store.loaded = true;

    vi.mocked(httpClient.getDocument).mockResolvedValue({
      document: { id: 'doc-1', title: 'Doc', currentRevision: 9, createdAt: '', updatedAt: '' },
      content: 'resynced content',
      eventSequence: 9,
    });

    await store.handleServerFrame(eventFrame(8)); // expected 6, got 8

    expect(httpClient.getDocument).toHaveBeenCalledTimes(1);
    expect(store.eventSequence).toBe(9);
  });

  it('the very next sequence number in order is applied directly, with no resync', async () => {
    const store = useDocumentStore();
    await store.handleServerFrame(subscribedFrame(5));
    store.loaded = true;

    await store.handleServerFrame(eventFrame(6));

    expect(httpClient.getDocument).not.toHaveBeenCalled();
    expect(store.eventSequence).toBe(6);
    expect(store.document?.currentRevision).toBe(6);
  });
});
