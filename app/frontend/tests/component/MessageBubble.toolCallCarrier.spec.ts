import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import MessageBubble from '../../src/components/conversation/MessageBubble.vue';
import { useSettingsStore } from '../../src/stores/settings.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';

/**
 * Coverage for the "blank Assistant bubble" fix's frontend half: a real-SDK tool-call-carrier
 * assistant segment (`message.isToolCallCarrier` — set by `EventBridge.handle()`'s `message_end`
 * case, event-bridge.ts) still exists as a real, persisted `message_completed` event/message — it
 * is never dropped from the data model (see the backend's own `event-bridge.test.ts`) — but
 * `MessageBubble.vue` gates its visibility on the same "Show reasoning" toggle
 * (`settings.thinkingVisible`) reasoning content already uses, instead of always rendering it as an
 * empty "Assistant" bubble. Kept in its own file (rather than added to the actively-changing
 * `MessageBubble.spec.ts`, which a concurrent effort on expand/collapse-by-default and
 * scroll-to-top was mid-editing) purely to avoid an editing collision — no behavior tested here
 * overlaps that file's own coverage.
 */
function makeMessage(overrides: Partial<ConversationMessageState> & { id: string }): ConversationMessageState {
  return {
    role: 'assistant',
    text: '',
    reasoning: null,
    isToolCallCarrier: false,
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
  });

  it('renders the bubble (with a note, not the real text bodies) for a tool-call-carrier message once "Show reasoning" is on', async () => {
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

    expect(wrapper.find('.message-bubble').exists()).toBe(true);
    expect(wrapper.find('.tool-call-carrier-note').exists()).toBe(true);
    expect(wrapper.find('.message-text').text()).toBe('');
  });

  it('a normal assistant message (isToolCallCarrier: false) always renders, regardless of the toggle', () => {
    const wrapper = mountBubble(makeMessage({ id: 'm1', text: 'A real reply.', isToolCallCarrier: false }));
    expect(wrapper.find('.message-bubble').exists()).toBe(true);
    expect(wrapper.find('.tool-call-carrier-note').exists()).toBe(false);
    expect(wrapper.text()).toContain('A real reply.');
  });

  it('a reasoning-only message (no tool call, empty text) is not a carrier and always renders', () => {
    const wrapper = mountBubble(
      makeMessage({ id: 'm2', text: '', reasoning: 'Thinking it through.', isToolCallCarrier: false }),
    );
    expect(wrapper.find('.message-bubble').exists()).toBe(true);
    expect(wrapper.find('.reasoning').exists()).toBe(true);
  });
});
