<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDocumentStore } from './stores/document.js';
import { useConversationsStore } from './stores/conversations.js';
import { useSettingsStore } from './stores/settings.js';
import { useEditsStore } from './stores/edits.js';
import { WsClient } from './transport/ws-client.js';
import { mountLiveRegions } from './a11y/live-regions.js';
import DocumentCanvas from './components/canvas/DocumentCanvas.vue';
import PreviewComponent from './components/preview/PreviewComponent.vue';
import HistoryPanel from './components/history/HistoryPanel.vue';
import ReconnectingIndicator from './components/hud/ReconnectingIndicator.vue';
import HudPanel, { type ConversationFilter } from './components/hud/HudPanel.vue';
import PrimaryPanel from './components/hud/PrimaryPanel.vue';
import ConversationDetailPanel from './components/conversation/ConversationDetailPanel.vue';
import KeyboardShortcutsDialog from './components/toolbar/KeyboardShortcutsDialog.vue';
import HelpDialog from './components/toolbar/HelpDialog.vue';
import { clamp, useResizeHandle } from './composables/useResizeHandle.js';
import { loadPaneSizes, persistPaneSizes } from './composables/panePersistence.js';
import { useFocusCap } from './composables/focusConfig.js';
import { orderConversationsByAnchor } from './components/canvas/conversationLayout.js';

const store = useDocumentStore();
const conversationsStore = useConversationsStore();
const settingsStore = useSettingsStore();
const editsStore = useEditsStore();

const pasteText = ref('');
const historyOpen = ref(false);
const shortcutsOpen = ref(false);
const helpOpen = ref(false);
const wsClient = ref<WsClient | null>(null);

// 006-toolbar-reorg (confirmed layout): the "Primary" box's own error state (`PrimaryPanel.vue`'s
// `primaryError`) is now rendered here instead, as a full-width strip beneath both toolbar
// columns — `PrimaryPanel.vue` still owns the read/write logic and mirrors it up via `update:error`
// (the same "controlled value, locally-owned writes" split its own `update:filter` prop uses).
const primaryErrorMessage = ref<string | null>(null);
const primaryPanelRef = ref<InstanceType<typeof PrimaryPanel> | null>(null);

// 005-canvas-conversation-threads (multi-focus overlay): replaces the old single-scalar
// `selectedConversationId` — up to `focusCap` conversations may now have an open detail panel
// (`ConversationDetailPanel.vue`, one instance per id) simultaneously, rendered in
// `.conversation-detail-overlay` below. `lastInteractedId` is the separate "last-interacted"
// scalar the confirmed design calls for: it backs `HudPanel.vue`'s Make-Primary/Clear-Primary
// targeting (same role `selectedConversationId` used to play there) *and* is the one signal that
// decides which single panel's `useFocusTrap` is active at any given moment (every other
// simultaneously-open panel renders with its own trap inactive — see `ConversationDetailPanel.vue`).
const focusedConversationIds = ref<Set<string>>(new Set());
const lastInteractedId = ref<string | null>(null);
const conversationFilter = ref<ConversationFilter>('all');

// Live cap = clamp(env default 3, [1, however-many-panels-fit-side-by-side-in-`.panes`]) — see
// `focusConfig.ts`. `panesWidth` is tracked via a `ResizeObserver` on `.panes` (the same element
// the resize handles below already reference), since the overlay spans that whole container, not
// just the canvas column.
const MIN_FOCUSED_PANEL_WIDTH_PX = 420; // ConversationDetailPanel.vue's own `min(480px, 92vw)` plus breathing room
const FOCUSED_PANEL_GAP_PX = 16; // `.conversation-detail-overlay`'s own `gap`
const panesWidth = ref(0);
const viewportFitCount = computed(() =>
  panesWidth.value <= 0
    ? 1
    : Math.max(1, Math.floor((panesWidth.value + FOCUSED_PANEL_GAP_PX) / (MIN_FOCUSED_PANEL_WIDTH_PX + FOCUSED_PANEL_GAP_PX))),
);
const focusCap = useFocusCap(viewportFitCount);

function isFocused(id: string): boolean {
  return focusedConversationIds.value.has(id);
}

/** Adds `id` to the focused set if there's room under the live cap; a no-op (never auto-evicts the
 *  oldest focused conversation) if already at `focusCap` — matching every caller's own
 *  disabled-looking affordance for that same condition. */
