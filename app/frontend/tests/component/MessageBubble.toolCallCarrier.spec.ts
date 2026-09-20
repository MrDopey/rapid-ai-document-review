import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import MessageBubble from '../../src/components/conversation/MessageBubble.vue';
import ToolCallMessage from '../../src/components/conversation/ToolCallMessage.vue';
import { useSettingsStore } from '../../src/stores/settings.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';

/**
 * Coverage for the "blank Assistant bubble" fix's frontend half: a real-SDK tool-call-carrier
 * assistant segment (`message.isToolCallCarrier` — set by `EventBridge.handle()`'s `message_end`
 * case, event-bridge.ts) still exists as a real, persisted `message_completed` event/message — it
 * is never dropped from the data model (see the backend's own `event-bridge.test.ts`) — but
 * `MessageBubble.vue` gates its visibility on the same "Show reasoning" toggle
 * (`settings.thinkingVisible`) reasoning content already uses, instead of always rendering it as an
 * empty "Assistant" bubble.
 *
 * Once the gate passes, a carrier message now renders via `ToolCallMessage.vue` (its own distinct
 * card, promoted out of the generic gray/blue "Assistant" bubble) rather than `MessageBubble.vue`'s
 * own `.message-bubble` DOM — see `ToolCallMessage.spec.ts` for that component's own markup/detail
 * coverage (name/args/result, failure styling, empty-carrier note, clamp/expand). This file only
 * covers the gating/delegation behavior that's genuinely `MessageBubble.vue`'s own responsibility.
 */
function makeMessage(
  overrides: Partial<ConversationMessageState> & { id: string },
): ConversationMessageState {
  return {
    role: 'assistant',
    text: '',
    reasoning: null,
    isToolCallCarrier: false,
    toolCalls: [],
    streaming: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MessageBubble — tool-call-carrier visibility gating', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountBubble(message: ConversationMessageState) {
    return mount(MessageBubble, { props: { message }, global: { plugins: [pinia] } });
  }

  it('renders nothing for a tool-call-carrier message when "Show reasoning" is off (default)', () => {
    const wrapper = mountBubble(makeMessage({ id: 'tc-1', isToolCallCarrier: true }));
    expect(wrapper.find('.message-bubble').exists()).toBe(false);
    expect(wrapper.findComponent(ToolCallMessage).exists()).toBe(false);
  });

  it('renders via ToolCallMessage (not the generic bubble) for a tool-call-carrier message once "Show reasoning" is on', async () => {
    useSettingsStore().settings = {
      thinkingVisible: true,
      revisionDebounceMs: 300_000,
      maxConcurrentAgents: 3,
      maxEditingDepth: 2,
      maxConversationDepth: 3,
      maxReplacementAttempts: 2,
      softWordCountThreshold: 20_000,
    };
    const wrapper = mountBubble(makeMessage({ id: 'tc-2', isToolCallCarrier: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.message-bubble').exists()).toBe(false);
    const toolCallMessage = wrapper.findComponent(ToolCallMessage);
    expect(toolCallMessage.exists()).toBe(true);
    expect(toolCallMessage.props('message').id).toBe('tc-2');
    expect(wrapper.find('[data-message-kind="tool-call"]').exists()).toBe(true);
  });

  it('a carrier message with tool-call detail renders via ToolCallMessage regardless of the toggle', () => {
    const wrapper = mountBubble(
      makeMessage({
        id: 'tc-3',
        isToolCallCarrier: true,
        toolCalls: [
          {
            toolCallId: 'tc_1',
            name: 'web_search',
            args: { query: 'x' },
            resultText: 'result',
            failureReason: null,
            stagedEditId: null,
          },
        ],
      }),
    );
    expect(wrapper.findComponent(ToolCallMessage).exists()).toBe(true);
  });

  it("a normal assistant message (isToolCallCarrier: false) always renders as MessageBubble's own bubble, regardless of the toggle", () => {
    const wrapper = mountBubble(
      makeMessage({ id: 'm1', text: 'A real reply.', isToolCallCarrier: false }),
    );
    expect(wrapper.find('.message-bubble').exists()).toBe(true);
    expect(wrapper.findComponent(ToolCallMessage).exists()).toBe(false);
    expect(wrapper.text()).toContain('A real reply.');
  });

  it('a reasoning-only message (no tool call, empty text) is not a carrier and always renders', () => {
    const wrapper = mountBubble(
      makeMessage({
        id: 'm2',
        text: '',
        reasoning: 'Thinking it through.',
        isToolCallCarrier: false,
      }),
    );
    expect(wrapper.find('.message-bubble').exists()).toBe(true);
    expect(wrapper.find('.reasoning').exists()).toBe(true);
  });

  it('reasoning visibility reacts live to the thinkingVisible toggle, with no remount/re-fetch (FR-006/SC-002)', async () => {
    const wrapper = mountBubble(
      makeMessage({ id: 'm3', text: 'Reply.', reasoning: 'Thinking it through.' }),
    );

    expect(wrapper.find('.reasoning').exists()).toBe(true);
    expect(wrapper.find('.reasoning').attributes('open')).toBeUndefined();

    useSettingsStore().settings = {
      thinkingVisible: true,
      revisionDebounceMs: 300_000,
      maxConcurrentAgents: 3,
      maxEditingDepth: 2,
      maxConversationDepth: 3,
      maxReplacementAttempts: 2,
      softWordCountThreshold: 20_000,
    };
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.reasoning').attributes('open')).toBeDefined();
  });
});
