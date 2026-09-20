import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import HighlightBranchMenu from '../../src/components/thread/HighlightBranchMenu.vue';

// 011-linear-thread-mode's highlight-to-branch popover, plus the newer "Quote from here" action
// added alongside it. `ThreadCard.vue` owns deciding which of `canBranch`/`canQuote` apply to a
// given selection (mutually exclusive today: an earlier message vs. the thread's own tip message)
// — this component only needs to render whichever button(s) it's told to and report the click.
function mountMenu(
  overrides: Partial<{ canBranch: boolean; canQuote: boolean; pending: boolean }> = {},
) {
  return mount(HighlightBranchMenu, {
    props: {
      x: 10,
      y: 20,
      highlightedText: 'Some highlighted text.',
      canBranch: overrides.canBranch ?? true,
      canQuote: overrides.canQuote ?? false,
      pending: overrides.pending,
    },
  });
}

describe('HighlightBranchMenu', () => {
  it('renders only "Branch from here" when canBranch is true and canQuote is false', () => {
    const wrapper = mountMenu({ canBranch: true, canQuote: false });
    expect(wrapper.text()).toContain('Branch from here');
    expect(wrapper.text()).not.toContain('Quote from here');
  });

  it('renders only "Quote from here" when canQuote is true and canBranch is false', () => {
    const wrapper = mountMenu({ canBranch: false, canQuote: true });
    expect(wrapper.text()).not.toContain('Branch from here');
    expect(wrapper.text()).toContain('Quote from here');
  });

  it('emits "branch" when "Branch from here" is clicked', async () => {
    const wrapper = mountMenu({ canBranch: true, canQuote: false });
    await wrapper.find('.highlight-branch-button').trigger('click');
    expect(wrapper.emitted('branch')).toHaveLength(1);
  });

  it('emits "quote" when "Quote from here" is clicked', async () => {
    const wrapper = mountMenu({ canBranch: false, canQuote: true });
    await wrapper.find('.highlight-branch-button').trigger('click');
    expect(wrapper.emitted('quote')).toHaveLength(1);
  });

  it('emits "dismiss" from the close button regardless of which action(s) are shown', async () => {
    const wrapper = mountMenu({ canBranch: false, canQuote: true });
    await wrapper.find('.highlight-branch-dismiss').trigger('click');
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('disables (but still shows) "Branch from here" while pending, and relabels it', () => {
    const wrapper = mountMenu({ canBranch: true, canQuote: false, pending: true });
    const branchButton = wrapper.find('.highlight-branch-button');
    expect(branchButton.text()).toBe('Branching…');
    expect(branchButton.attributes('disabled')).toBeDefined();
  });
});
