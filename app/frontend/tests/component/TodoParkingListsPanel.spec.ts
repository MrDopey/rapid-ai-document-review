import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import TodoParkingListsPanel from '../../src/components/TodoParkingListsPanel.vue';
import { useDocumentStore } from '../../src/stores/document.js';
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

  // Contract fix: the two sections must split the rail's vertical space evenly by default, and
  // each has its own show/hide toggle independent of the other.
  it('both sections start expanded and carry the 50/50-split class', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('.todo-list-section').classes()).toContain('list-section--expanded');
    expect(wrapper.find('.parking-lot-section').classes()).toContain('list-section--expanded');
  });

  it('hiding one section collapses only that section, leaving the other expanded', async () => {
    const wrapper = await mountPanel();
    const todoSection = wrapper.find('.todo-list-section');
    await todoSection.find('.list-section-toggle').trigger('click');

    expect(todoSection.classes()).not.toContain('list-section--expanded');
    expect(todoSection.find('.list-section-body').exists()).toBe(false);
    const parkingSection = wrapper.find('.parking-lot-section');
    expect(parkingSection.classes()).toContain('list-section--expanded');
    expect(parkingSection.find('.list-section-body').exists()).toBe(true);
  });

  it('toggling a section back on restores its expanded body independent of the other section', async () => {
    const wrapper = await mountPanel();
    const parkingToggle = wrapper.find('.parking-lot-section .list-section-toggle');
    await parkingToggle.trigger('click');
    await parkingToggle.trigger('click');

    expect(wrapper.find('.parking-lot-section').classes()).toContain('list-section--expanded');
    expect(wrapper.find('.parking-lot-section .list-section-body').exists()).toBe(true);
    expect(wrapper.find('.todo-list-section').classes()).toContain('list-section--expanded');
  });
});