function focusConversation(id: string): void {
  if (isFocused(id)) {
    lastInteractedId.value = id;
    return;
  }
  if (focusedConversationIds.value.size >= focusCap.value) return;
  const next = new Set(focusedConversationIds.value);
  next.add(id);
  focusedConversationIds.value = next;
  lastInteractedId.value = id;
}

function unfocusConversation(id: string): void {
  if (!isFocused(id)) return;
  const next = new Set(focusedConversationIds.value);
  next.delete(id);
  focusedConversationIds.value = next;
  lastInteractedId.value = id;
}

/** The one toggle every Focus click (HudPanel row, ConversationThreadBox's Focus/Close buttons)
 *  calls: remove if present, else add if there's room. */
function toggleFocus(id: string): void {
  if (isFocused(id)) unfocusConversation(id);
  else focusConversation(id);
}

/** Atomically swaps one focused conversation for another — used for "cursor" moves that should
 *  keep showing exactly one thing in that slot rather than adding a second panel: HudPanel's
 *  Ctrl+Alt+J/K cycling, and `ConversationView.vue`'s own internal navigation (e.g. "Request
 *  review" switching to the newly created review conversation, FR-036) reaching this via
 *  `ConversationDetailPanel.vue`'s `select` emit. Removing `oldId` first means this never has to
 *  consult the cap — the net size never grows. */
function replaceFocus(oldId: string | null, newId: string): void {
  if (oldId === newId) {
    lastInteractedId.value = newId;
    return;
  }
  if (oldId === null || !isFocused(oldId)) {
    focusConversation(newId);
    return;
  }
  const next = new Set(focusedConversationIds.value);
  next.delete(oldId);
  next.add(newId);
  focusedConversationIds.value = next;
  lastInteractedId.value = newId;
}

/** Clicking the overlay's own backdrop (never a specific panel — see `@click.self` below) closes
 *  every currently-focused conversation at once, the closest multi-panel equivalent of the old
 *  single-overlay's backdrop-dismiss. */
function closeAllFocused(): void {
  focusedConversationIds.value = new Set();
  lastInteractedId.value = null;
}

// Display order for the overlay's panels: always re-derived by filtering `HudPanel.vue`'s own
// root-anchor ordering down to whichever ids are currently focused (never a separately maintained
// order) — see `orderConversationsByAnchor`'s own doc comment in conversationLayout.ts for why this
// is shared rather than reimplemented here.
const orderedFocusedConversations = computed(() => {
  const byId = new Map(conversationsStore.conversations.map((c) => [c.id, c]));
  const focused = conversationsStore.conversations.filter((c) => focusedConversationIds.value.has(c.id));
  return orderConversationsByAnchor(focused, byId);
});

const hasDocument = computed(() => store.document !== null);

// ---------------------------------------------------------------------------------------------
// Fix 3 (extended by 005-canvas-conversation-threads): click-and-drag resizable panes
// (Preview | Canvas), persisted per-viewer in localStorage. Only active at the desktop
// breakpoint — below it, the existing responsive @media rules in <style> (unchanged) fully
// control `.panes`' layout, exactly as before this fix. The old third pane (a HudPanel|
// ConversationView sidebar) is gone — HudPanel now lives in the toolbar row (see below) and each
// conversation's own detail view is opened per-box by DocumentCanvas's ConversationThreadBox
// children, not through one global selection here — see `useResizeHandle`/`panePersistence` for
// the shared drag/keyboard and localStorage logic every split in this file (and
// ConversationView.vue's transcript|edits split) still shares.
// ---------------------------------------------------------------------------------------------
const DEFAULT_PREVIEW_FR = 1;
const DEFAULT_CANVAS_FR = 1;
const MIN_PANE_PX = 200;
const HANDLE_SPACE_PX = 6; // one 6px handle between Preview and Canvas

const initialPaneSizes = loadPaneSizes({
  previewFr: DEFAULT_PREVIEW_FR,
  canvasFr: DEFAULT_CANVAS_FR,
});
const previewFr = ref(initialPaneSizes.previewFr);
const canvasFr = ref(initialPaneSizes.canvasFr);

function persistCurrentPaneSizes(): void {
  persistPaneSizes({
    previewFr: previewFr.value,
    canvasFr: canvasFr.value,
  });
}

