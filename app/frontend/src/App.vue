<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import {
  loadPaneSizes,
  persistPaneSizes,
  loadSyncScrollEnabled,
  persistSyncScrollEnabled,
  loadPreviewVisible,
  persistPreviewVisible,
  loadEditorVisible,
  persistEditorVisible,
} from './composables/panePersistence.js';
import { attachScrollSync } from './composables/scrollSync.js';
import { useFocusCap } from './composables/focusConfig.js';
import { useFocusPanelState } from './composables/focusPanelState.js';
import { isEditingContext } from './a11y/keymap-registry.js';

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

// 005-canvas-conversation-threads (multi-focus overlay): up to `focusCap` conversations may have an
// open detail panel (`ConversationDetailPanel.vue`, one instance per id) simultaneously, rendered
// in `.conversation-detail-overlay` below. The state machine itself (which ids are focused, the
// separate "last-interacted" scalar, add/remove/replace/close-all) is extracted into
// `composables/focusPanelState.ts` — see that module's doc comment for the full behavior;
// App.vue's own job is just wiring it up (computing `focusCap` from `.panes`' measured width below,
// and threading the resulting state through the toolbar/HUD/overlay templates).
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

const {
  focusedConversationIds,
  lastInteractedId,
  atFocusCap,
  orderedFocusedConversations,
  focusConversation,
  unfocusConversation,
  toggleFocus,
  replaceFocus,
  closeAllFocused,
} = useFocusPanelState(focusCap);

const hasDocument = computed(() => store.document !== null);

// The document's title used to render in the topbar (`.toolbar-left`'s `<h1>`) — removed from
// there to free that column's height for the HUD box; it now lives only in the browser tab, kept
// in sync with `store.document?.title` reactively. `index.html`'s static `<title>AI Document
// Review</title>` is this watch's own fallback/pre-load value (restored verbatim once no document
// is loaded), so this is the only place in the app that ever writes `document.title` — no separate
// title-management module existed to reuse (checked `main.ts`/router setup: neither sets it).
watch(
  () => store.document?.title,
  (title) => {
    document.title = title ? `${title} - AI Document Review` : 'AI Document Review';
  },
  { immediate: true },
);

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
// Neither pane may be dragged below 30% of `.panes`' total measured width — a fraction of the
// *container*, not a fixed pixel floor (this replaces an earlier fixed-`200px` minimum), so the
// clamp scales with viewport size the same way the 30% requirement is specified against.
const MIN_PANE_FRACTION = 0.3;
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

// Slide-transition support (Preview/Editor visibility toggle — see `panesStyle`'s own
// `grid-template-columns` transition below): tracks whether the Preview|Canvas splitter is
// actively being dragged, so that transition can be suppressed for the drag's own live,
// pointer-1:1 track-size changes — only a visibility *toggle* (`togglePreviewVisible`/
// `toggleEditorVisible`) should ever animate; a manual drag must stay instant.
const previewSplitDragging = ref(false);

