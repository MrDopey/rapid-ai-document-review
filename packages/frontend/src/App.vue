<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDocumentStore } from './stores/document.js';
import { WsClient } from './transport/ws-client.js';
import EditorComponent from './components/editor/EditorComponent.vue';
import PreviewComponent from './components/preview/PreviewComponent.vue';
import HistoryPanel from './components/history/HistoryPanel.vue';
import ReconnectingIndicator from './components/hud/ReconnectingIndicator.vue';

const store = useDocumentStore();
const pasteText = ref('');
const historyOpen = ref(false);
const wsClient = ref<WsClient | null>(null);

const hasDocument = computed(() => store.document !== null);

onMounted(async () => {
  await store.load();
  if (store.document) {
    connectWs();
  }
});

onBeforeUnmount(() => {
  wsClient.value?.close();
});

function connectWs(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new WsClient(`${protocol}//${location.host}/events`, () => store.eventSequence);
  client.onFrame((frame) => {
    void store.handleServerFrame(frame);
  });
  client.connect();
  wsClient.value = client;
}

async function onCreateDocument(): Promise<void> {
  if (!pasteText.value.trim()) return;
  await store.create(pasteText.value);
  connectWs();
}

function onEditorChange(changes: { from: number; to: number; insert: string }[]): void {
  if (!store.document) return;
  void store.patchContent(store.document.currentRevision, changes);
}
</script>

<template>
  <ReconnectingIndicator :reconnecting="wsClient?.reconnecting ?? false" />

  <main v-if="!store.loaded" class="loading">Loading…</main>

  <section v-else-if="!hasDocument" class="paste-screen">
    <h1>Paste your document</h1>
    <textarea
      v-model="pasteText"
      aria-label="Document content"
      placeholder="# My document&#10;&#10;Paste or type Markdown here…"
    ></textarea>
    <button type="button" :disabled="!pasteText.trim()" @click="onCreateDocument">
      Start reviewing
    </button>
  </section>

  <div v-else class="editor-layout">
    <header class="toolbar">
      <h1>{{ store.document?.title }}</h1>
      <button type="button" @click="historyOpen = !historyOpen">
        {{ historyOpen ? 'Hide history' : 'History' }}
      </button>
    </header>
    <div class="panes">
      <EditorComponent :model-value="store.content" @change="onEditorChange" />
      <PreviewComponent :content="store.content" />
      <HistoryPanel v-if="historyOpen" />
    </div>
  </div>
</template>

<style scoped>
.paste-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 2rem;
}
.paste-screen textarea {
  width: 100%;
  max-width: 700px;
  height: 300px;
}
.editor-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color, #ddd);
}
.panes {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 0;
}

@media (max-width: 640px) {
  .panes {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
    overflow-y: auto;
  }
}
</style>
