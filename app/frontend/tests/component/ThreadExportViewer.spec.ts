import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ThreadExportViewer from '../../src/components/thread/ThreadExportViewer.vue';
import { useDocumentStore } from '../../src/stores/document.js';

/**
 * 011-linear-thread-mode, User Story 4/FR-013: `ThreadExportViewer.vue` renders a fresh, on-demand
 * genuine Pi-native session export (`GET .../threads/:id/export`) — a parsed transcript through
 * `MessageBubble.vue` plus the literal raw exported bytes. Only `exportThread` is mocked here (same
 * convention as `ThreadCard.spec.ts`'s `httpClient` mock) — everything else renders through the
 * real store/component code.
 */
const exportThreadMock = vi.fn();

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    exportThread: (...args: unknown[]) => exportThreadMock(...args),
  },
  ApiError: class ApiError extends Error {
    status = 0;
    code = 'UNKNOWN';
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

describe('ThreadExportViewer', () => {
  it('renders the parsed transcript through MessageBubble and the raw export verbatim', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useDocumentStore().activeDocumentId = 'doc-1';

    exportThreadMock.mockResolvedValue({
      threadId: 'thread-1',
      exportedAt: '2026-09-20T00:00:00.000Z',
      jsonl: '{"type":"session","id":"s1"}\n{"type":"message","id":"e1"}',
      messages: [
        {
          id: 'm0',
          role: 'user',
          text: 'Hello from the export',
          createdAt: '2026-09-20T00:00:00.000Z',
        },
        {
          id: 'm1',
          role: 'assistant',
          text: 'Reply from the export',
          createdAt: '2026-09-20T00:00:01.000Z',
        },
      ],
    });

    const wrapper = mount(ThreadExportViewer, {
      props: { threadId: 'thread-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();

    expect(exportThreadMock).toHaveBeenCalledWith('doc-1', 'thread-1');

    const bubbles = wrapper.findAll('.message-bubble');
    expect(bubbles).toHaveLength(2);
    expect(wrapper.text()).toContain('Hello from the export');
    expect(wrapper.text()).toContain('Reply from the export');

    const raw = wrapper.find('.thread-export-raw-content');
    expect(raw.exists()).toBe(true);
    expect(raw.text()).toBe('{"type":"session","id":"s1"}\n{"type":"message","id":"e1"}');
  });

  it('shows an inline error when the export is refused as empty', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useDocumentStore().activeDocumentId = 'doc-1';

    const { ApiError } = await import('../../src/transport/http-client.js');
    exportThreadMock.mockRejectedValue(new ApiError(409, 'EMPTY_THREAD_EXPORT', 'empty'));

    const wrapper = mount(ThreadExportViewer, {
      props: { threadId: 'thread-2' },
      global: { plugins: [pinia] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('nothing to export');
    expect(wrapper.findAll('.message-bubble')).toHaveLength(0);
  });
});
