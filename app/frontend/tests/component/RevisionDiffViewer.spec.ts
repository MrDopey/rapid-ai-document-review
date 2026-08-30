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

    const exportSpy = vi.spyOn(store, 'exportRevision').mockImplementation(async (revision?: number) => {
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
});
