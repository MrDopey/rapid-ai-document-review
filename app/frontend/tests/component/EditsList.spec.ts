import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { StagedEditDto } from '@rapid-ai-document-review/shared/contracts/http';
import EditsList from '../../src/components/edits/EditsList.vue';
import { useEditsStore } from '../../src/stores/edits.js';
import { httpClient } from '../../src/transport/http-client.js';

// This list is fed straight from `useEditsStore().editsFor`, which mirrors the backend's
// `GET /conversations/:id/edits` — itself `ORDER BY created_at DESC` (see
// app/backend/src/storage/sqlite/index.ts's `listStagedEditsByConversation`, whose newest-first
// order several other backend call sites explicitly re-sort out of, e.g. edit-service.ts's
// `acceptRemaining`). The component must not just render that array as-is: it should display
// proposals oldest-first (top) to newest-last (bottom), by actual `createdAt` time — not by
// arrival order, tool-call id, or document position.
vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listEdits: vi.fn(),
    previewEdit: vi.fn(),
    applyEdit: vi.fn(),
    dropEdit: vi.fn(),
    acceptRemaining: vi.fn(),
    dropRemaining: vi.fn(),
  },
}));

function stagedEdit(
  overrides: Partial<StagedEditDto> & { id: string; createdAt: string },
): StagedEditDto {
  return {
    conversationId: 'conv-1',
    piToolCallId: `tool-${overrides.id}`,
    summary: overrides.id,
    sourceRevision: 1,
    status: 'pending',
    autoApplied: false,
    operationCount: 1,
    supersedesId: null,
    conflictDetail: null,
    appliedRevision: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe('EditsList — proposal ordering', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listEdits).mockReset();
  });

  it('renders proposals oldest-first (top) to newest-last (bottom), regardless of arrival order', async () => {
    // Deliberately out-of-order (and not matching id/lexical order either): the backend's
    // newest-first array, with a middling-timestamp edit arriving last of all.
    vi.mocked(httpClient.listEdits).mockResolvedValue({
      stagedEdits: [
        stagedEdit({ id: 'newest', createdAt: '2026-01-01T00:00:30.000Z' }),
        stagedEdit({ id: 'middle', createdAt: '2026-01-01T00:00:20.000Z' }),
        stagedEdit({ id: 'oldest', createdAt: '2026-01-01T00:00:10.000Z' }),
      ],
    });

    const wrapper = mount(EditsList, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();

    const summaries = wrapper.findAll('.summary-text').map((el) => el.text());
    expect(summaries).toEqual(['oldest', 'middle', 'newest']);
  });

  it('re-renders in oldest-to-newest order after a later proposal is appended', async () => {
    vi.mocked(httpClient.listEdits).mockResolvedValue({
      stagedEdits: [stagedEdit({ id: 'first', createdAt: '2026-01-01T00:00:10.000Z' })],
    });

    const wrapper = mount(EditsList, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.findAll('.summary-text').map((el) => el.text())).toEqual(['first']);

    // A new proposal is created with a later timestamp but happens to sort first in the
    // (unsorted, newest-first) backend response — the component must still place it last.
    vi.mocked(httpClient.listEdits).mockResolvedValue({
      stagedEdits: [
        stagedEdit({ id: 'second', createdAt: '2026-01-01T00:00:20.000Z' }),
        stagedEdit({ id: 'first', createdAt: '2026-01-01T00:00:10.000Z' }),
      ],
    });
    // Mirrors what `useEditsStore().handleServerFrame` does on a real `staged_edit_created` event.
    await useEditsStore().load('conv-1');
    await flushPromises();

    expect(wrapper.findAll('.summary-text').map((el) => el.text())).toEqual(['first', 'second']);
  });
});