// ---------------------------------------------------------------------------------------------
// Independent Preview/Editor visibility toggles: either can be hidden to give the other (and,
// since a hidden pane's grid track collapses to 0 width — see `panesStyle` below — the rest of the
// row, e.g. the conversation-detail overlay) the freed horizontal room.
//
// Bug-fix (editor-vs-canvas scope fix): this used to be `canvasVisible`, hiding the *entire*
// `DocumentCanvas` pane — editor AND the conversation sidebar/thread columns — via `v-show` on
// `<DocumentCanvas>` itself below. That hid the sidebar along with the editor, which broke the
// (only) use case for hiding it: keeping the conversation sidebar usable while the editor is out of
// the way. Renamed to `editorVisible`/`toggleEditorVisible` and re-scoped to a prop
// (`DocumentCanvas`'s new `editorVisible`) that only gates its internal `EditorComponent` — the
// `DocumentCanvas` pane itself (and thus `.thread-columns`) now always renders; `App.vue`'s own
// grid column for it is therefore never collapsed by this toggle (only `previewVisible` still
// collapses a track here — see `panesStyle`).
//
// At least one of Preview/Editor must always stay visible — `togglePreviewVisible`/
// `toggleEditorVisible` below silently no-op (rather than throwing or forcing the other back open)
// if the requested toggle would hide the last visible one; the two buttons in `.actions-group`
// mirror that with a `disabled` attribute computed from the same condition, and Ctrl+Alt+1/
// Ctrl+Alt+2 (`onGlobalKeydown` below) share these same functions, so all three entry points
// enforce the invariant identically.
//
// Judgment call: kept this "never hide both" guard even though hiding both Preview and the editor
// no longer hides *everything* (the conversation sidebar, inside the always-rendered
// `DocumentCanvas` pane, would still be visible and usable) — the guard's remaining purpose is
// preserving "some view of the document's actual content" (rendered preview or raw markdown), which
// is still a real guarantee worth keeping now that it accurately maps to just those two panes'
// scope. Persisted the same per-viewer, best-effort way as `syncScrollEnabled` above, via
// `panePersistence.ts`.
// ---------------------------------------------------------------------------------------------
const previewVisible = ref(loadPreviewVisible());
const editorVisible = ref(loadEditorVisible());

function togglePreviewVisible(): void {
  const next = !previewVisible.value;
  if (!next && !editorVisible.value) return; // would hide the last visible pane
  previewVisible.value = next;
  persistPreviewVisible(next);
}

function toggleEditorVisible(): void {
  const next = !editorVisible.value;
  if (!next && !previewVisible.value) return; // would hide the last visible pane
  editorVisible.value = next;
  persistEditorVisible(next);
}

// ---------------------------------------------------------------------------------------------
// Synchronized scrolling between the Preview pane and the Editor/Canvas pane (composables/
// scrollSync.ts has the full mapping-strategy/feedback-loop-guard rationale). Off by default —
// there's no existing partial implementation or related persisted state to match, so this starts
// exactly like every other independent-scroll pane pair in the app until a viewer opts in; that
// choice is then persisted per-viewer via `panePersistence.ts`, the same convention `previewFr`/
// `canvasFr` above and `DocumentCanvas.vue`'s own scroll-position persistence already use.
// ---------------------------------------------------------------------------------------------
const syncScrollEnabled = ref(loadSyncScrollEnabled());
const previewComponentRef = ref<InstanceType<typeof PreviewComponent> | null>(null);
const documentCanvasRef = ref<InstanceType<typeof DocumentCanvas> | null>(null);
let detachScrollSync: (() => void) | null = null;

function toggleSyncScroll(): void {
  syncScrollEnabled.value = !syncScrollEnabled.value;
  persistSyncScrollEnabled(syncScrollEnabled.value);
}

function onToggleSyncScrollCheckbox(event: Event): void {
  syncScrollEnabled.value = (event.target as HTMLInputElement).checked;
  persistSyncScrollEnabled(syncScrollEnabled.value);
}

