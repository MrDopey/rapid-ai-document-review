import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { useConversationsStore } from '../../src/stores/conversations.js';
import type { ServerFrame } from '../../src/transport/ws-client.js';

/**
 * Regression coverage for the "phantom empty bubble during a live turn" bug: the persisted/
 * broadcast `message_completed` event never carries `isToolCallCarrier` on the wire (event-
 * sourcing — see shared/src/domain/index.ts's `computeIsToolCallCarrier`), so
 * `useConversationsStore().handleServerFrame` must derive it itself for a message that arrives (or
 * completes) purely via a live WS frame, rather than reading a key that's never actually present
 * and silently falling back to `false` until the next `loadDetail()` REST refetch papers over it.
 */
function messageCompletedFrame(data: {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string | null;
}): ServerFrame {
  return {
    kind: 'event',
    frame: {
      type: 'message_completed',
      sequence: 1,
      documentId: 'doc_1',
      conversationId: 'conv_1',
      at: '2026-01-01T00:00:00.000Z',
      data: { reasoning: null, ...data },
    },
  } as ServerFrame;
}

/** The real frame that starts a streamed message in-flight (before any `text_delta`/
 *  `message_completed` arrives) — used below to put a message into the same "streaming, not
 *  yet tagged" state the "re-derives on completion" test needs, without reaching into the
 *  store's internal `messagesByConversation` map directly.
 *
 *  `sequence: null` (rather than reusing `1`, like `messageCompletedFrame`'s default) on purpose:
 *  `handleServerFrame`'s own gap-detection compares each numbered event's `sequence` against the
 *  last one seen, and this helper is always followed by a real `messageCompletedFrame` in the same
 *  test — two frames both claiming `sequence: 1` would look like a *repeated* sequence number
 *  (a gap), triggering an unrelated `resyncAfterGap()` and masking the actual assertion. */
function messageStartedFrame(data: { messageId: string; role: 'user' | 'assistant' }): ServerFrame {
  return {
    kind: 'event',
    frame: {
      type: 'message_started',
      sequence: null,
      documentId: 'doc_1',
      conversationId: 'conv_1',
      at: '2026-01-01T00:00:00.000Z',
      data,
    },
  } as ServerFrame;
}

describe('conversations store: isToolCallCarrier is derived live from a WS message_completed frame', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it('tags a live tool-call-carrier segment as isToolCallCarrier: true with no REST refetch', () => {
    const store = useConversationsStore();

    store.handleServerFrame(
      messageCompletedFrame({
        messageId: 'msg_carrier',
        role: 'assistant',
        text: '',
        reasoning: null,
      }),
    );

    const message = store.messagesFor('conv_1').find((m) => m.id === 'msg_carrier');
    expect(message?.isToolCallCarrier).toBe(true);
  });

  it('does not tag a live normal reply as isToolCallCarrier', () => {
    const store = useConversationsStore();

    store.handleServerFrame(
      messageCompletedFrame({
        messageId: 'msg_reply',
        role: 'assistant',
        text: 'Here is the answer.',
      }),
    );

    const message = store.messagesFor('conv_1').find((m) => m.id === 'msg_reply');
    expect(message?.isToolCallCarrier).toBe(false);
  });

  it('does not tag a live reasoning-only segment as isToolCallCarrier', () => {
    const store = useConversationsStore();

    store.handleServerFrame(
      messageCompletedFrame({
        messageId: 'msg_reasoning',
        role: 'assistant',
        text: '',
        reasoning: 'Thinking it through.',
      }),
    );

    const message = store.messagesFor('conv_1').find((m) => m.id === 'msg_reasoning');
    expect(message?.isToolCallCarrier).toBe(false);
  });

  it('re-derives isToolCallCarrier on an existing streamed message once it completes', () => {
    const store = useConversationsStore();
    store.handleServerFrame(messageStartedFrame({ messageId: 'msg_carrier2', role: 'assistant' }));

    // Sanity-check the seed went through the real ingestion path: streaming, untagged, exactly
    // as `message_started` produces it, before the completion below re-derives the tag.
    const seeded = store.messagesFor('conv_1').find((m) => m.id === 'msg_carrier2');
    expect(seeded?.streaming).toBe(true);
    expect(seeded?.isToolCallCarrier).toBe(false);

    store.handleServerFrame(
      messageCompletedFrame({
        messageId: 'msg_carrier2',
        role: 'assistant',
        text: '',
        reasoning: null,
      }),
    );

    const message = store.messagesFor('conv_1').find((m) => m.id === 'msg_carrier2');
    expect(message?.isToolCallCarrier).toBe(true);
    expect(message?.streaming).toBe(false);
  });
});