describe('EditsList — edit-preview overlay dismissal', () => {
  let pinia: Pinia;
  let wrapper: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.previewEdit).mockReset();
  });

  afterEach(() => {
    // `DiffViewer`'s `useFocusTrap` registers a document-level keydown listener for as long as
    // the component is mounted — unmounting here (rather than relying on each `it` to remember)
    // keeps that listener, and its entry in `focus-manager.ts`'s shared `activeTraps` stack, from
    // leaking into later tests in this file.
    wrapper?.unmount();
    wrapper = null;
  });

  async function openPreview() {
    vi.mocked(httpClient.listEdits).mockResolvedValue({
      stagedEdits: [stagedEdit({ id: 'edit-1', createdAt: '2026-01-01T00:00:10.000Z' })],
    });
    vi.mocked(httpClient.previewEdit).mockResolvedValue({
      stagedEditId: 'edit-1',
      reconcilable: true,
      fullPreview: 'full document text',
      hunks: [
        {
          operationIndex: 0,
          contextBefore: 'before',
          removed: 'old text',
          added: 'new text',
          contextAfter: 'after',
        },
      ],
      conflictDetail: null,
    });

    wrapper = mount(EditsList, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await flushPromises();

    await wrapper.get('[aria-label="Preview: edit-1"]').trigger('click');
    await flushPromises();

    return wrapper;
  }

  it('closes the preview when the overlay backdrop is clicked', async () => {
    const w = await openPreview();
    expect(w.find('.diff-viewer').exists()).toBe(true);

    // Simulate a real click landing on the backdrop itself (not bubbled up from the DiffViewer
    // dialog nested inside it) — this is the click-outside-to-dismiss gesture.
    await w.get('.preview-overlay').trigger('click');
    await flushPromises();

    expect(w.find('.diff-viewer').exists()).toBe(false);
  });

  it('does not close the preview when a click originates inside the diff content', async () => {
    const w = await openPreview();
    expect(w.find('.diff-viewer').exists()).toBe(true);

    // `@click.self` only fires for a click that originates on the backdrop element itself, so a
    // click dispatched on a descendant (never bubbling through the backdrop's own handler in the
    // way `.self` cares about) must leave the preview open.
    await w.get('.diff-viewer').trigger('click');
    await flushPromises();

    expect(w.find('.diff-viewer').exists()).toBe(true);
  });

  it('still closes the preview via the explicit Close button', async () => {
    const w = await openPreview();
    expect(w.find('.diff-viewer').exists()).toBe(true);

    await w.get('.close-button').trigger('click');
    await flushPromises();

    expect(w.find('.diff-viewer').exists()).toBe(false);
  });

  it('still closes the preview on Escape', async () => {
    const w = await openPreview();
    expect(w.find('.diff-viewer').exists()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    expect(w.find('.diff-viewer').exists()).toBe(false);
  });
});

// Bug fix (79c2d07): dropping a single proposed edit is destructive with no undo, so it's gated
// behind a window.confirm before it fires — same gate DropAllButton.vue has for "Drop remaining".
describe('EditsList — per-row Drop confirmation gate', () => {
  let pinia: Pinia;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listEdits).mockReset();
    vi.mocked(httpClient.dropEdit).mockReset();
    confirmSpy = vi.spyOn(window, 'confirm');
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  async function mountWithOnePending() {
    vi.mocked(httpClient.listEdits).mockResolvedValue({
      stagedEdits: [stagedEdit({ id: 'edit-1', createdAt: '2026-01-01T00:00:10.000Z' })],
    });
    const wrapper = mount(EditsList, {
      props: { conversationId: 'conv-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    return wrapper;
  }

  it('confirming the dialog proceeds with the drop', async () => {
    confirmSpy.mockReturnValue(true);
    vi.mocked(httpClient.dropEdit).mockResolvedValue({
      outcome: 'dropped',
      stagedEditId: 'edit-1',
    });

    const wrapper = await mountWithOnePending();
    await wrapper.get('[aria-label="Drop: edit-1"]').trigger('click');
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalledWith('Drop this proposed edit? This cannot be undone.');
    expect(httpClient.dropEdit).toHaveBeenCalledWith('edit-1');
  });

  it('cancelling the dialog is a no-op — the edit is neither dropped nor left busy', async () => {
    confirmSpy.mockReturnValue(false);

    const wrapper = await mountWithOnePending();
    await wrapper.get('[aria-label="Drop: edit-1"]').trigger('click');
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalled();
    expect(httpClient.dropEdit).not.toHaveBeenCalled();
    expect(wrapper.get('.status-badge').text()).toBe('pending');
  });
});
