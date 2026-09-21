import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { RevisionDto } from '@rapid-ai-document-review/shared/contracts/http';
import HistoryPanel from '../../src/components/history/HistoryPanel.vue';
import RevisionDiffViewer from '../../src/components/diff/RevisionDiffViewer.vue';
import { useDocumentStore } from '../../src/stores/document.js';
import { httpClient } from '../../src/transport/http-client.js';

// Only touched by the Restore-confirmation-dialog describe block below — the pre-existing Diff
// tests above pre-seed `store.revisions` so `HistoryPanel`'s `onMounted` guard never calls
// `listRevisions` in the first place.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listRevisions: vi.fn(),
    restoreRevision: vi.fn(),
  },
}));

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
      makeRevision({
        revision: 2,
        origin: 'manual_debounce',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
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
    return row
      .find('.actions')
      .findAll('button')
      .find((btn) => btn.text() === 'Diff');
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

// Bug fix (c92bf3f): Restore instantly overwrites the live document with no undo, so it's now
// gated behind a role="alertdialog" confirmation (focus-trapped, per a11y/focus-manager.ts) —
// mirroring ConversationView.vue's own close-confirmation dialog pattern.
describe('HistoryPanel — Restore confirmation dialog', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listRevisions).mockReset();
    vi.mocked(httpClient.restoreRevision).mockReset();
  });

  function mountPanel() {
    const store = useDocumentStore();
    store.activeDocumentId = 'doc-1';
    store.revisions = [
      makeRevision({
        revision: 2,
        origin: 'manual_debounce',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      makeRevision({ revision: 1, origin: 'creation', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    return mount(HistoryPanel, {
      global: { plugins: [pinia], stubs: { RevisionDiffViewer: true } },
    });
  }

  function restoreButtonForV1(wrapper: ReturnType<typeof mountPanel>) {
    const rows = wrapper.findAll('.history-entry');
    const row = rows.find((r) => r.find('strong').text() === 'v1');
    if (!row) throw new Error('no history-entry row found for revision 1');
    return row.get('.restore-button');
  }

  it('clicking Restore opens the confirmation dialog without restoring yet', async () => {
    const wrapper = mountPanel();
    await restoreButtonForV1(wrapper).trigger('click');

    const dialog = wrapper.find('[role="alertdialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain('Restore to revision 1?');
    expect(httpClient.restoreRevision).not.toHaveBeenCalled();
  });

  it('confirming the dialog actually restores', async () => {
    vi.mocked(httpClient.restoreRevision).mockResolvedValue({
      currentRevision: 3,
      restoredFrom: 1,
      content: 'restored content',
    });
    vi.mocked(httpClient.listRevisions).mockResolvedValue({ revisions: [], nextCursor: null });

    const wrapper = mountPanel();
    await restoreButtonForV1(wrapper).trigger('click');
    await wrapper.get('.restore-dialog').get('.restore-button').trigger('click');
    await flushPromises();

    expect(httpClient.restoreRevision).toHaveBeenCalledWith('doc-1', 1);
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('Cancel closes the dialog without restoring', async () => {
    const wrapper = mountPanel();
    await restoreButtonForV1(wrapper).trigger('click');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);

    await wrapper.get('.restore-dialog').get('button:not(.restore-button)').trigger('click');
    await flushPromises();

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(httpClient.restoreRevision).not.toHaveBeenCalled();
  });

  it('Escape cancels the dialog without restoring (focus-trap onEscape)', async () => {
    const wrapper = mountPanel();
    await restoreButtonForV1(wrapper).trigger('click');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(httpClient.restoreRevision).not.toHaveBeenCalled();
  });
});

// Multi-document support (010-multi-document-support, US2/T031): the drawer is a reserved grid
// column, not remounted on every document switch (App.vue keeps it mounted via `v-if="historyOpen"`,
// toggled only by open/close) — so HistoryPanel must react to `activeDocumentId` changing while it
// stays mounted, rather than relying solely on its one-time `onMounted` guard.
describe('HistoryPanel — reloads on document switch (US2/T031)', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listRevisions).mockReset();
  });

  it('re-fetches revisions when activeDocumentId changes, discarding the previous document’s list', async () => {
    vi.mocked(httpClient.listRevisions).mockResolvedValue({
      revisions: [makeRevision({ revision: 1, origin: 'creation' })],
      nextCursor: null,
    });

    const store = useDocumentStore();
    store.activeDocumentId = 'doc-a';
    store.revisions = [makeRevision({ revision: 7, origin: 'creation' })];

    mount(HistoryPanel, {
      global: { plugins: [pinia], stubs: { RevisionDiffViewer: true } },
    });
    await flushPromises();
    expect(httpClient.listRevisions).not.toHaveBeenCalled();

    // switchTo() (stores/document.ts) resets revisions/cursor to empty as part of switching —
    // simulated directly here since this test targets HistoryPanel's reaction, not switchTo itself.
    store.revisions = [];
    store.revisionsNextCursor = null;
    store.activeDocumentId = 'doc-b';
    await flushPromises();

    expect(httpClient.listRevisions).toHaveBeenCalledWith('doc-b', { cursor: undefined });
    expect(store.revisions.map((r) => r.revision)).toEqual([1]);
  });

  it('dismisses any open diff/reconciliation view left over from the previous document', async () => {
    vi.mocked(httpClient.listRevisions).mockResolvedValue({ revisions: [], nextCursor: null });

    const store = useDocumentStore();
    store.activeDocumentId = 'doc-a';
    store.revisions = [
      makeRevision({ revision: 2, origin: 'manual_debounce' }),
      makeRevision({ revision: 1, origin: 'creation' }),
    ];

    const wrapper = mount(HistoryPanel, {
      global: { plugins: [pinia], stubs: { RevisionDiffViewer: true } },
    });
    const row = wrapper.findAll('.history-entry').find((r) => r.find('strong').text() === 'v2')!;
    await row
      .find('.actions')
      .findAll('button')
      .find((b) => b.text() === 'Diff')!
      .trigger('click');
    expect(wrapper.find('.modal-overlay').exists()).toBe(true);

    store.activeDocumentId = 'doc-b';
    await flushPromises();

    expect(wrapper.find('.modal-overlay').exists()).toBe(false);
  });
});
