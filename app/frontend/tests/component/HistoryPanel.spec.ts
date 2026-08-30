import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { RevisionDto } from '@rapid-ai-document-review/shared/contracts/http';
import HistoryPanel from '../../src/components/history/HistoryPanel.vue';
import RevisionDiffViewer from '../../src/components/diff/RevisionDiffViewer.vue';
import { useDocumentStore } from '../../src/stores/document.js';

// Spec: specs/004-history-diff-view (FR-001/002/003), User Story 2.
//
// Every revision row except the very first (revision 1) must offer a working "Diff" action that,
// when clicked, mounts RevisionDiffViewer comparing the row's revision against the one directly
// before it. This describes the desired end state only — HistoryPanel.vue does not yet render any
// Diff control, so every test here is expected to fail (red phase) until a later pass implements
// it.

function makeRevision(overrides: Partial<RevisionDto> & { revision: number }): RevisionDto {
  return {
    source: 'user',
    origin: 'manual_debounce',
    conversationId: null,
    conversationName: null,
    stagedEditId: null,
    restoredFrom: null,
    note: null,
    autoApplied: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('HistoryPanel — Diff action', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function mountPanel() {
    const store = useDocumentStore();
    // Pre-seed revisions so HistoryPanel's onMounted guard (`revisions.length === 0`) skips the
    // real loadRevisions() HTTP call entirely.
    store.revisions = [
      makeRevision({ revision: 2, origin: 'manual_debounce', createdAt: '2026-01-02T00:00:00.000Z' }),
      makeRevision({ revision: 1, origin: 'creation', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];

    const wrapper = mount(HistoryPanel, {
      global: {
        plugins: [pinia],
        stubs: { RevisionDiffViewer: true },
      },
    });
    return { wrapper, store };
  }

  function rowFor(wrapper: ReturnType<typeof mountPanel>['wrapper'], revision: number) {
    const rows = wrapper.findAll('.history-entry');
    const row = rows.find((r) => r.find('strong').text() === `v${revision}`);
    if (!row) throw new Error(`no history-entry row found for revision ${revision}`);
    return row;
  }

  function diffButtonIn(row: ReturnType<typeof rowFor>) {
    return row.find('.actions').findAll('button').find((btn) => btn.text() === 'Diff');
  }

  it('revision 1 renders NO Diff button (FR-001/002)', () => {
    const { wrapper } = mountPanel();
    const row = rowFor(wrapper, 1);
    expect(diffButtonIn(row)).toBeUndefined();
  });

  it('revision 2 renders a working Diff button (FR-001/002)', () => {
    const { wrapper } = mountPanel();
    const row = rowFor(wrapper, 2);
    expect(diffButtonIn(row)).toBeTruthy();
  });

  it('clicking Diff on revision 2 mounts RevisionDiffViewer comparing v1 -> v2 (FR-003)', async () => {
    const { wrapper } = mountPanel();
    const row = rowFor(wrapper, 2);
    const diffButton = diffButtonIn(row);
    expect(diffButton).toBeTruthy();

    await diffButton!.trigger('click');

    const overlay = wrapper.find('.modal-overlay');
    expect(overlay.exists()).toBe(true);

    const diffViewer = wrapper.findComponent(RevisionDiffViewer);
    expect(diffViewer.exists()).toBe(true);
    expect(diffViewer.props('revision')).toBe(2);
    expect(diffViewer.props('previousRevision')).toBe(1);
  });
});