// Both panes only exist in the DOM once `hasDocument` is true (the `v-else="hasDocument"` branch
// below) — wiring/tearing down alongside it (rather than once in `onMounted`) covers the
// paste-screen -> document transition without leaking a listener pair onto elements that no
// longer exist. `attachScrollSync` itself gates on `syncScrollEnabled`, so this wiring is safe to
// leave attached regardless of the toggle's own on/off state.
watch(
  hasDocument,
  async (has) => {
    detachScrollSync?.();
    detachScrollSync = null;
    if (!has) return;
    await nextTick();
    const previewEl = previewComponentRef.value?.scrollEl ?? null;
    const canvasScrollEl = documentCanvasRef.value?.scrollEl ?? null;
    if (previewEl && canvasScrollEl) {
      detachScrollSync = attachScrollSync(previewEl, canvasScrollEl, () => syncScrollEnabled.value);
    }
  },
  { immediate: true },
);

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
// Grid order: Preview | handle | Canvas | History (Preview moved left of the canvas — see
// tasks.md's scope note; History is untouched beyond this reordering).
//
// Independent Preview/Editor visibility: only Preview's own track can still collapse here — the
// Canvas track (`DocumentCanvas`, editor + conversation sidebar) is never hidden as a whole any
// more (bug-fix, editor-vs-canvas scope fix: `editorVisible` now only hides `DocumentCanvas`'s
// *internal* editor pane, via a prop — see that ref's own doc comment above), so its own grid
// track always gets its full `canvasFr` share. The resize handle collapses to `0px` (and is
// un-rendered — see the template's `v-if` below) whenever Preview is hidden, since there's nothing
// left to drag between two panes when the Canvas pane is the entire row.
const panesStyle = computed(() => {
  if (!isDesktop.value) return undefined;
  const previewTrack = previewVisible.value ? `${previewFr.value}fr` : '0fr';
  const base = `${previewTrack} ${previewVisible.value ? '6px' : '0px'} ${canvasFr.value}fr`;
  return {
    gridTemplateColumns: historyOpen.value ? `${base} ${HISTORY_PANEL_WIDTH_PX}px` : base,
    // Slide transition (Preview hide/show toggle only): CSS Grid track sizes are transitionable
    // in modern browsers via `transition: grid-template-columns`, so animating this one property
    // smoothly covers both the Preview track's own 1fr/0fr (and its handle's 6px/0px) collapse
    // *and* the neighboring Canvas track visibly growing into the freed space, since both are
    // driven by this single value. Suppressed to `none` while the Preview|Canvas splitter itself
    // is being dragged (`previewSplitDragging`) — a live, 1:1-with-pointer drag must never lag
    // behind a transition's easing curve. `@media (prefers-reduced-motion: reduce)` in <style>
    // below `!important`-overrides this inline value for users who've asked for reduced motion.
    transition: previewSplitDragging.value ? 'none' : 'grid-template-columns 220ms ease',
  };
});

// Bug 2 root-cause fix: CSS grid auto-placement assigns any item without an explicit
// `grid-column`/`grid-row` to a track by DOM order, counting only items that actually generate a
// box — an item hidden via `v-show` (`display: none`) generates none at all and is skipped
// entirely from that count (the same rule that applies to a `v-if`-removed element). So whenever
// Preview was hidden, `DocumentCanvas` — the next real grid item in source order — was silently
// auto-placed into column 1 (Preview's own, now-empty `0fr` track) instead of column 3, collapsing
// Canvas to zero width while the real, `1fr`-wide column 3 sat empty: exactly "hiding preview hides
// everything". Pinning every pane's `grid-column` explicitly (matching the fixed track order
// `panesStyle` above assumes: Preview=1, handle=2, Canvas=3, [History]=4 — the same order
// `conversationOverlayStyle` below already relies on for Canvas) makes each one's column
// assignment independent of which of its siblings currently exist as boxes.
const previewGridColumn = computed(() => (isDesktop.value ? '1 / 2' : undefined));
const resizeHandleGridColumn = computed(() => (isDesktop.value ? '2 / 3' : undefined));
const canvasGridColumn = computed(() => (isDesktop.value ? '3 / 4' : undefined));
const historyGridColumn = computed(() => (isDesktop.value ? '4 / 5' : undefined));