const DESKTOP_QUERY = '(min-width: 961px)';
const desktopMedia = window.matchMedia(DESKTOP_QUERY);
const isDesktop = ref(desktopMedia.matches);
function handleDesktopMediaChange(event: MediaQueryListEvent): void {
  isDesktop.value = event.matches;
}

const panesEl = ref<HTMLDivElement | null>(null);

// Tracks `.panes`' own measured width into `panesWidth` (used by `viewportFitCount`/`focusCap`
// above) — a plain `watch` on the template ref (rather than a callback-ref function) since Vue
// already reactively assigns `panesEl` as the element mounts/unmounts; `{ immediate: true }` covers
// the case where `panesEl` is already set by the time this runs.
let panesResizeObserver: ResizeObserver | null = null;
watch(
  panesEl,
  (el) => {
    panesResizeObserver?.disconnect();
    panesResizeObserver = null;
    if (!el) return;
    panesResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) panesWidth.value = entry.contentRect.width;
    });
    panesResizeObserver.observe(el);
  },
  { immediate: true },
);

// Fix 1: History gets its own reserved grid column — never an extra, unaccounted-for grid child
// — only while `historyOpen` is true, so `.panes`' column count is always in sync with however
// many actual grid children it has (previously a 4th child was inserted into a hardcoded 3-column
// template, shoving the conversation sidebar into a second row at the wrong width).
const HISTORY_PANEL_WIDTH_PX = 340;
// Grid order: Preview | Canvas | History (Preview moved left of the canvas — see tasks.md's
// scope note; History is untouched beyond this reordering).
const panesStyle = computed(() => {
  if (!isDesktop.value) return undefined;
  const base = `${previewFr.value}fr 6px ${canvasFr.value}fr`;
  return { gridTemplateColumns: historyOpen.value ? `${base} ${HISTORY_PANEL_WIDTH_PX}px` : base };
});

// Fix (coordinator follow-up, 005-canvas-conversation-threads): `.conversation-detail-overlay`
// below is `position: absolute` with its `right` edge pinned here rather than via a bare CSS
// `inset: 0` — plain `inset: 0` spans `.panes`' *entire* box, including History's own reserved
// grid column (`panesStyle` above) whenever it's open, silently sitting on top of it (the overlay's
// explicit z-index wins regardless of DOM order) and swallowing every pointer event meant for
// History's controls (e.g. "Restore") — directly contradicting the "Fix 1" comment on
// `HistoryPanel` below, which promises History is never covered while open. Shrinking the overlay's
// right edge by History's own reserved column width leaves that column outside the overlay's box
// entirely, so History stays genuinely interactive with any conversation panel focused. Only
// applies on desktop (`isDesktop`) — `panesStyle` itself only reserves that column there; below the
// breakpoint History renders as its own full-width row instead (see the `@media` rules below), a
// layout this fix intentionally leaves alone.
const conversationOverlayStyle = computed(() => ({
  right: isDesktop.value && historyOpen.value ? `${HISTORY_PANEL_WIDTH_PX}px` : '0',
}));

/** Pointer-driven + keyboard-operable resize (Fix 3) for the horizontal Preview|Canvas split:
 *  converts a horizontal drag/step delta into a preview/canvas `fr` split, clamped to a sane
 *  minimum on each side so a pane can never be dragged down to nothing. */
const editorPreviewResize = useResizeHandle({
  axis: 'horizontal',
  containerEl: panesEl,
  beginGesture: (containerRect) => {
    const startPreviewFr = previewFr.value;
    const totalFr = startPreviewFr + canvasFr.value;
    const remainingPx = containerRect.width - HANDLE_SPACE_PX;
    const startPreviewPx = remainingPx * (startPreviewFr / totalFr);
    return (deltaPx) => {
      const nextPreviewPx = clamp(startPreviewPx + deltaPx, MIN_PANE_PX, Math.max(MIN_PANE_PX, remainingPx - MIN_PANE_PX));
      previewFr.value = (nextPreviewPx / remainingPx) * totalFr;
      canvasFr.value = totalFr - previewFr.value;
    };
  },
  onSettle: persistCurrentPaneSizes,
});

