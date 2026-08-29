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

// ---------------------------------------------------------------------------------------------
// Fix 3: click-and-drag resizable panes (Editor | Preview | conversation sidebar), persisted
// per-viewer in localStorage. Only active at the desktop breakpoint — below it, the existing
// responsive @media rules in <style> (unchanged) fully control `.panes`' layout, exactly as
// before this fix.
// ---------------------------------------------------------------------------------------------
const PANE_SIZES_KEY = 'raidr:paneSizes';
const DEFAULT_EDITOR_FR = 1;
const DEFAULT_PREVIEW_FR = 1;
const DEFAULT_SIDEBAR_WIDTH = 380;
const MIN_PANE_PX = 200;
const MIN_SIDEBAR_PX = 260;
const MAX_SIDEBAR_PX = 640;
const HANDLE_SPACE_PX = 12; // two 6px handles between the three panes

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadPaneSizes(): { editorFr: number; previewFr: number; sidebarWidth: number } {
  try {
    const raw = localStorage.getItem(PANE_SIZES_KEY);
    if (!raw) throw new Error('no stored pane sizes');
    const parsed = JSON.parse(raw) as { editorFr?: unknown; previewFr?: unknown; sidebarWidth?: unknown };
    return {
      editorFr: typeof parsed.editorFr === 'number' ? parsed.editorFr : DEFAULT_EDITOR_FR,
      previewFr: typeof parsed.previewFr === 'number' ? parsed.previewFr : DEFAULT_PREVIEW_FR,
      sidebarWidth: typeof parsed.sidebarWidth === 'number' ? parsed.sidebarWidth : DEFAULT_SIDEBAR_WIDTH,
    };
  } catch {
    return { editorFr: DEFAULT_EDITOR_FR, previewFr: DEFAULT_PREVIEW_FR, sidebarWidth: DEFAULT_SIDEBAR_WIDTH };
  }
}

const initialPaneSizes = loadPaneSizes();
const editorFr = ref(initialPaneSizes.editorFr);
const previewFr = ref(initialPaneSizes.previewFr);
const sidebarWidth = ref(initialPaneSizes.sidebarWidth);

function persistPaneSizes(): void {
  try {
    localStorage.setItem(
      PANE_SIZES_KEY,
      JSON.stringify({ editorFr: editorFr.value, previewFr: previewFr.value, sidebarWidth: sidebarWidth.value }),
    );
  } catch {
    // Best-effort persistence — a quota/private-browsing error here must not break resizing.
  }
}

const DESKTOP_QUERY = '(min-width: 961px)';
const desktopMedia = window.matchMedia(DESKTOP_QUERY);
const isDesktop = ref(desktopMedia.matches);
function handleDesktopMediaChange(event: MediaQueryListEvent): void {
  isDesktop.value = event.matches;
}

const panesEl = ref<HTMLDivElement | null>(null);

// Fix 1: History gets its own reserved grid column — never an extra, unaccounted-for grid child
// — only while `historyOpen` is true, so `.panes`' column count is always in sync with however
// many actual grid children it has (previously a 4th child was inserted into a hardcoded 3-column
// template, shoving the conversation sidebar into a second row at the wrong width).
const HISTORY_PANEL_WIDTH_PX = 340;
const panesStyle = computed(() => {
  if (!isDesktop.value) return undefined;
  const base = `${editorFr.value}fr 6px ${previewFr.value}fr 6px ${sidebarWidth.value}px`;
  return { gridTemplateColumns: historyOpen.value ? `${base} ${HISTORY_PANEL_WIDTH_PX}px` : base };
});

type DragKind = 'editor-preview' | 'content-sidebar';

/** Pointer-driven resize (Fix 3): converts a horizontal drag delta into either an editor/preview
 *  `fr` split or a sidebar pixel width, clamped to a sane minimum on each side so a pane can never
 *  be dragged down to nothing. */