// Fix (coordinator follow-up, 005-canvas-conversation-threads): `.conversation-detail-overlay`
// below is `position: absolute` with no explicit `grid-column` of its own, so per the CSS Grid
// spec its containing block for that absolute positioning falls back to `.panes`' entire padding
// box — Preview + the resize handle + Canvas (+ History's reserved column, when open) combined —
// rather than just the Canvas column it visually sits over. Its `justify-content: center` then
// centers the focused panel(s) against that *combined* width, so dragging the Preview|Canvas
// splitter (which only changes how that combined width is split, via `previewFr`/`canvasFr` in
// `panesStyle` above) shifts Canvas's actual position/width without moving the overlay's centering
// reference, and the panel visibly drifts off Canvas/the editor underneath it.
//
// Pinning `grid-column: 3 / 4` here (Canvas's own track — see the "Grid order" comment on
// `panesStyle` above: Preview, handle, Canvas, [History]) makes that column itself the overlay's
// containing block, so its `inset: 0` (set in CSS) resolves against exactly Canvas's current
// edges — tracking the splitter live with no JS recalculation needed — and, as a side effect,
// already excludes History's own column 4 by construction whenever History is open, so no
// separate `historyOpen`-dependent width math (this computed's previous `right` value) is needed
// to keep History interactive. Both line numbers must be spelled out (`3 / 4`, not the bare `3`
// shorthand): per the CSS Grid abspos-containing-block rules, an edge only becomes the
// corresponding grid line's edge when its own grid-column-start/end is explicitly non-auto — `3`
// alone only sets grid-column-start (leaving -end auto), so the right edge would still fall back
// to `.panes`' own padding edge (i.e. past History's column) instead of Canvas's own right edge.
// Only applies on desktop (`isDesktop`) — `panesStyle` itself only establishes that column layout
// there; below the breakpoint `.panes` reflows to rows (see the `@media` rules below) where
// Canvas is no longer a distinct column, so the overlay falls back to spanning `.panes`' full box
// exactly as it already did pre-fix, a layout this fix intentionally leaves alone.
const conversationOverlayStyle = computed(() => (isDesktop.value ? { gridColumn: '3 / 4' } : undefined));

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
    // 30% minimum is a fraction of `.panes`' *total* width (`containerRect.width`, handle included)
    // per the spec, not of `remainingPx` (the handle-excluded space the fr split is computed over)
    // — the two are close enough in practice (the handle is 6px) that this distinction rarely
    // matters, but `containerRect.width` is the literal "total available `.panes` width".
    const minPx = containerRect.width * MIN_PANE_FRACTION;
    return (deltaPx) => {
      const nextPreviewPx = clamp(startPreviewPx + deltaPx, minPx, Math.max(minPx, remainingPx - minPx));
      previewFr.value = (nextPreviewPx / remainingPx) * totalFr;
      canvasFr.value = totalFr - previewFr.value;
    };
  },
  onSettle: () => {
    persistCurrentPaneSizes();
    previewSplitDragging.value = false;
  },
});

/** Wraps `editorPreviewResize.startDrag` only to flag the drag's own duration
 *  (`previewSplitDragging`, reset by `onSettle` above) so `panesStyle`'s `grid-template-columns`
 *  transition never applies to this splitter's live pointer-driven track changes — see that
 *  computed's own doc comment. */
function onPreviewHandlePointerDown(event: PointerEvent): void {
  previewSplitDragging.value = true;
  editorPreviewResize.startDrag(event);
}

// 006-toolbar-reorg: three new app-level hotkeys, none of which belong to the conversation list
// (HudPanel.vue's own Alt+A/Ctrl+Alt+J/K) or any single dialog — they're global controls that now
// live in the toolbar's "Global Actions" box (History, Show reasoning) or the "Primary" box
// (dismiss notice). Same per-component `document`-level listener pattern as HudPanel.vue's own
// `onGlobalKeydown` (mounted/removed alongside this component, since it's alive for the document's
// whole lifetime), including the same shared `isEditingContext` guard (a11y/keymap-registry.ts,
// imported above) against hijacking normal typing or an open dialog's own keys — both listeners
// used to reimplement this same check independently; now both import the one definition.

/** Ctrl+Alt+P/R/H/Y/1/2 — see the doc comment above for why these (and only these) live here
 *  rather than in HudPanel.vue or PrimaryPanel.vue. Y ("sync") was added alongside R/H's "Global
 *  Actions" box for the same reason: a global, toolbar-level toggle, not owned by any single pane.
 *  1/2 (Preview/Editor visibility) share `togglePreviewVisible`/`toggleEditorVisible` with the two
 *  buttons in `.actions-group`, so the "never hide both" guard is enforced in exactly one place
 *  regardless of entry point. */
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
  if (event.code === 'KeyY') {
    event.preventDefault();
    toggleSyncScroll();
  }
  if (event.code === 'Digit1') {
    event.preventDefault();
    togglePreviewVisible();
  }
  if (event.code === 'Digit2') {
    event.preventDefault();
    toggleEditorVisible();
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
  detachScrollSync?.();
});