// 006-toolbar-reorg: three new app-level hotkeys, none of which belong to the conversation list
// (HudPanel.vue's own Alt+A/Ctrl+Alt+J/K) or any single dialog — they're global controls that now
// live in the toolbar's "Global Actions" box (History, Show reasoning) or the "Primary" box
// (dismiss notice). Same per-component `document`-level listener pattern as HudPanel.vue's own
// `onGlobalKeydown` (mounted/removed alongside this component, since it's alive for the document's
// whole lifetime), including the same `isEditingContext` guard against hijacking normal typing or
// an open dialog's own keys.
function isEditingContext(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('[aria-modal="true"]')) return true;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.isContentEditable;
}

/** Ctrl+Alt+P/R/H — see the doc comment above for why these three (and only these three) live
 *  here rather than in HudPanel.vue or PrimaryPanel.vue. */
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.shiftKey) return;
  if (isEditingContext(event)) return;
  if (!event.ctrlKey || !event.altKey) return;
  if (event.code === 'KeyP') {
    event.preventDefault();
    // One-shot action matching the existing "Dismiss" button, not a toggle — a no-op once the
    // notice is already dismissed (see PrimaryPanel.vue's `dismissNotice`).
    primaryPanelRef.value?.dismissNotice();
    return;
  }
  if (event.code === 'KeyR') {
    event.preventDefault();
    void settingsStore.update({ thinkingVisible: !settingsStore.thinkingVisible });
    return;
  }
  if (event.code === 'KeyH') {
    event.preventDefault();
    historyOpen.value = !historyOpen.value;
  }
}

onMounted(async () => {
  // FR-043b: one pair of visually-hidden ARIA live regions for the whole app — see
  // a11y/live-regions.ts for why this is a plain DOM module rather than a composable.
  mountLiveRegions();
  desktopMedia.addEventListener('change', handleDesktopMediaChange);
  document.addEventListener('keydown', onGlobalKeydown);
  await store.load();
  if (store.document) {
    connectWs();
    await Promise.all([conversationsStore.load(), settingsStore.load()]);
  }
});

onBeforeUnmount(() => {
  wsClient.value?.close();
  desktopMedia.removeEventListener('change', handleDesktopMediaChange);
  document.removeEventListener('keydown', onGlobalKeydown);
  panesResizeObserver?.disconnect();
});

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

/** FR-011: branch a new conversation from the current selection, seeded off Main.
 *  `includeSeedMessage` (005-canvas-conversation-threads) distinguishes the toolbar's two
 *  buttons/keyboard shortcuts: `false` (Alt+Shift+C, "Branch (New)") keeps the empty-placeholder
 *  default; `true` (Alt+Shift+S, "Branch (Main)") asks the backend to also deliver the
 *  selection excerpt as the branch's first message. */
async function onBranchFromSelection(range: { from: number; to: number }, includeSeedMessage: boolean): Promise<void> {
  const main = conversationsStore.conversations.find((c) => c.kind === 'main');
  if (!main) return;
  const conversation = await conversationsStore.branch({
    parentConversationId: main.id,
    selection: range,
    includeSeedMessage,
  });
  // Matches this app's pre-canvas behavior: branching from a selection used to auto-navigate
  // straight into the new conversation's detail view — `focusConversation` is a plain add (a
  // no-op, silently, if the cap is already full; there's nothing to show a disabled-affordance on
  // here, unlike the button-driven paths).
  focusConversation(conversation.id);
}

