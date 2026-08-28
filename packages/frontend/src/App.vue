<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDocumentStore } from './stores/document.js';
import { useConversationsStore } from './stores/conversations.js';
import { useSettingsStore } from './stores/settings.js';
import { useEditsStore } from './stores/edits.js';
import { WsClient } from './transport/ws-client.js';
import { mountLiveRegions } from './a11y/live-regions.js';
import EditorComponent from './components/editor/EditorComponent.vue';
import PreviewComponent from './components/preview/PreviewComponent.vue';
import HistoryPanel from './components/history/HistoryPanel.vue';
import ReconnectingIndicator from './components/hud/ReconnectingIndicator.vue';
import HudPanel from './components/hud/HudPanel.vue';
import ConversationView from './components/conversation/ConversationView.vue';

const store = useDocumentStore();
const conversationsStore = useConversationsStore();
const settingsStore = useSettingsStore();
const editsStore = useEditsStore();

const pasteText = ref('');
const historyOpen = ref(false);
const wsClient = ref<WsClient | null>(null);
const selectedConversationId = ref<string | null>(null);

const hasDocument = computed(() => store.document !== null);

onMounted(async () => {
  // FR-043b: one pair of visually-hidden ARIA live regions for the whole app — see
  // a11y/live-regions.ts for why this is a plain DOM module rather than a composable.
  mountLiveRegions();
  await store.load();
  if (store.document) {
    connectWs();
    await Promise.all([conversationsStore.load(), settingsStore.load()]);
  }
});

onBeforeUnmount(() => {
  wsClient.value?.close();
});

// Once the conversation list arrives, default the HUD selection to Main so it is immediately
// visible and usable (quickstart.md US2: "Main" is always present).
watch(
  () => conversationsStore.conversations,
  (conversations) => {
    if (selectedConversationId.value) return;
    const main = conversations.find((c) => c.kind === 'main') ?? conversations[0];
    if (main) selectedConversationId.value = main.id;
  },
  { deep: true },
);

function connectWs(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new WsClient(`${protocol}//${location.host}/events`, () => store.eventSequence);
  client.onFrame((frame) => {
    void store.handleServerFrame(frame);
    conversationsStore.handleServerFrame(frame);
    settingsStore.handleServerFrame(frame);
    editsStore.handleServerFrame(frame);
  });
  client.connect();
  wsClient.value = client;
}

async function onCreateDocument(): Promise<void> {
  if (!pasteText.value.trim()) return;
  await store.create(pasteText.value);
  connectWs();
  await Promise.all([conversationsStore.load(), settingsStore.load()]);
}

function onEditorChange(changes: { from: number; to: number; insert: string }[]): void {
  if (!store.document) return;
  void store.patchContent(store.document.currentRevision, changes);
}

/** FR-011: branch a new conversation from the current selection, seeded off Main. */
async function onBranchFromSelection(range: { from: number; to: number }): Promise<void> {
  const main = conversationsStore.conversations.find((c) => c.kind === 'main');
  if (!main) return;
  const conversation = await conversationsStore.branch({ parentConversationId: main.id, selection: range });
  selectedConversationId.value = conversation.id;
}

async function onToggleReasoning(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  await settingsStore.update({ thinkingVisible: checked });
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
      <label class="reasoning-toggle">
        <input type="checkbox" :checked="settingsStore.thinkingVisible" @change="onToggleReasoning" />
        Show reasoning
      </label>
      <button type="button" @click="historyOpen = !historyOpen">
        {{ historyOpen ? 'Hide history' : 'History' }}
      </button>
    </header>
    <div class="panes">
      <EditorComponent :model-value="store.content" @change="onEditorChange" @branch-from-selection="onBranchFromSelection" />
      <PreviewComponent :content="store.content" />
      <HistoryPanel v-if="historyOpen" />
      <aside class="conversation-sidebar">
        <HudPanel :selected-id="selectedConversationId" @select="selectedConversationId = $event" />
        <ConversationView
          v-if="selectedConversationId"
          :conversation-id="selectedConversationId"
          @select="selectedConversationId = $event"
        />
      </aside>
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
  justify-content: flex-end;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color, #ddd);
}
.toolbar h1 {
  margin-right: auto;
  font-size: 1.1rem;
}
.reasoning-toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
}
.panes {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr minmax(300px, 380px);
  min-height: 0;
}
.conversation-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border-color, #ddd);
}
.conversation-sidebar :deep(.hud-panel) {
  flex: 0 0 auto;
  max-height: 40%;
}
.conversation-sidebar :deep(.conversation-view) {
  flex: 1;
  min-height: 0;
}

@media (max-width: 960px) {
  .panes {
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: minmax(300px, auto);
  }
  .conversation-sidebar {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid var(--border-color, #ddd);
    height: 480px;
  }
}

@media (max-width: 640px) {
  .panes {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
    overflow-y: auto;
  }
}
</style>
