import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import TodoParkingListsPanel from '../../src/components/TodoParkingListsPanel.vue';
import { useDocumentStore } from '../../src/stores/document.js';
import { useListItemsStore } from '../../src/stores/listItems.js';
import { httpClient } from '../../src/transport/http-client.js';

vi.mock('../../src/transport/http-client.js', () => ({
  httpClient: {
    listListItems: vi.fn(),
    createListItem: vi.fn(),
    updateListItem: vi.fn(),
    deleteListItem: vi.fn(),
  },
}));

describe('TodoParkingListsPanel', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(httpClient.listListItems)
      .mockReset()
      .mockResolvedValue({
        todo: [{ id: 'li_1', text: 'fix the intro paragraph', contentHash: 'h1' }],
        parkingLot: [{ id: 'li_2', text: 'parked idea', contentHash: 'h2' }],
      });
    vi.mocked(httpClient.createListItem).mockReset();
    vi.mocked(httpClient.updateListItem).mockReset();
    vi.mocked(httpClient.deleteListItem).mockReset();
  });

  async function mountPanel() {
    useDocumentStore().activeDocumentId = 'doc_1';
    const wrapper = mount(TodoParkingListsPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    return wrapper;
  }

  it('renders the Todo and Parking Lot sections as two always-visible sibling blocks', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('.todo-list-section').exists()).toBe(true);
    expect(wrapper.find('.parking-lot-section').exists()).toBe(true);
  });

  it('renders item text via plain interpolation, never as HTML', async () => {
    const wrapper = await mountPanel();
    const todoText = wrapper.find('.todo-list-section .list-item-text');
    expect(todoText.text()).toBe('fix the intro paragraph');
    // Confirms no v-html/innerHTML path: markup-looking text stays literal, not parsed as tags.
    expect(wrapper.find('.todo-list-section').html()).not.toContain('<script>');
  });

  it('adding an item calls httpClient.createListItem with the section list and trimmed text', async () => {
    const wrapper = await mountPanel();
    const parkingSection = wrapper.find('.parking-lot-section');
    await parkingSection.find('input').setValue('a new parked idea');
    await parkingSection.find('form').trigger('submit.prevent');

    expect(httpClient.createListItem).toHaveBeenCalledWith('doc_1', {
      list: 'parking_lot',
      text: 'a new parked idea',
    });
  });

  it('the Add button is disabled for empty/whitespace-only input', async () => {
    const wrapper = await mountPanel();
    const todoSection = wrapper.find('.todo-list-section');
    await todoSection.find('input').setValue('   ');
    const addButton = todoSection.findAll('button').find((b) => b.text() === 'Add');
    expect(addButton?.attributes('disabled')).toBeDefined();
  });

  it('editing an item calls httpClient.updateListItem with the new text', async () => {
    const wrapper = await mountPanel();
    const todoSection = wrapper.find('.todo-list-section');
    const editButton = todoSection.findAll('button').find((b) => b.text() === 'Edit');
    await editButton!.trigger('click');

    const editInput = todoSection.find('.list-item-edit-input');
    await editInput.setValue('fix the intro');
    await editInput.trigger('keydown.enter');

    expect(httpClient.updateListItem).toHaveBeenCalledWith('doc_1', 'li_1', 'fix the intro');
  });

  it('deleting an item calls httpClient.deleteListItem', async () => {
    const wrapper = await mountPanel();
    const parkingSection = wrapper.find('.parking-lot-section');
    const deleteButton = parkingSection.findAll('button').find((b) => b.text() === 'Delete');
    await deleteButton!.trigger('click');

    expect(httpClient.deleteListItem).toHaveBeenCalledWith('doc_1', 'li_2');
  });

  // Contract fix: the two sections must split the rail's vertical space evenly by default. The
  // show/hide toggle CONTROL itself lives in the HUD (App.vue/ThreadModeView.vue), not on the
  // rail — this panel only reflects `listItemsStore.todoVisible`/`parkingLotVisible`.
  it('both sections start expanded and carry the 50/50-split class', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('.todo-list-section').classes()).toContain('list-section--expanded');
    expect(wrapper.find('.parking-lot-section').classes()).toContain('list-section--expanded');
  });

  it('hiding one section via the store removes it (including its heading) entirely, leaving the other expanded', async () => {
    const wrapper = await mountPanel();
    useListItemsStore().toggleVisibility('todo');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.todo-list-section').exists()).toBe(false);
    const parkingSection = wrapper.find('.parking-lot-section');
    expect(parkingSection.classes()).toContain('list-section--expanded');
    expect(parkingSection.find('.list-section-body').exists()).toBe(true);
  });

  it('toggling a section back on via the store restores its expanded body independent of the other section', async () => {
    const wrapper = await mountPanel();
    useListItemsStore().toggleVisibility('parking_lot');
    useListItemsStore().toggleVisibility('parking_lot');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.parking-lot-section').classes()).toContain('list-section--expanded');
    expect(wrapper.find('.parking-lot-section .list-section-body').exists()).toBe(true);
    expect(wrapper.find('.todo-list-section').classes()).toContain('list-section--expanded');
  });

  // 012-todo-parking-lists follow-up: provenance-link visual indicator + click-to-focus emit.
  describe('provenance link (messageId)', () => {
    async function mountWithLinks() {
      vi.mocked(httpClient.listListItems).mockResolvedValue({
        todo: [
          {
            id: 'li_1',
            text: 'fix the intro paragraph',
            contentHash: 'h1',
            conversationId: 'conv_1',
            messageId: 'msg_1',
          },
        ],
        parkingLot: [
          {
            id: 'li_2',
            text: 'parked idea',
            contentHash: 'h2',
            conversationId: null,
            messageId: null,
          },
        ],
      });
      return mountPanel();
    }

    it('renders a linked item with the linked class and emits focus-link on click', async () => {
      const wrapper = await mountWithLinks();
      const linkedText = wrapper.find('.todo-list-section .list-item-text');
      expect(linkedText.classes()).toContain('list-item-text--linked');

      await linkedText.trigger('click');
      expect(wrapper.emitted('focus-link')).toEqual([['conv_1', 'msg_1']]);
    });

    it('emits focus-link on Enter for a linked item', async () => {
      const wrapper = await mountWithLinks();
      const linkedText = wrapper.find('.todo-list-section .list-item-text');
      await linkedText.trigger('keydown.enter');
      expect(wrapper.emitted('focus-link')).toEqual([['conv_1', 'msg_1']]);
    });

    it('renders an unlinked item with neither the linked class nor a click effect', async () => {
      const wrapper = await mountWithLinks();
      const unlinkedText = wrapper.find('.parking-lot-section .list-item-text');
      expect(unlinkedText.classes()).not.toContain('list-item-text--linked');

      await unlinkedText.trigger('click');
      expect(wrapper.emitted('focus-link')).toBeUndefined();
    });
  });
});