function scrollBoxIntoView(id: string): void {
  // `.conversation-thread-box` scoping matters: `HudPanel.vue`'s own rows also carry a
  // `data-conversation-id` attribute (for e2e targeting), so a bare attribute selector here would
  // ambiguously match whichever of the two comes first in document order (the HUD row itself,
  // since it's higher up in the toolbar) instead of the canvas box this is actually meant to
  // scroll to.
  document
    .querySelector(`.conversation-thread-box[data-conversation-id="${id}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** US4/T033, extended for multi-focus: a HUD row click toggles that conversation's focus (add/
 *  remove, same as `ConversationThreadBox.vue`'s Focus button) and always scrolls its
 *  `ConversationThreadBox` into view regardless of direction — the box itself stays on the canvas
 *  either way, only its detail panel opens/closes. */
function onHudToggleFocus(id: string): void {
  toggleFocus(id);
  scrollBoxIntoView(id);
}

/** Ctrl+Alt+J/K cycling (HudPanel.vue) — a "replace" cursor move, not a toggle (see `replaceFocus`'s
 *  own doc comment above). */
function onHudCycleFocus(id: string): void {
  replaceFocus(lastInteractedId.value, id);
  scrollBoxIntoView(id);
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
    <!-- 006-toolbar-reorg (confirmed layout): a two-column layout (~80/20) — the left column
         stacks the document title and the "Conversations (HUD)" box (sharing one left edge/width);
         the right column, top-aligned with the title and extending down through the bottom of the
         HUD box (plain flex-row stretch gives this for free), stacks two visually-boxed
         sub-sections: Primary on top, Global Actions below. The error banner is pulled out of the
         Primary box entirely and rendered as its own full-width strip beneath both columns. -->
    <header class="toolbar">
      <div class="toolbar-columns">
        <div class="toolbar-left">
          <h1 class="text-wrap-safe">{{ store.document?.title }}</h1>
          <div class="hud-box">
            <HudPanel
              class="toolbar-hud"
              :active-id="lastInteractedId"
              :focused-ids="focusedConversationIds"
              :focus-cap="focusCap"
              :filter="conversationFilter"
              @update:filter="conversationFilter = $event"
              @toggle-focus="onHudToggleFocus"
              @cycle-focus="onHudCycleFocus"
            />
          </div>
        </div>
        <div class="toolbar-right">
          <PrimaryPanel
            ref="primaryPanelRef"
            class="primary-box"
            :active-id="lastInteractedId"
            @update:error="primaryErrorMessage = $event"
          />
          <div class="global-actions-box">
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
          </div>
        </div>
      </div>
      <div v-if="primaryErrorMessage" class="toolbar-error-banner" role="alert">
        {{ primaryErrorMessage }}
      </div>
    </header>

    <div v-if="shortcutsOpen" class="modal-overlay shortcuts-overlay">
      <KeyboardShortcutsDialog @close="shortcutsOpen = false" />
    </div>
    <div v-if="helpOpen" class="modal-overlay help-overlay">
      <HelpDialog @close="helpOpen = false" />
    </div>
    <div ref="panesEl" class="panes" :style="panesStyle">
      <PreviewComponent :content="store.content" />
      <div
        v-if="isDesktop"
        class="resize-handle resize-handle--horizontal"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Preview and Canvas panes"
        tabindex="0"
        @pointerdown="editorPreviewResize.startDrag($event)"
        @keydown="editorPreviewResize.onKeydown($event)"
      ></div>
      <DocumentCanvas
        :model-value="store.content"
        :filter="conversationFilter"
        :focused-conversation-ids="focusedConversationIds"
        :max-focused-conversations="focusCap"
        @change="onEditorChange"
        @branch-from-selection="onBranchFromSelection"
        @toggle-focus="toggleFocus"
      />

      <!-- Fix 1: History is a genuine, reserved grid column (see `panesStyle` above) that only
           exists in the template — and only ever asked of the grid — while `historyOpen` is true,
           so `.panes`' column count always matches its actual number of children. It renders in
           normal flow alongside every other pane (not as an overlay), so nothing else on the page
           is ever covered or made unreachable while it's open. -->
      <HistoryPanel v-if="historyOpen" class="history-drawer" @close="historyOpen = false" />

      <!-- 005-canvas-conversation-threads (multi-focus overlay): one `ConversationDetailPanel` per
           currently-focused conversation, ordered per `orderedFocusedConversations` above. Still
           positioned within `.panes` (below the toolbar), not the page-covering shared
           `.modal-overlay` class, so the HUD/sidebar stays clickable regardless of how many panels
           are open — clicking another Focus button/HUD row up to the cap keeps working exactly as
           it did with one. -->
      <div
        v-if="orderedFocusedConversations.length > 0"
        class="conversation-detail-overlay"
        :style="conversationOverlayStyle"
        @click.self="closeAllFocused"
      >
        <ConversationDetailPanel
          v-for="conv in orderedFocusedConversations"
          :key="conv.id"
          :conversation-id="conv.id"
          :active="conv.id === lastInteractedId"
          @close="unfocusConversation(conv.id)"
          @interact="lastInteractedId = conv.id"
          @select="replaceFocus(conv.id, $event)"
        />
      </div>
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
/* 006-toolbar-reorg (confirmed layout): `.toolbar` is now a column — `.toolbar-columns` (the
   80/20 title+HUD | Primary+Global-Actions row) on top, and (only while there's an error) the
   full-width error strip beneath it. */
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color, #ddd);
}
.toolbar-columns {
  display: flex;
  align-items: stretch;
  gap: 1rem;
  min-width: 0;
}
/* Left column (~80%): document title above the "Conversations (HUD)" box, stacked as one unit —
   both share this column's left edge/width. */
.toolbar-left {
  flex: 4 1 0%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
/* Right column (~20%): `align-items: stretch` on `.toolbar-columns` (the flex default) already
   makes this column exactly as tall as `.toolbar-left` — i.e. it starts level with the title and
   extends down through the bottom of the HUD box — with no extra sizing math needed here. */
.toolbar-right {
  flex: 1 1 0%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
/* Fix: the document title is unbounded/user-supplied and a long one shouldn't push this column
   wider instead of wrapping. `.text-wrap-safe`'s shared overflow-wrap handling (applied via the
   template class) lives in style.css; `min-width: 0` stays here since it's this flex item's own
   layout concern. */
.toolbar-left h1 {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 1.1rem;
}
/* The "Conversations (HUD)" box and the right column's two sub-sections are each their own
   visually-boxed section, styled identically so the two-column layout reads as one system. */
.hud-box,
.primary-box,
.global-actions-box {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
}
.hud-box {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.toolbar-hud {
  flex: 1 1 auto;
  min-width: 0;
}
/* Global Actions is the bottom box of the right column — `flex: 1 1 auto` lets it absorb
   whatever extra height the stretched column has beyond the Primary box above it, so the column's
   bottom edge still lines up with the HUD box's own bottom edge. */
.global-actions-box {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
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
/* Error banner: pulled out of the Primary box entirely (see `PrimaryPanel.vue`'s `update:error`) —
   a full-width strip beneath BOTH toolbar columns, only rendered when there's an error. */
.toolbar-error-banner {
  padding: 0.4rem 0.5rem;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger-color, #991b1b);
  border-radius: 4px;
  font-size: 0.8rem;
}
.shortcuts-overlay {
  z-index: 50;
}
.help-overlay {
  z-index: 50;
}
.panes {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 0;
}
/* Fix: a grid item's default min-width is `auto`, which respects its content's intrinsic minimum
   width — so once the Preview pane renders something wide (an unwrapped table or code block), its
   column refuses to shrink below that no matter what `fr` share the Preview|Canvas divider assigns
   it, making the divider look broken. `min-width: 0` lets each pane's own `overflow: auto` (already
   present in DocumentCanvas.vue/PreviewComponent.vue) do the shrinking/scrolling instead. */
.panes > * {
  min-width: 0;
}

/* Fix 3: draggable, keyboard-operable resize handle between the major layout regions
   (Preview|Canvas). `--horizontal` is a vertical dividing line dragged left/right; `--vertical`
   (still used by ConversationView.vue's own transcript|edits split) is a horizontal dividing line
   dragged up/down. */
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

/* 005-canvas-conversation-threads (multi-focus overlay): now a *row* of possibly several
   `ConversationDetailPanel.vue` instances (each owns its own dialog/close-button styling — see
   that component) rather than one centered dialog — positioned `absolute` within `.panes` (not the
   shared, page-wide `.modal-overlay` class) so it never covers the toolbar/HUD above it, exactly as
   before: opening additional panels (Focus buttons/HUD rows, up to the cap) must keep working
   without needing to close any already-open one first. `overflow-x: auto` lets the row scroll
   sideways in the (should-be-rare) case its panels' combined width slightly exceeds `.panes`' own
   despite the cap already accounting for `.panes`' measured width. */
.conversation-detail-overlay {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  /* `right` is set inline (`conversationOverlayStyle`) rather than fixed here — it must shrink to
     exclude History's reserved grid column whenever History is open (see that computed's doc
     comment above), which a static CSS value can't express. */
  z-index: 55;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 1rem;
  padding: 1rem;
  overflow-x: auto;
}

@media (max-width: 960px) {
  .panes {
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: minmax(300px, auto);
  }
  /* Below the desktop breakpoint, `panesStyle` supplies no inline column template (see script) —
     History gets its own full-width row here. */
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