function startPaneDrag(kind: DragKind, startEvent: PointerEvent): void {
  startEvent.preventDefault();
  const containerRect = panesEl.value?.getBoundingClientRect();
  if (!containerRect) return;
  const startX = startEvent.clientX;
  const startEditorFr = editorFr.value;
  const startSidebarWidth = sidebarWidth.value;
  const totalFr = startEditorFr + previewFr.value;
  const remainingPx = containerRect.width - HANDLE_SPACE_PX - startSidebarWidth;

  function onMove(moveEvent: PointerEvent): void {
    const deltaX = moveEvent.clientX - startX;
    if (kind === 'editor-preview') {
      const startEditorPx = remainingPx * (startEditorFr / totalFr);
      const nextEditorPx = clamp(startEditorPx + deltaX, MIN_PANE_PX, Math.max(MIN_PANE_PX, remainingPx - MIN_PANE_PX));
      editorFr.value = (nextEditorPx / remainingPx) * totalFr;
      previewFr.value = totalFr - editorFr.value;
    } else {
      sidebarWidth.value = clamp(startSidebarWidth - deltaX, MIN_SIDEBAR_PX, MAX_SIDEBAR_PX);
    }
  }
  function onUp(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    persistPaneSizes();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

const KEYBOARD_RESIZE_STEP_PX = 24;

/** Keyboard-operable equivalent of the drag above (WCAG 2.2 AA, FR-043): ArrowLeft/ArrowRight
 *  while a handle is focused nudges the same split by a fixed step. */
function onPaneHandleKeydown(kind: DragKind, event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const containerRect = panesEl.value?.getBoundingClientRect();
  if (!containerRect) return;
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  if (kind === 'editor-preview') {
    const totalFr = editorFr.value + previewFr.value;
    const remainingPx = containerRect.width - HANDLE_SPACE_PX - sidebarWidth.value;
    const currentEditorPx = remainingPx * (editorFr.value / totalFr);
    const nextEditorPx = clamp(
      currentEditorPx + direction * KEYBOARD_RESIZE_STEP_PX,
      MIN_PANE_PX,
      Math.max(MIN_PANE_PX, remainingPx - MIN_PANE_PX),
    );
    editorFr.value = (nextEditorPx / remainingPx) * totalFr;
    previewFr.value = totalFr - editorFr.value;
  } else {
    sidebarWidth.value = clamp(sidebarWidth.value - direction * KEYBOARD_RESIZE_STEP_PX, MIN_SIDEBAR_PX, MAX_SIDEBAR_PX);
  }
  persistPaneSizes();
}

onMounted(async () => {
  // FR-043b: one pair of visually-hidden ARIA live regions for the whole app — see
  // a11y/live-regions.ts for why this is a plain DOM module rather than a composable.
  mountLiveRegions();
  desktopMedia.addEventListener('change', handleDesktopMediaChange);
  await store.load();
  if (store.document) {
    connectWs();
    await Promise.all([conversationsStore.load(), settingsStore.load()]);
  }
});

onBeforeUnmount(() => {
  wsClient.value?.close();
  desktopMedia.removeEventListener('change', handleDesktopMediaChange);
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
    <div ref="panesEl" class="panes" :style="panesStyle">
      <EditorComponent :model-value="store.content" @change="onEditorChange" @branch-from-selection="onBranchFromSelection" />
      <div
        v-if="isDesktop"
        class="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Editor and Preview panes"
        tabindex="0"
        @pointerdown="startPaneDrag('editor-preview', $event)"
        @keydown="onPaneHandleKeydown('editor-preview', $event)"
      ></div>
      <PreviewComponent :content="store.content" />
      <div
        v-if="isDesktop"
        class="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize conversation sidebar"
        tabindex="0"
        @pointerdown="startPaneDrag('content-sidebar', $event)"
        @keydown="onPaneHandleKeydown('content-sidebar', $event)"
      ></div>
      <aside class="conversation-sidebar">
        <HudPanel :selected-id="selectedConversationId" @select="selectedConversationId = $event" />
        <ConversationView
          v-if="selectedConversationId"
          :conversation-id="selectedConversationId"
          @select="selectedConversationId = $event"
        />
      </aside>

      <!-- Fix 1: History is a genuine, reserved grid column (see `panesStyle` above) that only
           exists in the template — and only ever asked of the grid — while `historyOpen` is true,
           so `.panes`' column count always matches its actual number of children. It renders in
           normal flow alongside every other pane (not as an overlay), so nothing else on the page
           is ever covered or made unreachable while it's open. -->
      <HistoryPanel v-if="historyOpen" class="history-drawer" @close="historyOpen = false" />
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

/* Fix 3: draggable, keyboard-operable resize handles between the major layout regions. */
.resize-handle {
  position: relative;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
}
.resize-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--border-color, #ccc);
}
.resize-handle:hover::after,
.resize-handle:focus-visible::after {
  background: var(--accent-color, #2563eb);
  width: 4px;
}
.resize-handle:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: -2px;
}

/* Fix 1: History renders in normal grid flow, in its own reserved column (see `panesStyle`) —
   never as an overlay, so it never covers or blocks pointer events for anything else on the page. */
.panes :deep(.history-drawer) {
  height: 100%;
  min-height: 0;
  border-left: 2px solid var(--border-color, #ccc);
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
  /* Below the desktop breakpoint, `panesStyle` supplies no inline column template (see script) —
     History (like the conversation sidebar above) instead gets its own full-width row here. */
  .panes :deep(.history-drawer) {
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
