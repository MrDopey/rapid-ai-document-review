import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { PreviewEditResponse } from '@rapid-ai-document-review/shared/contracts/http';
import DiffViewer from '../../src/components/diff/DiffViewer.vue';
import { useDocumentStore } from '../../src/stores/document.js';
import { httpClient } from '../../src/transport/http-client.js';

// Spec: specs/007-diff-viewer-modes (FR-001, FR-004, FR-005, FR-006, FR-007, FR-010).

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    previewEdit: vi.fn(),
  },
}));

function preview(overrides: Partial<PreviewEditResponse> = {}): PreviewEditResponse {
  return {
    stagedEditId: 'edit-1',
    reconcilable: true,
    fullPreview: 'Line one.\nLine nine.\nLine three.',
    hunks: [
      {
        operationIndex: 0,
        contextBefore: 'Line one.\n',
        removed: 'Line two.',
        added: 'Line nine.',
        contextAfter: '\nLine three.',
      },
    ],
    conflictDetail: null,
    ...overrides,
  };
}

function mountViewer(pinia: Pinia, editId = 'edit-1'): VueWrapper {
  return mount(DiffViewer, {
    props: { editId },
    global: { plugins: [pinia] },
  });
}

describe('DiffViewer', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.previewEdit).mockReset();
  });

  it('Full-document view renders .added/.removed nodes for a diffing original/proposed pair', async () => {
    const store = useDocumentStore();
    store.content = 'Line one.\nLine two.\nLine three.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(preview());

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#diff-tab-full').trigger('click');

    const fullPanel = wrapper.find('#diff-panel-full');
    expect(fullPanel.find('.added').exists()).toBe(true);
    expect(fullPanel.find('.removed').exists()).toBe(true);
    expect(fullPanel.text()).toContain('nine');
    expect(fullPanel.text()).toContain('two');
    expect(fullPanel.text()).toContain('Line one.');
  });

  it('renders HTML-significant characters literally in the Full-document view', async () => {
    const store = useDocumentStore();
    store.content = '<script>alert(1)</script> original';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(
      preview({ fullPreview: '<b>bold</b> proposed', hunks: [] }),
    );

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#diff-tab-full').trigger('click');

    const fullPanel = wrapper.find('#diff-panel-full');
    // Word-level diffing splits these into interleaved removed/added segments, so assert no
    // unescaped tag appears anywhere in the rendered markup (never as parsed markup) rather than
    // asserting the original strings survive contiguously.
    expect(fullPanel.html()).not.toMatch(/<script(?!\/>)[^>]*>alert/);
    expect(fullPanel.html()).not.toMatch(/<b>bold/);
    expect(fullPanel.html()).toContain('&lt;');
    expect(fullPanel.html()).toContain('&gt;');
    expect(fullPanel.text()).toContain('script');
    expect(fullPanel.text()).toContain('bold');
  });

  it('shows "No differences found" instead of plain text for a no-op edit in the Full-document view', async () => {
    const store = useDocumentStore();
    store.content = 'Unchanged content.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(
      preview({ fullPreview: 'Unchanged content.', hunks: [] }),
    );

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#diff-tab-full').trigger('click');

    const fullPanel = wrapper.find('#diff-panel-full');
    expect(fullPanel.text()).toMatch(/no differences found/i);
    expect(fullPanel.find('.added').exists()).toBe(false);
    expect(fullPanel.find('.removed').exists()).toBe(false);
  });

  it('leaves the hunk view output unchanged after the DiffText.vue migration (FR-010 regression guard)', async () => {
    const store = useDocumentStore();
    store.content = 'Line one.\nLine two.\nLine three.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(preview());

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    const hunksPanel = wrapper.find('#diff-panel-hunks');
    const del = hunksPanel.find('del.removed');
    const ins = hunksPanel.find('ins.added');
    expect(del.exists()).toBe(true);
    expect(ins.exists()).toBe(true);
    expect(del.find('.marker').text()).toBe('−');
    expect(del.find('.visually-hidden').text()).toBe('removed:');
    expect(del.text()).toContain('two');
    expect(ins.find('.marker').text()).toBe('+');
    expect(ins.find('.visually-hidden').text()).toBe('added:');
    expect(ins.text()).toContain('nine');
  });

  it('selecting "Side by side" renders two columns filtered to each side', async () => {
    const store = useDocumentStore();
    store.content = 'Line one.\nLine two.\nLine three.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(preview());

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#diff-tab-side-by-side').trigger('click');

    const panel = wrapper.find('#diff-panel-side-by-side');
    expect(panel.exists()).toBe(true);
    const left = panel.find('.diff-column-left');
    const right = panel.find('.diff-column-right');
    expect(left.exists()).toBe(true);
    expect(right.exists()).toBe(true);

    expect(left.find('.removed').exists()).toBe(true);
    expect(left.find('.added').exists()).toBe(false);
    expect(left.text()).toContain('two');
    expect(left.text()).not.toContain('nine');

    expect(right.find('.added').exists()).toBe(true);
    expect(right.find('.removed').exists()).toBe(false);
    expect(right.text()).toContain('nine');
    expect(right.text()).not.toContain('Line two.');
  });

  it('shows "No differences found" in the Side-by-side view for a no-op edit', async () => {
    const store = useDocumentStore();
    store.content = 'Unchanged content.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(
      preview({ fullPreview: 'Unchanged content.', hunks: [] }),
    );

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#diff-tab-side-by-side').trigger('click');

    const panel = wrapper.find('#diff-panel-side-by-side');
    expect(panel.text()).toMatch(/no differences found/i);
    expect(panel.find('.added').exists()).toBe(false);
    expect(panel.find('.removed').exists()).toBe(false);
  });

  it('switching hunks → side-by-side → full-document → hunks calls previewEdit exactly once (FR-006)', async () => {
    const store = useDocumentStore();
    store.content = 'Line one.\nLine two.\nLine three.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(preview());

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#diff-tab-side-by-side').trigger('click');
    await wrapper.find('#diff-tab-full').trigger('click');
    await wrapper.find('#diff-tab-hunks').trigger('click');

    expect(httpClient.previewEdit).toHaveBeenCalledTimes(1);
  });

  it('Full-document collapses a long unchanged run by default, expands it on click, and "Focus on changes" toggles it off', async () => {
    const filler = (label: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${label} line ${i + 1}.`).join('\n');
    const before = filler('Before', 10);
    const after = filler('After', 10);
    const original = `${before}\nOriginal change line.\n${after}`;
    const changed = `${before}\nChanged change line.\n${after}`;

    const store = useDocumentStore();
    store.content = original;
    vi.mocked(httpClient.previewEdit).mockResolvedValue(
      preview({ fullPreview: changed, hunks: [] }),
    );

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();
    await wrapper.find('#diff-tab-full').trigger('click');

    const fullPanel = wrapper.find('#diff-panel-full');
    // Focus toggle defaults on: a long unchanged run on each side of the one changed line
    // collapses into two markers, hiding the far-away filler lines.
    const markers = fullPanel.findAll('.collapsed-marker');
    expect(markers).toHaveLength(2);
    expect(fullPanel.text()).toContain('Changed change line.');
    expect(fullPanel.text()).not.toContain('Before line 1.');
    expect(fullPanel.text()).not.toContain('After line 10.');
    // Context lines immediately around the change stay visible.
    expect(fullPanel.text()).toContain('Before line 10.');
    expect(fullPanel.text()).toContain('After line 1.');

    await markers[0].trigger('click');
    expect(fullPanel.findAll('.collapsed-marker')).toHaveLength(1);
    expect(fullPanel.text()).toContain('Before line 1.');

    const focusToggle = wrapper.find('.focus-toggle input[type="checkbox"]');
    await focusToggle.setValue(false);
    expect(fullPanel.find('.collapsed-marker').exists()).toBe(false);
    expect(fullPanel.text()).toContain('Before line 1.');
    expect(fullPanel.text()).toContain('After line 10.');

    // Toggling focus back on returns to the default collapsed state — it must not remember the
    // group we manually expanded earlier.
    await focusToggle.setValue(true);
    expect(fullPanel.findAll('.collapsed-marker')).toHaveLength(2);
    expect(fullPanel.text()).not.toContain('Before line 1.');
  });

  it('Side-by-side collapses the same unchanged run, spanning both columns', async () => {
    const filler = (label: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${label} line ${i + 1}.`).join('\n');
    const before = filler('Before', 10);
    const after = filler('After', 10);
    const original = `${before}\nOriginal change line.\n${after}`;
    const changed = `${before}\nChanged change line.\n${after}`;

    const store = useDocumentStore();
    store.content = original;
    vi.mocked(httpClient.previewEdit).mockResolvedValue(
      preview({ fullPreview: changed, hunks: [] }),
    );

    const wrapper = mountViewer(pinia);
    await flushPromises();
    await flushPromises();
    await wrapper.find('#diff-tab-side-by-side').trigger('click');

    const panel = wrapper.find('#diff-panel-side-by-side');
    const markers = panel.findAll('.collapsed-marker--full-row');
    expect(markers).toHaveLength(2);
    expect(panel.find('.diff-column-left').text()).not.toContain('Before line 1.');
    expect(panel.find('.diff-column-right').text()).not.toContain('After line 10.');
  });

  it('always opens on "Added / removed" and resets after re-mounting for a different edit (FR-004, US3)', async () => {
    const store = useDocumentStore();
    store.content = 'Line one.\nLine two.\nLine three.';
    vi.mocked(httpClient.previewEdit).mockResolvedValue(preview());

    const wrapper = mountViewer(pinia, 'edit-1');
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('#diff-panel-hunks').attributes('hidden')).toBeUndefined();
    expect(wrapper.find('#diff-panel-side-by-side').attributes('hidden')).toBeDefined();

    await wrapper.find('#diff-tab-side-by-side').trigger('click');
    expect(wrapper.find('#diff-panel-side-by-side').attributes('hidden')).toBeUndefined();

    // Simulate EditsList.vue's mount-per-open pattern: unmount and mount fresh for a new editId.
    wrapper.unmount();
    vi.mocked(httpClient.previewEdit).mockResolvedValue(preview({ stagedEditId: 'edit-2' }));
    const freshWrapper = mountViewer(pinia, 'edit-2');
    await flushPromises();
    await flushPromises();

    expect(freshWrapper.find('#diff-panel-hunks').attributes('hidden')).toBeUndefined();
    expect(freshWrapper.find('#diff-panel-side-by-side').attributes('hidden')).toBeDefined();
  });
});
