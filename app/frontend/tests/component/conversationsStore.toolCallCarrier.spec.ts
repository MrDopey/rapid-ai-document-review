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
    store.messagesByConversation['conv_1'] = [
      {
        id: 'msg_carrier2',
        role: 'assistant',
        text: '',
        reasoning: null,
        isToolCallCarrier: false,
        streaming: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

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
