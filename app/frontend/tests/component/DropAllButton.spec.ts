import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import DropAllButton from '../../src/components/edits/DropAllButton.vue';
import { httpClient } from '../../src/transport/http-client.js';
import { useDocumentStore } from '../../src/stores/document.js';

// Bug fix (61d7e3d): dropping every remaining proposed edit in one click is destructive with no
// undo, so it's gated behind a window.confirm before it fires.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listEdits: vi.fn(),
    dropRemaining: vi.fn(),
  },
}));

describe('DropAllButton — confirmation gate', () => {
  let pinia: Pinia;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    useDocumentStore().activeDocumentId = 'doc-1';
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.dropRemaining).mockReset();
    vi.mocked(httpClient.listEdits).mockResolvedValue({ stagedEdits: [] });
    confirmSpy = vi.spyOn(window, 'confirm');
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('confirming the dialog proceeds with "Drop remaining"', async () => {
    confirmSpy.mockReturnValue(true);
    vi.mocked(httpClient.dropRemaining).mockResolvedValue({ results: [] });

    const wrapper = mount(DropAllButton, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalledWith(
      'Drop all remaining proposed edits in this conversation? This cannot be undone.',
    );
    expect(httpClient.dropRemaining).toHaveBeenCalledWith('doc-1', 'conv-1');
  });

  it('cancelling the dialog is a no-op', async () => {
    confirmSpy.mockReturnValue(false);

    const wrapper = mount(DropAllButton, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalled();
    expect(httpClient.dropRemaining).not.toHaveBeenCalled();
    expect(wrapper.get('button').text()).toBe('Drop remaining');
  });
});
