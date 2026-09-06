import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import RevisionDiffViewer from '../../src/components/diff/RevisionDiffViewer.vue';
import { useDocumentStore } from '../../src/stores/document.js';

// Spec: specs/004-history-diff-view (FR-003/004/005/006/007/008).
//
// RevisionDiffViewer compares `previousRevision` (N-1) against `revision` (N) by fetching each
// revision's exported text via useDocumentStore().exportRevision(revisionNumber) and rendering a
// line-level diff, mirroring DiffViewer.vue's `.added`/`.removed` (ins/del) convention. These
// tests describe the desired end state only — the component's fetch/diff logic is not yet wired
// up, so every test here is expected to fail (red phase) until a later pass implements it.

function mountViewer(pinia: Pinia, revision = 2, previousRevision = 1): VueWrapper {
  return mount(RevisionDiffViewer, {
    props: { revision, previousRevision },
    global: { plugins: [pinia] },
  });
}

describe('RevisionDiffViewer', () => {
  let pinia: Pinia;
  let store: ReturnType<typeof useDocumentStore>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    store = useDocumentStore();
  });

  it('renders added and removed lines visually distinct from unchanged text (FR-003, FR-004)', async () => {
    const previousText = 'Line one\nLine two\nLine three\n';
    const currentText = 'Line one\nLine two updated\nLine three\nLine four\n';

    const exportSpy = vi
      .spyOn(store, 'exportRevision')
      .mockImplementation(async (revision?: number) => {
        if (revision === 1) return previousText;
        if (revision === 2) return currentText;
        throw new Error(`unexpected revision requested: ${revision}`);
      });

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    const addedEls = wrapper.findAll('.added, ins');
    const removedEls = wrapper.findAll('.removed, del');

    expect(addedEls.length).toBeGreaterThan(0);
    expect(removedEls.length).toBeGreaterThan(0);

    const addedText = addedEls.map((el) => el.text()).join(' ');
    const removedText = removedEls.map((el) => el.text()).join(' ');

    expect(addedText).toContain('Line two updated');
    expect(addedText).toContain('Line four');
    expect(removedText).toContain('Line two');
    // The removed marker must not also claim the *updated* line — only the old line was removed.
    expect(removedText).not.toContain('Line two updated');

    // Unchanged lines render as plain text, not wrapped in an added/removed marker.
    expect(wrapper.text()).toContain('Line one');
    expect(wrapper.text()).toContain('Line three');

    // FR-003: compares revision N-1 (previous) against revision N (current).
    expect(exportSpy).toHaveBeenCalledWith(1);
    expect(exportSpy).toHaveBeenCalledWith(2);
  });

  it('emits close and performs only the two read-only content fetches — no other store mutation (FR-005, FR-008)', async () => {
    const exportSpy = vi
      .spyOn(store, 'exportRevision')
      .mockImplementation(async (revision?: number) => (revision === 1 ? 'A\n' : 'B\n'));

    // Every other document-store action must remain untouched for the whole lifecycle of this
    // component: opening, viewing the diff, and closing it again.
    const loadSpy = vi.spyOn(store, 'load');
    const createSpy = vi.spyOn(store, 'create');
    const patchContentSpy = vi.spyOn(store, 'patchContent');
    const loadRevisionsSpy = vi.spyOn(store, 'loadRevisions');
    const restoreSpy = vi.spyOn(store, 'restore');
    const handleServerFrameSpy = vi.spyOn(store, 'handleServerFrame');

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    const closeButton = wrapper.findAll('button').find((btn) => btn.text() === 'Close');
    expect(closeButton).toBeTruthy();
    await closeButton!.trigger('click');

    expect(wrapper.emitted('close')).toBeTruthy();
    expect(wrapper.emitted('close')).toHaveLength(1);

    expect(exportSpy).toHaveBeenCalledTimes(2);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(patchContentSpy).not.toHaveBeenCalled();
    expect(loadRevisionsSpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(handleServerFrameSpy).not.toHaveBeenCalled();
  });

  it('shows a clear, user-visible error when a revision fails to load (FR-006)', async () => {
    vi.spyOn(store, 'exportRevision').mockRejectedValue(new Error('failed to export revision'));

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text().trim().length).toBeGreaterThan(0);

    // Must not render a blank/partial diff alongside (or instead of) the error.
    expect(wrapper.find('.added').exists()).toBe(false);
    expect(wrapper.find('.removed').exists()).toBe(false);
  });

  it('shows "No differences found" when both revisions have identical content (FR-007)', async () => {
    const identicalText = 'Nothing changed here.\nSecond unchanged line.\n';
    vi.spyOn(store, 'exportRevision').mockResolvedValue(identicalText);

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toMatch(/no differences found/i);
    expect(wrapper.find('.added').exists()).toBe(false);
    expect(wrapper.find('.removed').exists()).toBe(false);
  });

  // Spec: specs/007-diff-viewer-modes (FR-011..FR-014) — DiffText.vue migration + side-by-side parity.

  it('renders the marker glyph and visually-hidden label via DiffText.vue (FR-011)', async () => {
    const previousText = 'Line one\nLine two\nLine three\n';
    const currentText = 'Line one\nLine two updated\nLine three\nLine four\n';
    vi.spyOn(store, 'exportRevision').mockImplementation(async (revision?: number) =>
      revision === 1 ? previousText : currentText,
    );

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    const del = wrapper.find('del.removed');
    const ins = wrapper.find('ins.added');
    expect(del.find('.marker').text()).toBe('−');
    expect(del.find('.visually-hidden').text()).toBe('removed:');
    expect(ins.find('.marker').text()).toBe('+');
    expect(ins.find('.visually-hidden').text()).toBe('added:');
  });

  it('defaults to "unified" and offers a "Side by side" view rendering the same filtered columns as DiffViewer.vue (FR-012, FR-013)', async () => {
    const previousText = 'Line one\nLine two\nLine three\n';
    const currentText = 'Line one\nLine two updated\nLine three\nLine four\n';
    vi.spyOn(store, 'exportRevision').mockImplementation(async (revision?: number) =>
      revision === 1 ? previousText : currentText,
    );

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    const unifiedTab = wrapper.find('#revision-diff-tab-unified');
    const sideBySideTab = wrapper.find('#revision-diff-tab-side-by-side');
    expect(unifiedTab.attributes('aria-selected')).toBe('true');
    expect(sideBySideTab.attributes('aria-selected')).toBe('false');
    expect(wrapper.find('#revision-diff-panel-unified').attributes('hidden')).toBeUndefined();
    expect(wrapper.find('#revision-diff-panel-side-by-side').attributes('hidden')).toBeDefined();

    await sideBySideTab.trigger('click');

    expect(wrapper.find('#revision-diff-panel-side-by-side').attributes('hidden')).toBeUndefined();
    const left = wrapper.find('.diff-column-left');
    const right = wrapper.find('.diff-column-right');
    expect(left.find('.removed').exists()).toBe(true);
    expect(left.find('.added').exists()).toBe(false);
    expect(right.find('.added').exists()).toBe(true);
    expect(right.find('.removed').exists()).toBe(false);
  });

  it('resets the view to "unified" on a new revision comparison', async () => {
    vi.spyOn(store, 'exportRevision').mockImplementation(async (revision?: number) =>
      revision === 1 ? 'A\n' : 'B\n',
    );

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    await wrapper.find('#revision-diff-tab-side-by-side').trigger('click');
    expect(wrapper.find('#revision-diff-panel-side-by-side').attributes('hidden')).toBeUndefined();

    wrapper.unmount();
    const freshWrapper = mountViewer(pinia, 4, 3);
    await flushPromises();
    await flushPromises();

    expect(freshWrapper.find('#revision-diff-panel-unified').attributes('hidden')).toBeUndefined();
    expect(
      freshWrapper.find('#revision-diff-panel-side-by-side').attributes('hidden'),
    ).toBeDefined();
  });

  it('Unified view collapses a long unchanged run by default, expands it on click, and "Focus on changes" toggles it off', async () => {
    const filler = (label: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${label} line ${i + 1}.`).join('\n');
    const before = filler('Before', 10);
    const after = filler('After', 10);
    vi.spyOn(store, 'exportRevision').mockImplementation(async (revision?: number) =>
      revision === 1
        ? `${before}\nOriginal change line.\n${after}\n`
        : `${before}\nChanged change line.\n${after}\n`,
    );

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    const unifiedPanel = wrapper.find('#revision-diff-panel-unified');
    const markers = unifiedPanel.findAll('.collapsed-marker');
    expect(markers).toHaveLength(2);
    expect(unifiedPanel.text()).toContain('Changed change line.');
    expect(unifiedPanel.text()).not.toContain('Before line 1.');
    expect(unifiedPanel.text()).not.toContain('After line 10.');

    await markers[0].trigger('click');
    expect(unifiedPanel.findAll('.collapsed-marker')).toHaveLength(1);
    expect(unifiedPanel.text()).toContain('Before line 1.');

    const focusToggle = wrapper.find('.focus-toggle input[type="checkbox"]');
    await focusToggle.setValue(false);
    expect(unifiedPanel.find('.collapsed-marker').exists()).toBe(false);
    expect(unifiedPanel.text()).toContain('Before line 1.');
    expect(unifiedPanel.text()).toContain('After line 10.');

    // Toggling focus back on returns to the default collapsed state — it must not remember the
    // group we manually expanded earlier.
    await focusToggle.setValue(true);
    expect(unifiedPanel.findAll('.collapsed-marker')).toHaveLength(2);
    expect(unifiedPanel.text()).not.toContain('Before line 1.');
  });

  it('performs no additional store.exportRevision call when switching view modes (FR-014)', async () => {
    const exportSpy = vi
      .spyOn(store, 'exportRevision')
      .mockImplementation(async (revision?: number) => (revision === 1 ? 'A\n' : 'B\n'));

    const wrapper = mountViewer(pinia, 2, 1);
    await flushPromises();
    await flushPromises();

    exportSpy.mockClear();

    await wrapper.find('#revision-diff-tab-side-by-side').trigger('click');
    await wrapper.find('#revision-diff-tab-unified').trigger('click');

    expect(exportSpy).not.toHaveBeenCalled();
  });
});