function connectWs(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new WsClient(`${protocol}//${location.host}/events`, () => store.eventSequence);
  // Fix (WS-fanout): each store owns its own `subscribeToFrames` wiring (see the `subscribeToFrames`
  // method on stores/document.ts, conversations.ts, settings.ts and edits.ts) — this loop is the
  // single place a 5th store's frame handling would need to be registered, rather than a
  // hand-listed `someStore.handleServerFrame(frame)` call per store inside `client.onFrame`, where
  // nothing enforced that adding a new store here meant remembering to add its own line too.
  for (const frameSubscriber of [store, conversationsStore, settingsStore, editsStore]) {
    frameSubscriber.subscribeToFrames(client);
  }
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
  // Branch-cap parity fix: `EditorComponent.vue`'s own "Branch (New)"/"Branch (Main)" buttons (and
  // their keyboard shortcuts) are already disabled/blocked whenever `atFocusCap` — this is defense
  // in depth against a same-tick race (e.g. another panel getting focused between render and
  // click), not the common case.
  if (atFocusCap.value) return;
  const conversation = await conversationsStore.branch({
    parentConversationId: main.id,
    selection: range,
    includeSeedMessage,
  });
  // Matches this app's pre-canvas behavior: branching from a selection used to auto-navigate
  // straight into the new conversation's detail view. Guaranteed a free slot by the guard above, so
  // this always succeeds — `focusConversation`'s own cap check is only ever a defense-in-depth
  // no-op here, same as every other caller below.
  focusConversation(conversation.id);
}

/** Shared by all three non-toolbar branch entry points that report success via an event rather
 *  than a direct return value — the sidebar's "Branch this conversation"
 *  (`ConversationThreadBox.vue`, relayed through `DocumentCanvas.vue`'s own `branch-created`) and
 *  the focus-view's "Branch" (`ConversationView.vue`, relayed through
 *  `ConversationDetailPanel.vue`). (The toolbar path reports success via `onBranchFromSelection`'s
 *  own return value above instead, since it calls `conversationsStore.branch` directly.)
 *
 * Branch-cap parity fix: every one of these three components' own Branch button/action is now
 * blocked outright whenever `atFocusCap` (see each one's own `branchDisabled`/`atFocusCap`-gated
 * click handler) — so by the time this fires, a free slot is always guaranteed, and
 * `focusConversation`'s own cap check below is only ever defense in depth against a same-tick race,
 * never the reason a branch fails to get auto-focused. Never evicts an existing panel to make room;
 * whichever panel the branch came from (if any) stays open either way. */
