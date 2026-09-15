import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useConversationsStore } from '../../src/stores/conversations.js';
import { httpClient } from '../../src/transport/http-client.js';
import type { ServerFrame } from '../../src/transport/ws-client.js';

// Covers stores/conversations.ts's WS event-sequence gap detection (01fe287/0470e9f) — mirrors
// document.ts's own `!== lastEventSequence + 1` check on the same shared per-document sequence
// counter.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listConversations: vi.fn(),
    getConversation: vi.fn(),
  },
}));

function subscribedFrame(sequence: number): ServerFrame {
  return {
    kind: 'subscribed',
    frame: {
      currentSequence: sequence,
      replayCount: 0,
      snapshot: {
        document: {
          id: 'doc-1',
          title: '',
          currentRevision: 1,
          createdAt: '',
          updatedAt: '',
          content: '',
        },
        conversations: [],
      },
    },
  } as unknown as ServerFrame;
}

function statusChangedFrame(sequence: number, conversationId = 'conv-1'): ServerFrame {
  return {
    kind: 'event',
    frame: {
      type: 'conversation_status_changed',
      sequence,
      documentId: 'doc-1',
      conversationId,
      at: new Date().toISOString(),
      data: { status: 'working' },
    },
  } as unknown as ServerFrame;
}

describe('conversations store — WS event-sequence gap resync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.listConversations).mockReset();
    vi.mocked(httpClient.getConversation).mockReset();
  });

  it('a duplicate/backward sequence number triggers resyncAfterGap (a fresh listConversations) rather than being applied', async () => {
    const store = useConversationsStore();
    store.handleServerFrame(subscribedFrame(5));
    expect(store.lastEventSequence).toBe(5);

    vi.mocked(httpClient.listConversations).mockResolvedValue({
      currentRevision: 1,
      conversations: [],
      nextCursor: null,
    });

    // Sequence 4 arrives after we've already seen 5 — a duplicate/backward frame, not the next one.
    store.handleServerFrame(statusChangedFrame(4));
    // resyncAfterGap is fired-and-forgotten (not awaited by handleServerFrame itself); let its
    // microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(httpClient.listConversations).toHaveBeenCalledTimes(1);
    // The out-of-order frame's own status update was discarded, not applied — this store's context
    // could be inconsistent, so a targeted resync is safer than trusting partial state.
    expect(store.findConversation('conv-1')).toBeNull();
  });

  it('a forward gap (skipping sequence numbers) also triggers a resync', async () => {
    const store = useConversationsStore();
    store.handleServerFrame(subscribedFrame(5));

    vi.mocked(httpClient.listConversations).mockResolvedValue({
      currentRevision: 1,
      conversations: [],
      nextCursor: null,
    });

    store.handleServerFrame(statusChangedFrame(9)); // expected 6, got 9
    await Promise.resolve();
    await Promise.resolve();

    expect(httpClient.listConversations).toHaveBeenCalledTimes(1);
    expect(store.lastEventSequence).toBe(9);
  });

  it('the very next sequence number in order is applied directly, with no resync', async () => {
    const store = useConversationsStore();
    const initialFrame: ServerFrame = {
      kind: 'subscribed',
      frame: {
        currentSequence: 5,
        replayCount: 0,
        snapshot: {
          document: {
            id: 'doc-1',
            title: '',
            currentRevision: 1,
            createdAt: '',
            updatedAt: '',
            content: '',
          },
          conversations: [{ id: 'conv-1', name: 'Conv', kind: 'branch', status: 'idle' } as never],
        },
      },
    } as unknown as ServerFrame;
    store.handleServerFrame(initialFrame);

    store.handleServerFrame(statusChangedFrame(6));
    await Promise.resolve();

    expect(httpClient.listConversations).not.toHaveBeenCalled();
    expect(store.lastEventSequence).toBe(6);
    expect(store.findConversation('conv-1')?.status).toBe('working');
  });
});

describe('conversations store — stale per-conversation state does not survive a document switch', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(httpClient.listConversations).mockReset();
    vi.mocked(httpClient.getConversation).mockReset();
  });

  it("a conversation id only ever seen in the previous document is dropped from messagesByConversation once the new document's list loads", async () => {
    const store = useConversationsStore();

    vi.mocked(httpClient.listConversations).mockResolvedValueOnce({
      currentRevision: 1,
      conversations: [{ id: 'doc-a-main', name: 'Main', kind: 'main', status: 'idle' } as never],
      nextCursor: null,
    });
    await store.load();

    vi.mocked(httpClient.getConversation).mockResolvedValueOnce({
      conversation: { id: 'doc-a-main', name: 'Main', kind: 'main', status: 'idle' } as never,
      messages: [],
      stagedEdits: [],
    } as never);
    await store.loadDetail('doc-a-main');
    expect(store.messagesByConversation['doc-a-main']).toBeDefined();

    // Switch: a fresh document's own (unrelated) Main conversation loads.
    vi.mocked(httpClient.listConversations).mockResolvedValueOnce({
      currentRevision: 1,
      conversations: [{ id: 'doc-b-main', name: 'Main', kind: 'main', status: 'idle' } as never],
      nextCursor: null,
    });
    await store.load();

    expect(store.messagesByConversation['doc-a-main']).toBeUndefined();

    // A stale sequence-gap resync afterwards must not resurrect it.
    const staleIds = Object.keys(store.messagesByConversation);
    expect(staleIds).not.toContain('doc-a-main');
  });
});
