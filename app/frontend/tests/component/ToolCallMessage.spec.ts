import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import ToolCallMessage from '../../src/components/conversation/ToolCallMessage.vue';
import { useSettingsStore } from '../../src/stores/settings.js';
import type { ConversationMessageState } from '../../src/stores/conversations.js';

/**
 * Coverage for `ToolCallMessage.vue` — the distinct card a tool-call-carrier assistant message
 * (`message.isToolCallCarrier`) now renders as, promoted out of `MessageBubble.vue`'s generic
 * "Assistant" bubble chrome (see that file's own doc comment for the visibility-gate it still owns
 * and delegates from). These cases were originally asserted against `MessageBubble.vue` itself
 * (`MessageBubble.toolCallCarrier.spec.ts`) before the split; moved here to mount `ToolCallMessage`
 * directly. `MessageBubble.toolCallCarrier.spec.ts`/`MessageBubble.spec.ts` now only assert that a
 * carrier message renders via this component, not the tool-call markup's own details.
 */
function makeMessage(
  overrides: Partial<ConversationMessageState> & { id: string },
): ConversationMessageState {
  return {
    role: 'assistant',
    text: '',
    reasoning: null,
    isToolCallCarrier: true,
    toolCalls: [],
    streaming: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setThinkingVisible(value: boolean): void {
  useSettingsStore().settings = {
    thinkingVisible: value,
    revisionDebounceMs: 300_000,
    maxConcurrentAgents: 3,
    maxEditingDepth: 2,
    maxConversationDepth: 3,
    maxReplacementAttempts: 2,
    softWordCountThreshold: 20_000,
  };
}

describe('ToolCallMessage — empty-carrier note gating', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(message: ConversationMessageState) {
    return mount(ToolCallMessage, { props: { message }, global: { plugins: [pinia] } });
  }

  it('renders the card with a note (not tool-call markup) when there are no tool calls and "Show reasoning" is on', async () => {
    setThinkingVisible(true);
    const wrapper = mountCard(makeMessage({ id: 'tc-2' }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-message-kind="tool-call"]').exists()).toBe(true);
    expect(wrapper.find('.tool-call-carrier-note').exists()).toBe(true);
    expect(wrapper.find('.tool-call').exists()).toBe(false);
  });

  it('renders no note when there are no tool calls and "Show reasoning" is off', () => {
    const wrapper = mountCard(makeMessage({ id: 'tc-1' }));
    expect(wrapper.find('.tool-call-carrier-note').exists()).toBe(false);
  });

  it('carries the required data attributes for the focus-jump scroll target', () => {
    const wrapper = mountCard(makeMessage({ id: 'tc-attrs' }));
    const root = wrapper.get('[data-message-kind="tool-call"]');
    expect(root.attributes('data-message-id')).toBe('tc-attrs');
    expect(root.attributes('data-role')).toBe('assistant');
  });
});

describe('ToolCallMessage — tool-call detail is not gated by "Show reasoning" (009-agent-activity-logging)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(message: ConversationMessageState) {
    return mount(ToolCallMessage, { props: { message }, global: { plugins: [pinia] } });
  }

  const carrierWithToolCall = (id: string) =>
    makeMessage({
      id,
      toolCalls: [
        {
          toolCallId: 'tc_1',
          name: 'web_search',
          args: { query: 'rapid ai document review' },
          resultText: 'Web search: 1 result',
          failureReason: null,
          stagedEditId: null,
        },
      ],
    });

  it('renders the tool-call block (name, args, result) when "Show reasoning" is off', () => {
    const wrapper = mountCard(carrierWithToolCall('tc-off'));

    expect(wrapper.find('.tool-call').exists()).toBe(true);
    expect(wrapper.find('.tool-call-name').text()).toBe('web_search');
    expect(wrapper.find('.tool-call-args').text()).toContain('rapid ai document review');
    expect(wrapper.find('.tool-call-result').text()).toBe('Web search: 1 result');
  });

  it('renders the same tool-call block when "Show reasoning" is on', () => {
    setThinkingVisible(true);
    const wrapper = mountCard(carrierWithToolCall('tc-on'));

    expect(wrapper.find('.tool-call').exists()).toBe(true);
    expect(wrapper.find('.tool-call-name').text()).toBe('web_search');
    expect(wrapper.find('.tool-call-args').text()).toContain('rapid ai document review');
    expect(wrapper.find('.tool-call-result').text()).toBe('Web search: 1 result');
  });

  it('shows failureReason (not resultText) and an error style for a failed call', () => {
    const wrapper = mountCard(
      makeMessage({
        id: 'tc-err',
        toolCalls: [
          {
            toolCallId: 'tc_2',
            name: 'web_fetch',
            args: { url: 'https://example.invalid' },
            resultText: null,
            failureReason: 'Could not fetch: timed out',
            stagedEditId: null,
          },
        ],
      }),
    );

    expect(wrapper.find('.tool-call').classes()).toContain('tool-call-error');
    expect(wrapper.find('.tool-call-result').text()).toBe('Could not fetch: timed out');
  });
});

// jsdom never computes real layout, so `scrollHeight` is always 0 there — see
// MessageBubble.spec.ts's own `mockTallScrollHeight` for the same pattern applied to the message
// text's clamp check.
function mockTallScrollHeight(el: Element, px = 400): void {
  Object.defineProperty(el, 'scrollHeight', { value: px, configurable: true });
}

