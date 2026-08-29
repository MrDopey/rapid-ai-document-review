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
import KeyboardShortcutsDialog from './components/toolbar/KeyboardShortcutsDialog.vue';
import HelpDialog from './components/toolbar/HelpDialog.vue';
import { clamp, useResizeHandle } from './composables/useResizeHandle.js';
import { loadPaneSizes, persistPaneSizes } from './composables/panePersistence.js';

const store = useDocumentStore();
const conversationsStore = useConversationsStore();
const settingsStore = useSettingsStore();
const editsStore = useEditsStore();

const pasteText = ref('');
const historyOpen = ref(false);
const shortcutsOpen = ref(false);
const helpOpen = ref(false);
const wsClient = ref<WsClient | null>(null);
const selectedConversationId = ref<string | null>(null);

const hasDocument = computed(() => store.document !== null);

// ---------------------------------------------------------------------------------------------
// Fix 3: click-and-drag resizable panes (Editor | Preview | conversation sidebar), persisted
// per-viewer in localStorage. Only active at the desktop breakpoint — below it, the existing
// responsive @media rules in <style> (unchanged) fully control `.panes`' layout, exactly as
// before this fix.
//
// Extended: a second, vertical split inside the sidebar (Conversations list | conversation
// detail) — see `useResizeHandle`/`panePersistence` for the shared drag/keyboard and
// localStorage logic every split in this file (and ConversationView.vue's transcript|edits
// split) now shares.
// ---------------------------------------------------------------------------------------------
const DEFAULT_EDITOR_FR = 1;
const DEFAULT_PREVIEW_FR = 1;
const DEFAULT_SIDEBAR_WIDTH = 380;
const DEFAULT_HUD_FR = 2;
const DEFAULT_CONVERSATION_FR = 3;
const MIN_PANE_PX = 200;
const MIN_SIDEBAR_PX = 260;
const MAX_SIDEBAR_PX = 640;
const MIN_HUD_PX = 120;
const MIN_CONVERSATION_PX = 200;
const HANDLE_SPACE_PX = 12; // two 6px handles between the three panes
const SIDEBAR_HANDLE_SPACE_PX = 6; // one 6px handle between HudPanel and ConversationView

const initialPaneSizes = loadPaneSizes({
  editorFr: DEFAULT_EDITOR_FR,
  previewFr: DEFAULT_PREVIEW_FR,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  hudFr: DEFAULT_HUD_FR,
  conversationFr: DEFAULT_CONVERSATION_FR,
});
const editorFr = ref(initialPaneSizes.editorFr);
const previewFr = ref(initialPaneSizes.previewFr);
const sidebarWidth = ref(initialPaneSizes.sidebarWidth);
const hudFr = ref(initialPaneSizes.hudFr);
const conversationFr = ref(initialPaneSizes.conversationFr);

