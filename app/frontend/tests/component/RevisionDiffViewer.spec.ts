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
  //
  // The marker-glyph/visually-hidden-label rendering itself (DiffText.vue's own contract) is
  // covered directly by DiffText.spec.ts, and its side="left"/"right" column filtering by both
  // DiffText.spec.ts and DiffViewer.spec.ts's own "selecting Side by side" test — re-testing either
  // through this second host component would just duplicate that coverage verbatim, so the tests
  // below stick to what's actually specific to RevisionDiffViewer: its own revision-selection/
  // view-mode tab UI (defaulting to "unified", switching, and resetting per revision pair).

  it('defaults to "unified" and offers a "Side by side" view, switching the visible panel (FR-012, FR-013)', async () => {
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

    // Which side filters out which change type is DiffText.vue's own contract (DiffText.spec.ts)
    // and already exercised end-to-end via DiffViewer.vue (DiffViewer.spec.ts's "selecting Side by
    // side" test) — this only needs to prove RevisionDiffViewer's own tab wiring actually flips the
    // visible panel.
    expect(wrapper.find('#revision-diff-panel-side-by-side').attributes('hidden')).toBeUndefined();
    expect(wrapper.find('.diff-column-left').exists()).toBe(true);
    expect(wrapper.find('.diff-column-right').exists()).toBe(true);
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

  // The unchanged-run collapse/expand/"Focus on changes" mechanism itself is
  // collapseUnchanged.ts's own logic (tests/unit/collapseUnchanged.spec.ts) and is already
  // exercised end-to-end via DiffViewer.vue by DiffViewer.spec.ts's "Full-document collapses a
  // long unchanged run..." test — re-running the identical scenario through this second host
  // component would only duplicate that coverage, so it's intentionally not repeated here.

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
