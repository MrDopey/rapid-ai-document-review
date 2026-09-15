<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useDocumentStore } from '../../stores/document.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';

const emit = defineEmits<{
  (e: 'switch', documentId: string): void;
  (e: 'create'): void;
  (e: 'rename', documentId: string): void;
  (e: 'delete', documentId: string): void;
}>();

const store = useDocumentStore();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

function close(): void {
  open.value = false;
}

function toggle(): void {
  open.value = !open.value;
}

// Rename/delete are structural affordances only (US3 wires their handlers) — every other popup in
// this app is a full-screen `.modal-overlay` where an outside click has nowhere to land, but an
// anchored dropdown like this one needs its own outside-click-to-close.
function onDocumentMousedown(event: MouseEvent): void {
  if (!open.value) return;
  if (rootEl.value?.contains(event.target as Node)) return;
  close();
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocumentMousedown);
  } else {
    document.removeEventListener('mousedown', onDocumentMousedown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown);
});

useFocusTrap(rootEl, open, {
  onEscape: () => close(),
  getPreferredInitialFocus: () => rootEl.value?.querySelector('.document-switcher-select') ?? null,
});

function selectDocument(documentId: string): void {
  close();
  if (documentId === store.activeDocumentId) return;
  emit('switch', documentId);
}

function onCreate(): void {
  close();
  emit('create');
}

function onRename(documentId: string, event: Event): void {
  event.stopPropagation();
  emit('rename', documentId);
}

function onDelete(documentId: string, event: Event): void {
  event.stopPropagation();
  emit('delete', documentId);
}
</script>

<template>
  <div ref="rootEl" class="document-switcher">
    <button
      type="button"
      class="document-switcher-toggle"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="document-switcher-toggle-title">{{ store.document?.title || 'Untitled' }}</span>
      <svg
        class="document-switcher-caret"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <ul v-if="open" class="document-switcher-menu dialog-box" role="menu" aria-label="Documents">
      <li
        v-for="doc in store.documents"
        :key="doc.id"
        role="none"
        class="document-switcher-row"
        :class="{ 'is-active': doc.id === store.activeDocumentId }"
      >
        <button
          type="button"
          role="menuitemradio"
          :aria-checked="doc.id === store.activeDocumentId"
          class="document-switcher-select"
          @click="selectDocument(doc.id)"
        >
          <span class="document-switcher-title">{{ doc.title || 'Untitled' }}</span>
        </button>
        <button
          type="button"
          class="document-switcher-icon-button document-switcher-rename"
          :aria-label="`Rename ${doc.title || 'Untitled'}`"
          @click="onRename(doc.id, $event)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              d="M4 20l1-4L16 5l3 3L8 19l-4 1z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          class="document-switcher-icon-button document-switcher-delete"
          :disabled="store.documents.length <= 1"
          :aria-label="`Delete ${doc.title || 'Untitled'}`"
          @click="onDelete(doc.id, $event)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              d="M5 7h14M9 7V4h6v3m-8 0v13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </li>
      <li role="none" class="document-switcher-row document-switcher-new-row">
        <button type="button" role="menuitem" class="document-switcher-create" @click="onCreate">
          + New document
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.document-switcher {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}
.document-switcher-toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.document-switcher-toggle-title {
  font-size: 0.95rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-switcher-caret {
  flex: 0 0 auto;
  opacity: 0.7;
}
.document-switcher-menu {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  z-index: var(--z-overlay, 20);
  list-style: none;
  margin: 0;
  padding: 0.35rem;
  min-width: 16rem;
  max-width: min(24rem, 90vw);
  max-height: 60vh;
  overflow: auto;
}
.document-switcher-row {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  border-radius: 6px;
}
.document-switcher-row.is-active {
  background: var(--panel-bg-alt, #eef0f3);
}
.document-switcher-select {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  padding: 0.4rem 0.5rem;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
}
.document-switcher-select:hover {
  background: var(--panel-bg, #f7f7f8);
}
.document-switcher-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-switcher-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  line-height: 0;
  color: inherit;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.document-switcher-icon-button:hover:not(:disabled) {
  background: var(--panel-bg, #f7f7f8);
}
.document-switcher-delete:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.document-switcher-new-row {
  border-top: 1px solid var(--border-color, #ccc);
  margin-top: 0.25rem;
  padding-top: 0.25rem;
}
.document-switcher-create {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 0.4rem 0.5rem;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
}
.document-switcher-create:hover {
  background: var(--panel-bg, #f7f7f8);
}
</style>