describe("ToolCallMessage — tool calls clamp/expand like MessageBubble.vue's message text does", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountCard(message: ConversationMessageState) {
    return mount(ToolCallMessage, { props: { message }, global: { plugins: [pinia] } });
  }

  const carrierWithLongToolCall = (id: string) =>
    makeMessage({
      id,
      toolCalls: [
        {
          toolCallId: 'tc_1',
          name: 'web_fetch',
          args: { url: 'https://example.com' },
          resultText: 'x'.repeat(2000),
          failureReason: null,
          stagedEditId: null,
        },
      ],
    });

  it('a long tool call defaults to collapsed (clamped) with a "Show more" toggle', async () => {
    const wrapper = mountCard(carrierWithLongToolCall('tc-long'));
    mockTallScrollHeight(wrapper.get('.tool-call-body').element);
    await wrapper.vm.$nextTick();

    const toggle = wrapper.get('.tool-call .expand-toggle-button');
    expect(toggle.text()).toBe('Show more');
    expect((wrapper.get('.tool-call-body').element as HTMLElement).style.maxHeight).toBe('160px');
  });

  it("clicking the tool call's own toggle expands only that call, independent of the message-level expanded prop", async () => {
    const wrapper = mountCard(carrierWithLongToolCall('tc-toggle'));
    mockTallScrollHeight(wrapper.get('.tool-call-body').element);
    await wrapper.vm.$nextTick();

    await wrapper.get('.tool-call .expand-toggle-button').trigger('click');

    expect(wrapper.get('.tool-call .expand-toggle-button').text()).toBe('Show less');
    expect((wrapper.get('.tool-call-body').element as HTMLElement).style.maxHeight).toBe('400px');
    // Toggling a tool call is purely local UI state, not the message-level expand/collapse
    // (data-model.md's MessageDisplayState) — no update:expanded should be emitted for it.
    expect(wrapper.emitted('update:expanded')).toBeUndefined();
  });

  it('a bulk "Collapse all" (the parent flipping `expanded` to false) also re-collapses an individually-expanded tool call', async () => {
    const wrapper = mount(ToolCallMessage, {
      props: { message: carrierWithLongToolCall('tc-bulk'), expanded: true },
      global: { plugins: [pinia] },
    });
    mockTallScrollHeight(wrapper.get('.tool-call-body').element);
    await wrapper.vm.$nextTick();

    await wrapper.get('.tool-call .expand-toggle-button').trigger('click');
    expect(wrapper.get('.tool-call .expand-toggle-button').text()).toBe('Show less');

    // FR-009's bulk toggle drives this exact prop change on every message in the conversation.
    await wrapper.setProps({ expanded: false });

    expect(wrapper.get('.tool-call .expand-toggle-button').text()).toBe('Show more');
    expect((wrapper.get('.tool-call-body').element as HTMLElement).style.maxHeight).toBe('160px');
  });

  it('a bulk "Expand all" (the parent flipping `expanded` to true) also expands a collapsed tool call', async () => {
    const wrapper = mount(ToolCallMessage, {
      props: { message: carrierWithLongToolCall('tc-bulk-expand'), expanded: false },
      global: { plugins: [pinia] },
    });
    mockTallScrollHeight(wrapper.get('.tool-call-body').element);
    await wrapper.vm.$nextTick();

    expect(wrapper.get('.tool-call .expand-toggle-button').text()).toBe('Show more');

    await wrapper.setProps({ expanded: true });

    expect(wrapper.get('.tool-call .expand-toggle-button').text()).toBe('Show less');
    expect((wrapper.get('.tool-call-body').element as HTMLElement).style.maxHeight).toBe('400px');
  });

  // Dynamic/generalized regression coverage for the cascade rule (bug: an individually-expanded
  // tool call survived a bulk "Collapse all" because the cascade lived outside `useClampToggle`,
  // wired only for one call). Parameterized over several tool-call counts, with only every other
  // call individually expanded beforehand, so this can't pass by accident for exactly one call or
  // exactly one "shape" of mixed expand state — the cascade must reset *every* registered secondary
  // id, however many there are and whatever their prior individual state.
  it.each([1, 2, 3, 5])(
    'a bulk "Collapse all" re-collapses every one of %i individually-expanded tool calls',
    async (count) => {
      const toolCalls = Array.from({ length: count }, (_, i) => ({
        toolCallId: `tc_${i}`,
        name: 'web_fetch',
        args: { url: `https://example.com/${i}` },
        resultText: 'x'.repeat(2000),
        failureReason: null,
        stagedEditId: null,
      }));
      const wrapper = mount(ToolCallMessage, {
        props: {
          message: makeMessage({ id: `tc-dyn-${count}`, toolCalls }),
          expanded: true,
        },
        global: { plugins: [pinia] },
      });
      for (const body of wrapper.findAll('.tool-call-body')) {
        mockTallScrollHeight(body.element);
      }
      await wrapper.vm.$nextTick();

      // Individually expand every other tool call (a genuinely mixed starting state, not
      // uniformly collapsed or uniformly expanded).
      const toggles = wrapper.findAll('.tool-call .expand-toggle-button');
      expect(toggles).toHaveLength(count);
      for (let i = 0; i < count; i += 2) {
        await toggles[i]!.trigger('click');
      }

      await wrapper.setProps({ expanded: false });

      const bodiesAfter = wrapper.findAll('.tool-call-body');
      for (const body of bodiesAfter) {
        expect((body.element as HTMLElement).style.maxHeight).toBe('160px');
      }
      for (const toggle of wrapper.findAll('.tool-call .expand-toggle-button')) {
        expect(toggle.text()).toBe('Show more');
      }
    },
  );

  it('a short tool call renders no toggle button', async () => {
    const wrapper = mountCard(
      makeMessage({
        id: 'tc-short',
        toolCalls: [
          {
            toolCallId: 'tc_2',
            name: 'web_search',
            args: { query: 'short' },
            resultText: 'short result',
            failureReason: null,
            stagedEditId: null,
          },
        ],
      }),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.tool-call .expand-toggle-button').exists()).toBe(false);
  });
});