function persistCurrentPaneSizes(): void {
  persistPaneSizes({
    editorFr: editorFr.value,
    previewFr: previewFr.value,
    sidebarWidth: sidebarWidth.value,
    hudFr: hudFr.value,
    conversationFr: conversationFr.value,
  });
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

/** Pointer-driven + keyboard-operable resize (Fix 3) for the horizontal Editor|Preview split:
 *  converts a horizontal drag/step delta into an editor/preview `fr` split, clamped to a sane
 *  minimum on each side so a pane can never be dragged down to nothing. */
const editorPreviewResize = useResizeHandle({
  axis: 'horizontal',
  containerEl: panesEl,
  beginGesture: (containerRect) => {
    const startEditorFr = editorFr.value;
    const totalFr = startEditorFr + previewFr.value;
    const remainingPx = containerRect.width - HANDLE_SPACE_PX - sidebarWidth.value;
    const startEditorPx = remainingPx * (startEditorFr / totalFr);
    return (deltaPx) => {
      const nextEditorPx = clamp(startEditorPx + deltaPx, MIN_PANE_PX, Math.max(MIN_PANE_PX, remainingPx - MIN_PANE_PX));
      editorFr.value = (nextEditorPx / remainingPx) * totalFr;
      previewFr.value = totalFr - editorFr.value;
    };
  },
  onSettle: persistCurrentPaneSizes,
});

/** Same, for the horizontal content|sidebar split: a single pixel width rather than an `fr`
 *  pair. Dragging the handle right (positive delta) shrinks the sidebar. */
const contentSidebarResize = useResizeHandle({
  axis: 'horizontal',
  containerEl: panesEl,
  beginGesture: () => {
    const startSidebarWidth = sidebarWidth.value;
    return (deltaPx) => {
      sidebarWidth.value = clamp(startSidebarWidth - deltaPx, MIN_SIDEBAR_PX, MAX_SIDEBAR_PX);
    };
  },
  onSettle: persistCurrentPaneSizes,
});

const asideEl = ref<HTMLElement | null>(null);

/** New: the vertical split between the Conversations list (HudPanel) and the conversation
 *  detail area (ConversationView) inside the sidebar. Only meaningful once a conversation is
 *  selected and ConversationView actually renders — see `sidebarStyle`'s single-row fallback and
 *  the handle's `v-if` below, both keyed off the same condition. */
const sidebarStyle = computed(() => {
  if (!selectedConversationId.value) return undefined;
  return { gridTemplateRows: `${hudFr.value}fr ${SIDEBAR_HANDLE_SPACE_PX}px ${conversationFr.value}fr` };
});

const hudConversationResize = useResizeHandle({
  axis: 'vertical',
  containerEl: asideEl,
  beginGesture: (containerRect) => {
    const startHudFr = hudFr.value;
    const totalFr = startHudFr + conversationFr.value;
    const remainingPx = containerRect.height - SIDEBAR_HANDLE_SPACE_PX;
    const startHudPx = remainingPx * (startHudFr / totalFr);
    return (deltaPx) => {
      const nextHudPx = clamp(startHudPx + deltaPx, MIN_HUD_PX, Math.max(MIN_HUD_PX, remainingPx - MIN_CONVERSATION_PX));
      hudFr.value = (nextHudPx / remainingPx) * totalFr;
      conversationFr.value = totalFr - hudFr.value;
    };
  },
  onSettle: persistCurrentPaneSizes,
});

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
      <button
        type="button"
        class="icon-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        @click="shortcutsOpen = true"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M5.5 9h1M9 9h1M12.5 9h1M16 9h1M5.5 12h1M9 12h1M12.5 12h1M16 12h1M7 15h10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Help"
        title="Help"
        @click="helpOpen = true"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M9.6 9.3a2.4 2.4 0 1 1 3.4 2.18c-.7.34-1 .8-1 1.42v.4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="16.7" r="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </header>

    <div v-if="shortcutsOpen" class="modal-overlay shortcuts-overlay">
      <KeyboardShortcutsDialog @close="shortcutsOpen = false" />
    </div>
    <div v-if="helpOpen" class="modal-overlay help-overlay">
      <HelpDialog @close="helpOpen = false" />
    </div>
    <div ref="panesEl" class="panes" :style="panesStyle">
      <EditorComponent :model-value="store.content" @change="onEditorChange" @branch-from-selection="onBranchFromSelection" />
      <div
        v-if="isDesktop"
        class="resize-handle resize-handle--horizontal"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Editor and Preview panes"
        tabindex="0"
        @pointerdown="editorPreviewResize.startDrag($event)"
        @keydown="editorPreviewResize.onKeydown($event)"
      ></div>
      <PreviewComponent :content="store.content" />
      <div
        v-if="isDesktop"
        class="resize-handle resize-handle--horizontal"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize conversation sidebar"
        tabindex="0"
        @pointerdown="contentSidebarResize.startDrag($event)"
        @keydown="contentSidebarResize.onKeydown($event)"
      ></div>
      <aside ref="asideEl" class="conversation-sidebar" :style="sidebarStyle">
        <HudPanel :selected-id="selectedConversationId" @select="selectedConversationId = $event" />
        <div
          v-if="selectedConversationId"
          class="resize-handle resize-handle--vertical"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Conversations list and conversation detail"
          tabindex="0"
          @pointerdown="hudConversationResize.startDrag($event)"
          @keydown="hudConversationResize.onKeydown($event)"
        ></div>
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
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  line-height: 0;
  color: inherit;
}
.shortcuts-overlay {
  z-index: 50;
}
.help-overlay {
  z-index: 50;
}
.panes {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr minmax(300px, 380px);
  min-height: 0;
}
/* Fix: a grid item's default min-width is `auto`, which respects its content's intrinsic minimum
   width — so once the Preview pane renders something wide (an unwrapped table or code block), its
   column refuses to shrink below that no matter what `fr` share the Editor|Preview divider assigns
   it, making the divider look broken. `min-width: 0` lets each pane's own `overflow: auto` (already
   present in EditorComponent.vue/PreviewComponent.vue) do the shrinking/scrolling instead — same
   fix as `.conversation-sidebar`'s children below. */
.panes > * {
  min-width: 0;
}
/* Extended: a grid rather than a flex column, so the HudPanel|ConversationView split (Fix 3)
   can size both regions from `sidebarStyle`'s `fr` row template (falls back to a single row —
   HudPanel filling the whole sidebar — when no conversation is selected and ConversationView
   isn't rendered at all). `min-height: 0` on each `:deep()` child lets its own internal
   `overflow-y: auto` (unchanged, see HudPanel.vue/ConversationView.vue) do the scrolling instead
   of the grid row growing past its track. */
.conversation-sidebar {
  display: grid;
  grid-template-rows: 1fr;
  min-height: 0;
  border-left: 1px solid var(--border-color, #ddd);
}
.conversation-sidebar :deep(.hud-panel),
.conversation-sidebar :deep(.conversation-view) {
  min-height: 0;
  /* Same grid-blowout fix as `.panes > *` above: a conversation row's own content (a long name
     plus several badges) has a content-based automatic minimum width, which — with no explicit
     min-width here — could force this whole sidebar column wider than its 380px track, and with
     it every pane to its left, whenever a document had wide-enough conversation names/badges. */
  min-width: 0;
}

/* Fix 3: draggable, keyboard-operable resize handles between the major layout regions.
   `--horizontal` handles are vertical dividing lines dragged left/right (Editor|Preview,
   content|sidebar); `--vertical` handles are horizontal dividing lines dragged up/down
   (Conversations list|conversation detail, and ConversationView.vue's transcript|edits). */
.resize-handle {
  position: relative;
  touch-action: none;
  background: transparent;
}
.resize-handle--horizontal {
  cursor: col-resize;
}
.resize-handle--horizontal::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--border-color, #ccc);
}
.resize-handle--horizontal:hover::after,
.resize-handle--horizontal:focus-visible::after {
  background: var(--accent-color, #2563eb);
  width: 4px;
}
.resize-handle--vertical {
  cursor: row-resize;
}
.resize-handle--vertical::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: var(--border-color, #ccc);
}
.resize-handle--vertical:hover::after,
.resize-handle--vertical:focus-visible::after {
  background: var(--accent-color, #2563eb);
  height: 4px;
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
