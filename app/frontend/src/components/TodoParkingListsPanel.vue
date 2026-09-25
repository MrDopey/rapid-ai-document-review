<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue';
import type { ListItemDto } from '@rapid-ai-document-review/shared/contracts/http';
import { useDocumentStore } from '../stores/document.js';
import { useListItemsStore } from '../stores/listItems.js';
import { httpClient } from '../transport/http-client.js';

type ListName = 'todo' | 'parking_lot';

const documentStore = useDocumentStore();
const listItemsStore = useListItemsStore();

const sections: { list: ListName; title: string; sectionClass: string }[] = [
  { list: 'todo', title: 'Todo', sectionClass: 'todo-list-section' },
  { list: 'parking_lot', title: 'Parking Lot', sectionClass: 'parking-lot-section' },
];

function itemsFor(list: ListName): ListItemDto[] {
  return list === 'todo' ? listItemsStore.todo : listItemsStore.parkingLot;
}

const newItemText = reactive<Record<ListName, string>>({ todo: '', parking_lot: '' });
const editingId = reactive<Record<ListName, string | null>>({ todo: null, parking_lot: null });
const editingText = reactive<Record<ListName, string>>({ todo: '', parking_lot: '' });

function activeDocumentId(): string {
  return documentStore.activeDocumentId!;
}

async function load(): Promise<void> {
  if (!documentStore.activeDocumentId) return;
  await listItemsStore.fetchListItems(activeDocumentId());
}

onMounted(load);

// Not remounted on document switch in either mount point (App.vue's `.conversation-detail-overlay`
// closes on switch, but Thread mode's rail toggle state can outlive it) — mirrors
// history/HistoryPanel.vue's identical `watch`, so a document switch while the rail stays open
// always shows the newly-active document's own lists, not the previous document's.
watch(() => documentStore.activeDocumentId, load);

async function addItem(list: ListName): Promise<void> {
  const text = newItemText[list].trim();
  if (!text) return;
  await httpClient.createListItem(activeDocumentId(), { list, text });
  newItemText[list] = '';
}

function startEdit(list: ListName, item: ListItemDto): void {
  editingId[list] = item.id;
  editingText[list] = item.text;
}

function cancelEdit(list: ListName): void {
  editingId[list] = null;
  editingText[list] = '';
}

async function commitEdit(list: ListName, itemId: string): Promise<void> {
  const text = editingText[list].trim();
  if (!text) return;
  await httpClient.updateListItem(activeDocumentId(), itemId, text);
  cancelEdit(list);
}

async function removeItem(itemId: string): Promise<void> {
  await httpClient.deleteListItem(activeDocumentId(), itemId);
}
</script>

<template>
  <aside class="todo-parking-lists-panel" aria-label="Todo and Parking Lot lists">
    <section
      v-for="section in sections"
      :key="section.list"
      class="list-section"
      :class="section.sectionClass"
    >
      <h3 class="list-section-title">{{ section.title }}</h3>
      <ul class="list-items">
        <li v-for="item in itemsFor(section.list)" :key="item.id" class="list-item-row">
          <template v-if="editingId[section.list] === item.id">
            <input
              v-model="editingText[section.list]"
              class="list-item-edit-input"
              type="text"
              :aria-label="`Edit ${section.title} item`"
              @keydown.enter="commitEdit(section.list, item.id)"
              @keydown.esc="cancelEdit(section.list)"
            />
            <button type="button" @click="commitEdit(section.list, item.id)">Save</button>
            <button type="button" @click="cancelEdit(section.list)">Cancel</button>
          </template>
          <template v-else>
            <span class="list-item-text">{{ item.text }}</span>
            <button type="button" @click="startEdit(section.list, item)">Edit</button>
            <button type="button" @click="removeItem(item.id)">Delete</button>
          </template>
        </li>
        <li v-if="itemsFor(section.list).length === 0" class="list-item-empty">No items.</li>
      </ul>
      <form class="add-item-form" @submit.prevent="addItem(section.list)">
        <input
          v-model="newItemText[section.list]"
          type="text"
          :placeholder="`Add to ${section.title}`"
          :aria-label="`Add a ${section.title} item`"
        />
        <button type="submit" :disabled="!newItemText[section.list].trim()">Add</button>
      </form>
    </section>
  </aside>
</template>

<style scoped>
.todo-parking-lists-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  height: 100%;
  padding: 0.75rem;
  box-sizing: border-box;
}

.list-section-title {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  opacity: 0.75;
}

.list-items {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.list-item-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.list-item-text {
  flex: 1 1 auto;
  word-break: break-word;
}

.list-item-edit-input {
  flex: 1 1 auto;
}

.list-item-empty {
  opacity: 0.6;
  font-style: italic;
}

.add-item-form {
  display: flex;
  gap: 0.375rem;
}

.add-item-form input {
  flex: 1 1 auto;
}
</style>