function onBranchCreated(id: string): void {
  focusConversation(id);
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
         holds just the "Conversations (HUD)" box now (the document title used to stack above it
         here — see the `document.title` watch in <script>, which moved it to the browser tab
         instead, freeing this column's height for the HUD box); the right column, top-aligned with
         the HUD box and extending down through its bottom (plain flex-row stretch gives this for
         free), stacks two visually-boxed sub-sections: Primary on top, Global Actions below. The
         error banner is pulled out of the Primary box entirely and rendered as its own full-width
         strip beneath both columns. -->
    <header class="toolbar">
      <div class="toolbar-columns">
        <div class="toolbar-left">
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
          <!-- Row 1: Primary controls (col 1) and the Keyboard-shortcuts/Help icon triggers
               (col 2), side by side. `.primary-box` and `.info-group` used to live in separate
               boxes (the latter pinned to the bottom of a since-removed `.global-actions-box`);
               this row simply places them next to each other instead. -->
          <div class="toolbar-right-row-1">
            <PrimaryPanel
              ref="primaryPanelRef"
              class="primary-box"
              :active-id="lastInteractedId"
              @update:error="primaryErrorMessage = $event"
            />
            <!-- Icon-only controls (labels dropped, aria-label/title kept for a11y), rendered as
                 a tight centered cluster rather than stretched half-width cells. -->
            <div class="info-group">
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
          <!-- Rows 2 & 3: 006-toolbar-reorg (confirmed layout), extended for the Preview/Canvas
               visibility toggles — explicit, fixed 2-row grouping: row 2 is the two checkbox
               toggles, row 3 is the three buttons. Previously nested (alongside `.info-group`)
               inside a `.global-actions-box`; that wrapper is gone, so `.actions-group` is now
               `.toolbar-right`'s own second child and absorbs the column's stretched height
               directly (see its `flex: 1 1 auto` below). -->
          <div class="actions-group">
            <div class="actions-row actions-row-1">
              <label class="reasoning-toggle">
                <input type="checkbox" :checked="settingsStore.thinkingVisible" @change="onToggleReasoning" />
                Show reasoning
              </label>
              <label class="reasoning-toggle" title="Scroll the Editor and Preview panes together. Keyboard shortcut: Ctrl+Alt+Y">
                <input type="checkbox" :checked="syncScrollEnabled" @change="onToggleSyncScrollCheckbox" />
                Sync scroll
              </label>
            </div>
            <div class="actions-row actions-row-2">
              <button type="button" @click="historyOpen = !historyOpen">
                {{ historyOpen ? 'Hide history' : 'History' }}
              </button>
              <button
                type="button"
                :disabled="previewVisible && !editorVisible"
                :title="
                  previewVisible
                    ? 'Hide the Preview pane — the Canvas pane expands to fill the space. Keyboard shortcut: Ctrl+Alt+1'
                    : 'Show the Preview pane. Keyboard shortcut: Ctrl+Alt+1'
                "
                @click="togglePreviewVisible"
              >
                {{ previewVisible ? 'Hide preview' : 'Show preview' }}
              </button>
              <button
                type="button"
                :disabled="editorVisible && !previewVisible"
                :title="
                  editorVisible
                    ? 'Hide the document editor — the conversation sidebar stays visible and expands to fill the space. Keyboard shortcut: Ctrl+Alt+2'
                    : 'Show the document editor. Keyboard shortcut: Ctrl+Alt+2'
                "
                @click="toggleEditorVisible"
              >
                {{ editorVisible ? 'Hide editor' : 'Show editor' }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="primaryErrorMessage" class="toolbar-error-banner" role="alert">
        {{ primaryErrorMessage }}
      </div>
      <!-- Fix (conflictMessage wiring): `documentStore.conflictMessage` (stores/document.ts) is set
           when the server rejects a manual edit because the document changed elsewhere while it was
           in flight (a 409) — previously nothing displayed it. Same dismissible-notice shape as
           `PrimaryPanel.vue`'s own `.primary-notice`/`.dismiss-notice-button` (the app's existing
           convention for a dismissible inline notice), rather than the plain non-dismissible
           `.toolbar-error-banner` strip above, since this one has a real per-viewer dismiss action
           (`clearConflictMessage`) rather than just reflecting still-live state. -->
      <div v-if="store.conflictMessage" class="toolbar-conflict-banner" role="alert">
        <span>{{ store.conflictMessage }}</span>
        <button
          type="button"
          class="dismiss-notice-button"
          aria-label="Dismiss conflict notice"
          @click="store.clearConflictMessage()"
        >
          Dismiss
        </button>
      </div>
    </header>

    <div v-if="shortcutsOpen" class="modal-overlay shortcuts-overlay">
      <KeyboardShortcutsDialog @close="shortcutsOpen = false" />
    </div>
    <div v-if="helpOpen" class="modal-overlay help-overlay">
      <HelpDialog @close="helpOpen = false" />
    </div>
    <div ref="panesEl" class="panes" :style="panesStyle">
      <PreviewComponent
        v-show="previewVisible"
        ref="previewComponentRef"
        :style="{ gridColumn: previewGridColumn }"
        :content="store.content"
      />
      <div
        v-if="isDesktop && previewVisible"
        class="resize-handle resize-handle--horizontal"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Preview and Canvas panes"
        :aria-valuenow="Math.round((previewFr / (previewFr + canvasFr)) * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
        tabindex="0"
        :style="{ gridColumn: resizeHandleGridColumn }"
        @pointerdown="onPreviewHandlePointerDown($event)"
        @keydown="editorPreviewResize.onKeydown($event)"
      ></div>
      <DocumentCanvas
        ref="documentCanvasRef"
        :style="{ gridColumn: canvasGridColumn }"
        :model-value="store.content"
        :filter="conversationFilter"
        :focused-conversation-ids="focusedConversationIds"
        :max-focused-conversations="focusCap"
        :editor-visible="editorVisible"
        @change="onEditorChange"
        @branch-from-selection="onBranchFromSelection"
        @toggle-focus="toggleFocus"
        @branch-created="onBranchCreated"
      />

      <!-- Fix 1: History is a genuine, reserved grid column (see `panesStyle` above) that only
           exists in the template — and only ever asked of the grid — while `historyOpen` is true,
           so `.panes`' column count always matches its actual number of children. It renders in
           normal flow alongside every other pane (not as an overlay), so nothing else on the page
           is ever covered or made unreachable while it's open. -->
      <HistoryPanel
        v-if="historyOpen"
        class="history-drawer"
        :style="{ gridColumn: historyGridColumn }"
        @close="historyOpen = false"
      />

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
          :at-focus-cap="atFocusCap"
          :max-focused="focusCap"
          @close="unfocusConversation(conv.id)"
          @interact="lastInteractedId = conv.id"
          @select="replaceFocus(conv.id, $event)"
          @branch-created="onBranchCreated"
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
/* Left column (~80%): just the "Conversations (HUD)" box now — the document title that used to
   stack above it here moved to the browser tab (see the `document.title` watch in <script>),
   freeing this column's height for the HUD box. Kept as a flex column (rather than collapsed
   straight into `.hud-box`) since a future addition to this column would otherwise have to
   reintroduce the wrapper. */
.toolbar-left {
  flex: 4 1 0%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
/* Right column (~20%): `align-items: stretch` on `.toolbar-columns` (the flex default) already
   makes this column exactly as tall as `.toolbar-left` — i.e. it starts level with, and extends
   down through the bottom of, the HUD box — with no extra sizing math needed here. */
.toolbar-right {
  flex: 1 1 0%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
/* The "Conversations (HUD)" box and the right column's boxed sub-sections are each their own
   visually-boxed section, styled identically so the two-column layout reads as one system. */
.hud-box,
.primary-box,
.info-group,
.actions-group {
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
/* Row 1 of `.toolbar-right`: `.primary-box` (col 1) and `.info-group` (col 2) side by side.
   `.primary-box` gets the lion's share of the width; `.info-group`'s icon cluster only needs
   its content width. `align-items: flex-start` (rather than the flex default `stretch`) keeps
   `.info-group` hugging its own content height instead of stretching to match however tall the
   Primary notice/buttons happen to be. Neither grows vertically here — row 2/3's
   `.actions-group` (below) is the one that absorbs the column's stretched height.
   `flex-wrap: wrap` matches the same narrow-width behavior `.actions-row` (below) already relies
   on: at the ~20%-width right column's narrowest breakpoints there isn't room for both the
   Primary box's text/buttons *and* the icon cluster's own minimum content width on one line, so
   `.info-group` drops to its own line beneath `.primary-box` instead of forcing this row wider
   than `.toolbar-right` and overflowing its border. */
.toolbar-right-row-1 {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.5rem;
}
/* A 10rem flex-basis (rather than `auto`) matters here specifically because `.primary-box` is a
   plain `<div>` with no intrinsic width of its own — `flex-basis: auto` on a sizeless block
   resolves to fill the available space, which would leave no room for `.info-group` beside it
   and force a wrap even at comfortable widths. 10rem is enough to fit `.primary-box`'s content at
   this column's typical (~1400px-viewport) width without wrapping, while still being the first
   thing to give up its share of space (`min-width: 0`) once the column gets too narrow for both
   columns — at that point `flex-wrap` above takes over and drops `.info-group` to its own line. */
.primary-box {
  flex: 1 1 10rem;
  min-width: 0;
}
/* Rows 2 & 3 of `.toolbar-right`: "Show reasoning" + "Sync scroll" (row 2) and "History" +
   "Hide/Show preview" + "Hide/Show editor" (row 3). Explicit, fixed 2-row grouping — rather than
   relying on `grid-template-columns: repeat(auto-fit, ...)` to happen to wrap into that same
   grouping at a given container width — each row is its own flex container so the grouping is
   structural (survives any width) instead of incidental to wrapping. `.actions-group` is
   `.toolbar-right`'s second (and last) child, so `flex: 1 1 auto` lets it absorb whatever extra
   height the stretched column has beyond row 1's height, keeping the column's bottom edge level
   with the HUD box's own bottom edge. */
.actions-group {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.actions-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.actions-row > * {
  flex: 1 1 6.5rem;
  min-width: 6.5rem;
}
/* "Keyboard shortcuts" + "Help", icon-only. Deliberately NOT a 2-column stretch — a tight,
   centered cluster with normal gap spacing reads better than half-width icon cells; it doesn't
   grow to fill row 1's height beyond its own content. `flex-shrink` is left at its default
   (1, not 0) as a second line of defense alongside `.toolbar-right-row-1`'s `flex-wrap`: even
   once this has wrapped onto its own line beneath `.primary-box`, shrinking lets it settle to
   the line's width rather than overflowing `.toolbar-right`'s border by a few pixels. */
.info-group {
  flex: 0 1 auto;
  display: flex;
  justify-content: center;
  align-items: center;
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
/* Fix (conflictMessage wiring): same dismissible-notice shape as `PrimaryPanel.vue`'s own
   `.primary-notice`, but amber/warning-toned rather than that one's neutral info-blue — this
   reflects a real, already-happened data-loss event (the user's last edit was dropped), not just
   informational first-time guidance. */
.toolbar-conflict-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  background: var(--warning-bg, #fef3c7);
  color: var(--warning-color, #92400e);
  border: 1px solid var(--warning-border, #fde68a);
  border-radius: 4px;
  font-size: 0.8rem;
}
.toolbar-error-banner {
  padding: 0.4rem 0.5rem;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger-color, #991b1b);
  border-radius: 4px;
  font-size: 0.8rem;
}
.shortcuts-overlay {
  z-index: var(--z-overlay, 50);
}
.help-overlay {
  z-index: var(--z-overlay, 50);
}
.panes {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 0;
}
/* Slide transition (Preview/Editor visibility toggle — see `panesStyle`'s own doc comment in
   <script>, which sets `transition` as an inline style): honor `prefers-reduced-motion: reduce` by
   skipping it entirely. `!important` is required since inline styles otherwise beat any plain
   selector's specificity — an `!important` external rule is the one thing that still overrides it. */
@media (prefers-reduced-motion: reduce) {
  .panes {
    transition: none !important;
  }
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
  /* `grid-column: 3 / 4` (Canvas's own track) is set inline on desktop via `conversationOverlayStyle`
     — see that computed's doc comment above — making Canvas's grid cell this element's containing
     block, so a plain `inset: 0` here resolves against exactly Canvas's current edges instead of
     `.panes`' entire box. Below the desktop breakpoint no inline `grid-column` is set, so this
     falls back to spanning `.panes`' full box, matching the pre-fix mobile layout. */
  inset: 0;
  z-index: var(--z-overlay-detail, 55);
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
