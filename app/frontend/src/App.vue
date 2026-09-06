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
import { HOTKEY_BINDINGS, matchesBinding, isEditingContext, isOverlayOpen } from './a11y/keymap-registry.js';
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

// A bare, unstyled "Loading…" with no timeout would hang forever if the backend is unreachable,
// with no retry/error affordance. `loadError` holds a message once the initial load fails or times
// out; the template (see `!store.loaded` below) swaps the plain "Loading…" for this message plus a
// Retry button that just re-runs `loadInitialDocument`.
const LOAD_TIMEOUT_MS = 15_000;
const loadError = ref<string | null>(null);

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// 005-canvas-conversation-threads (multi-focus overlay): up to `focusCap` conversations may have an
// open detail panel (`ConversationDetailPanel.vue`, one instance per id) simultaneously, rendered
// in `.conversation-detail-overlay` below. The state machine itself (which ids are focused, the
// separate "last-interacted" scalar, add/remove/replace/close-all) is extracted into
// `composables/focusPanelState.ts` — see that module's doc comment for the full behavior;
// App.vue's own job is just wiring it up (computing `focusCap` from `.panes`' measured width below,
// and threading the resulting state through the toolbar/HUD/overlay templates).
const conversationFilter = ref<ConversationFilter>('all');

// Ctrl+Alt+1..9 (`onGlobalKeydown` below): the Nth conversation is whichever one is Nth in this
// same order — mirrors HudPanel.vue's own `filteredConversations`/`orderedConversations` computeds
// exactly (its "Active only"/"All" filter, then `orderConversationsByAnchor`'s HUD ordering) so the
// two can never disagree about "which conversation is Nth in the list the HUD is currently
// showing".
const orderedVisibleConversations = computed(() => {
  const all = conversationsStore.conversations;
  const filtered = conversationFilter.value === 'active' ? all.filter((c) => c.status !== 'closed') : all;
  const byId = new Map(all.map((c) => [c.id, c]));
  return orderConversationsByAnchor(filtered, byId);
});

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

// Keeps two surfaces in sync with `store.document?.title`: the browser tab (`document.title`,
// written here) and the in-app `.document-title-bar` (bound directly in the template below).
// `index.html`'s static `<title>AI Document Review</title>` is this watch's own fallback/pre-load
// value (restored verbatim once no document is loaded). This is the only place in the app that
// ever writes `document.title`.
watch(
  () => store.document?.title,
  (title) => {
    document.title = title ? `${title} - AI Document Review` : 'AI Document Review';
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------------------------
// Click-and-drag resizable panes (Preview | Canvas), persisted per-viewer in localStorage. Only
// active at the desktop breakpoint — below it, the existing responsive @media rules in <style>
// fully control `.panes`' layout. HudPanel lives in the toolbar row (see below); each
// conversation's own detail view is opened per-box by DocumentCanvas's ConversationThreadBox
// children, not through one global selection here — see `useResizeHandle`/`panePersistence` for
// the shared drag/keyboard and localStorage logic every split in this file (and
// ConversationView.vue's transcript|edits split) shares.
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
// editorVisible/toggleEditorVisible gate only DocumentCanvas's internal EditorComponent (via the
// editorVisible prop), not the DocumentCanvas pane itself — so the conversation sidebar/thread
// columns inside DocumentCanvas always keep rendering and stay usable even when the editor is
// hidden. App.vue's own grid column for DocumentCanvas is therefore never collapsed by this
// toggle; only previewVisible still collapses a track here (see panesStyle).
//
// At least one of Preview/Editor must always stay visible — `togglePreviewVisible`/
// `toggleEditorVisible` below silently no-op (rather than throwing or forcing the other back open)
// if the requested toggle would hide the last visible one; the two buttons in `.actions-group`
// mirror that with a `disabled` attribute computed from the same condition, and Ctrl+Alt+P/
// Ctrl+Alt+E (`onGlobalKeydown` below) share these same functions, so all three entry points
// enforce the invariant identically.
//
// Judgment call: this guard's purpose is preserving "some view of the document's actual content"
// (rendered preview or raw markdown) by never letting both Preview and the editor be hidden at
// once. It doesn't need to guarantee the conversation sidebar is visible — that lives in the
// always-rendered DocumentCanvas pane and stays usable independent of this guard. Persisted the
// same per-viewer, best-effort way as `syncScrollEnabled` above, via `panePersistence.ts`.
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

// History gets its own reserved grid column — never an extra, unaccounted-for grid child — only
// while `historyOpen` is true, so `.panes`' column count is always in sync with however many
// actual grid children it has.
const HISTORY_PANEL_WIDTH_PX = 340;
// Grid order: Preview | handle | Canvas | History (Preview moved left of the canvas — see
// tasks.md's scope note; History is untouched beyond this reordering).
//
// Independent Preview/Editor visibility: only Preview's own track can still collapse here — the
// Canvas track (`DocumentCanvas`, editor + conversation sidebar) is never hidden as a whole
// (`editorVisible` only hides `DocumentCanvas`'s *internal* editor pane, via a prop — see that
// ref's own doc comment above), so its own grid track always gets its full `canvasFr` share. The
// resize handle collapses to `0px` (and is un-rendered — see the template's `v-if` below) whenever
// Preview is hidden, since there's nothing left to drag between two panes when the Canvas pane is
// the entire row.
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

// CSS grid auto-placement assigns any item without an explicit `grid-column`/`grid-row` to a
// track by DOM order, counting only items that actually generate a box — an item hidden via
// `v-show` (`display: none`) generates none at all and is skipped entirely from that count (the
// same rule applies to a `v-if`-removed element). So whenever Preview is hidden, `DocumentCanvas`
// — the next real grid item in source order — would be auto-placed into column 1 (Preview's own,
// now-empty `0fr` track) instead of column 3, collapsing Canvas to zero width while the real,
// `1fr`-wide column 3 sits empty. Pinning every pane's `grid-column` explicitly (matching the
// fixed track order `panesStyle` above assumes: Preview=1, handle=2, Canvas=3, [History]=4 — the
// same order `conversationOverlayStyle` below relies on for Canvas) makes each one's column
// assignment independent of which of its siblings currently exist as boxes.
const previewGridColumn = computed(() => (isDesktop.value ? '1 / 2' : undefined));
const resizeHandleGridColumn = computed(() => (isDesktop.value ? '2 / 3' : undefined));
const canvasGridColumn = computed(() => (isDesktop.value ? '3 / 4' : undefined));
const historyGridColumn = computed(() => (isDesktop.value ? '4 / 5' : undefined));

// `.conversation-detail-overlay` below is `position: absolute` with no explicit `grid-column` of
// its own, so per the CSS Grid spec its containing block for that absolute positioning falls back
// to `.panes`' entire padding box — Preview + the resize handle + Canvas (+ History's reserved
// column, when open) combined — rather than just the Canvas column it visually sits over. Its
// `justify-content: center` then centers the focused panel(s) against that *combined* width, so
// dragging the Preview|Canvas splitter (which only changes how that combined width is split, via
// `previewFr`/`canvasFr` in `panesStyle` above) shifts Canvas's actual position/width without
// moving the overlay's centering reference, and the panel would visibly drift off Canvas/the
// editor underneath it.
//
// Pinning `grid-column: 3 / 4` here (Canvas's own track — see the "Grid order" comment on
// `panesStyle` above: Preview, handle, Canvas, [History]) makes that column itself the overlay's
// containing block, so its `inset: 0` (set in CSS) resolves against exactly Canvas's current
// edges — tracking the splitter live with no JS recalculation needed — and, as a side effect,
// already excludes History's own column 4 by construction whenever History is open, so no
// separate `historyOpen`-dependent width math is needed to keep History interactive. Both line
// numbers must be spelled out (`3 / 4`, not the bare `3` shorthand): per the CSS Grid abspos-
// containing-block rules, an edge only becomes the corresponding grid line's edge when its own
// grid-column-start/end is explicitly non-auto — `3` alone only sets grid-column-start (leaving
// -end auto), so the right edge would fall back to `.panes`' own padding edge (i.e. past History's
// column) instead of Canvas's own right edge. Only applies on desktop (`isDesktop`) —
// `panesStyle` itself only establishes that column layout there; below the breakpoint `.panes`
// reflows to rows (see the `@media` rules below) where Canvas is no longer a distinct column, so
// the overlay spans `.panes`' full box.
const conversationOverlayStyle = computed(() => (isDesktop.value ? { gridColumn: '3 / 4' } : undefined));

/** Pointer-driven + keyboard-operable resize for the horizontal Preview|Canvas split:
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

// App-level hotkeys, none of which belong to the conversation list (HudPanel.vue's own
// Alt+A/Ctrl+Alt+J/K) or any single dialog — they're global controls living in the toolbar's
// "Global Actions" box (History, Show reasoning) or the "Primary" box (dismiss notice). Same
// per-component `document`-level listener pattern as HudPanel.vue's own `onGlobalKeydown`
// (mounted/removed alongside this component, since it's alive for the document's whole lifetime).
//
// Hotkey-consolidation refactor: this used to be a hand-rolled `if (event.ctrlKey && ...)` chain
// per shortcut. Every binding's own modifiers+code+scope now lives once in
// `a11y/keymap-registry.ts`'s `HOTKEY_BINDINGS` (the machine-checkable source of truth
// `findConflicts` scans for collisions) — this function only still owns the *handlers* (what
// happens when a binding fires), looked up from `globalBindingHandlers` below by the matched
// binding's `id`. `matchesBinding`/`isEditingContext`/`isOverlayOpen` are the shared guard/match
// helpers imported above.
const GLOBAL_BINDINGS = HOTKEY_BINDINGS.filter((b) => b.scope === 'Global');
// Ctrl+Alt+1..9 and the new cycle-focused-conversations shortcut both change *which* conversation
// panel(s) are focused/active — like the pre-existing digit shortcuts, these must stay a no-op
// while any dialog is open (`isOverlayOpen`), not just while the event's own target happens to sit
// inside one (`isEditingContext` alone only covers that narrower case) — see `isOverlayOpen`'s own
// doc comment in a11y/keymap-registry.ts.
const OVERLAY_GUARDED_BINDING_IDS = new Set<string>([
  ...GLOBAL_BINDINGS.filter((b) => b.id.startsWith('focus-toggle-')).map((b) => b.id),
  'cycle-conversation-prev',
  'cycle-conversation-prev-arrow',
  'cycle-conversation-next',
  'cycle-conversation-next-arrow',
  'cycle-conversation-next-alt',
]);

/** Ctrl+Alt+H/Ctrl+Alt+ArrowLeft (previous) and Ctrl+Alt+L/Ctrl+Alt+N/Ctrl+Alt+ArrowRight (next):
 *  moves which already-focused conversation panel is "active" (`lastInteractedId`) among
 *  `orderedFocusedConversations` — the same list/order the multi-focus overlay below renders —
 *  wrapping at both ends. Mirrors HudPanel.vue's own `cycleByOffset` (Ctrl+Alt+J/K) but cycles only
 *  the currently-focused subset, never adding/removing a focused panel the way `toggleFocus`/
 *  `replaceFocus` do. A no-op with 0 or 1 focused conversations — there's nothing to cycle to. */
function cycleFocusedConversation(offset: number): void {
  const list = orderedFocusedConversations.value;
  if (list.length <= 1) return;
  const currentIndex = list.findIndex((c) => c.id === lastInteractedId.value);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length;
  lastInteractedId.value = list[nextIndex]!.id;
}

/** Every `HOTKEY_BINDINGS` id this component owns, mapped to its actual handler — Y ("sync") sits
 *  alongside R/H's "Global Actions" box for the same reason: a global, toolbar-level toggle, not
 *  owned by any single pane. P/E (Preview/Editor visibility) share `togglePreviewVisible`/
 *  `toggleEditorVisible` with the two buttons in `.actions-group`, so the "never hide both" guard
 *  is enforced in exactly one place regardless of entry point. `focus-toggle-<N>` isn't listed here
 *  — its handler needs the matched digit itself, so `onGlobalKeydown` below special-cases it
 *  directly rather than threading the digit through this table. */
const globalBindingHandlers: Record<string, () => void> = {
  'toggle-reasoning': () => void settingsStore.update({ thinkingVisible: !settingsStore.thinkingVisible }),
  'toggle-history': () => {
    historyOpen.value = !historyOpen.value;
  },
  'toggle-sync-scroll': toggleSyncScroll,
  'toggle-preview': togglePreviewVisible,
  'toggle-editor': toggleEditorVisible,
  'cycle-conversation-prev': () => cycleFocusedConversation(-1),
  'cycle-conversation-prev-arrow': () => cycleFocusedConversation(-1),
  'cycle-conversation-next': () => cycleFocusedConversation(1),
  'cycle-conversation-next-arrow': () => cycleFocusedConversation(1),
  'cycle-conversation-next-alt': () => cycleFocusedConversation(1),
};

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey) return;
  const binding = GLOBAL_BINDINGS.find((b) => matchesBinding(event, b));
  if (!binding) return;
  // `composerExempt` bindings (the cycle-focused-conversations shortcut, and Ctrl+Alt+1..9's
  // conversation-focus toggle) fire even while the event's target is a conversation composer's own
  // textarea — a user's most common reason to press either is from inside the very composer they're
  // typing in (e.g. to un-focus/close that panel, or jump to another). Every other binding here
  // keeps the blanket "any textarea/input/select/contenteditable blocks a global shortcut" rule
  // unchanged.
  if (isEditingContext(event, { allowComposer: binding.composerExempt === true })) return;
  if (OVERLAY_GUARDED_BINDING_IDS.has(binding.id) && isOverlayOpen()) return;
  event.preventDefault();

  const digitMatch = /^focus-toggle-(\d)$/.exec(binding.id);
  if (digitMatch) {
    const index = Number(digitMatch[1]) - 1;
    const target = orderedVisibleConversations.value[index];
    if (target) toggleFocus(target.id);
    return;
  }

  globalBindingHandlers[binding.id]?.();
}

/** The initial document load, wrapped so it can be re-run verbatim by the Retry button below —
 *  times out after `LOAD_TIMEOUT_MS` (an unreachable backend would otherwise leave `store.loaded`
 *  false forever, with nothing in the template ever able to distinguish "still loading" from
 *  "never going to finish") and catches any rejection (network error, non-2xx, etc.) instead of
 *  letting it become an unhandled rejection with no visible effect. */
async function loadInitialDocument(): Promise<void> {
  loadError.value = null;
  try {
    await withTimeout(store.load(), LOAD_TIMEOUT_MS, "Couldn't reach the server. Please check your connection.");
    if (store.document) {
      connectWs();
      await Promise.all([conversationsStore.load(), settingsStore.load()]);
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : "Couldn't load the document.";
  }
}

onMounted(async () => {
  // FR-043b: one pair of visually-hidden ARIA live regions for the whole app — see
  // a11y/live-regions.ts for why this is a plain DOM module rather than a composable.
  mountLiveRegions();
  desktopMedia.addEventListener('change', handleDesktopMediaChange);
  document.addEventListener('keydown', onGlobalKeydown);
  await loadInitialDocument();
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
  // Each store owns its own `subscribeToFrames` wiring (see the `subscribeToFrames` method on
  // stores/document.ts, conversations.ts, settings.ts and edits.ts) — this loop is the single
  // place a new store's frame handling needs to be registered, rather than a hand-listed
  // `someStore.handleServerFrame(frame)` call per store inside `client.onFrame`, where nothing
  // would enforce that adding a new store here means remembering to add its own line too.
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
  // `EditorComponent.vue`'s own "Branch (New)"/"Branch (Main)" buttons (and their keyboard
  // shortcuts) are already disabled/blocked whenever `atFocusCap` — this is defense in depth
  // against a same-tick race (e.g. another panel getting focused between render and click), not
  // the common case.
  if (atFocusCap.value) return;
  const conversation = await conversationsStore.branch({
    parentConversationId: main.id,
    selection: range,
    includeSeedMessage,
  });
  // Branching from a selection auto-navigates straight into the new conversation's detail view.
  // Guaranteed a free slot by the guard above, so this always succeeds — `focusConversation`'s own
  // cap check is only ever a defense-in-depth no-op here, same as every other caller below.
  focusConversation(conversation.id);
}

/** Shared by all three non-toolbar branch entry points that report success via an event rather
 *  than a direct return value — the sidebar's "Branch this conversation"
 *  (`ConversationThreadBox.vue`, relayed through `DocumentCanvas.vue`'s own `branch-created`) and
 *  the focus-view's "Branch" (`ConversationView.vue`, relayed through
 *  `ConversationDetailPanel.vue`). (The toolbar path reports success via `onBranchFromSelection`'s
 *  own return value above instead, since it calls `conversationsStore.branch` directly.)
 *
 * Every one of these three components' own Branch button/action is blocked outright whenever
 * `atFocusCap` (see each one's own `branchDisabled`/`atFocusCap`-gated
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

  <main v-if="loadError" class="loading load-error" role="alert">
    <p>{{ loadError }}</p>
    <button type="button" @click="loadInitialDocument">Retry</button>
  </main>

  <main v-else-if="!store.loaded" class="loading">Loading…</main>

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
    <!-- A two-column layout (~80/20): the document title, plus the Keyboard-shortcuts/Help icon
         triggers pinned to its right, shows via `.document-title-bar` above both columns (and in
         the browser tab — see the `document.title` watch in <script>); the left column holds just
         the "Conversations (HUD)" box (whose rows now also carry their own Make/Clear Primary
         button — see HudPanel.vue); the right column, top-aligned with the HUD box and extending
         down through its bottom (plain flex-row stretch gives this for free), holds just the
         Global Actions box. The Primary designation error banner is rendered as its own full-width
         strip beneath both columns. -->
    <header class="toolbar">
      <!-- `store.document` is always set here (this whole branch is `v-else` of `!hasDocument`
           above), so `.title` is always available; the `'AI Document Review'` fallback is purely
           defensive (an empty-string title, say) rather than something this branch is ever
           expected to hit in practice. -->
      <div class="document-title-bar">
        <h1 class="document-title-text">{{ store.document?.title || 'AI Document Review' }}</h1>
        <!-- Icon-only controls (labels dropped, aria-label/title kept for a11y), pinned to the
             title bar's right edge. -->
        <div class="title-bar-icons">
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
          <!-- Global Actions: two side-by-side columns — checkboxes on the left, buttons on the
               right — now `.toolbar-right`'s only content, since Primary's own visible chrome moved
               into `ConversationThreadBox.vue`/`ConversationView.vue`'s own per-conversation action
               rows (see `composables/primaryAction.ts`). -->
          <div class="actions-group">
            <div class="actions-col actions-col-checkboxes">
              <label class="reasoning-toggle">
                <input type="checkbox" :checked="settingsStore.thinkingVisible" @change="onToggleReasoning" />
                Show reasoning
              </label>
              <label class="reasoning-toggle" title="Scroll the Editor and Preview panes together. Keyboard shortcut: Ctrl+Alt+Y">
                <input type="checkbox" :checked="syncScrollEnabled" @change="onToggleSyncScrollCheckbox" />
                Sync scroll
              </label>
            </div>
            <div class="actions-col actions-col-buttons">
              <button
                type="button"
                :title="
                  historyOpen
                    ? 'Hide the History panel. Keyboard shortcut: Ctrl+Alt+Shift+H'
                    : 'Show the History panel. Keyboard shortcut: Ctrl+Alt+Shift+H'
                "
                @click="historyOpen = !historyOpen"
              >
                {{ historyOpen ? 'Hide history' : 'History' }}
              </button>
              <button
                type="button"
                :disabled="previewVisible && !editorVisible"
                :title="
                  previewVisible
                    ? 'Hide the Preview pane — the Canvas pane expands to fill the space. Keyboard shortcut: Ctrl+Alt+P'
                    : 'Show the Preview pane. Keyboard shortcut: Ctrl+Alt+P'
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
                    ? 'Hide the document editor — the conversation sidebar stays visible and expands to fill the space. Keyboard shortcut: Ctrl+Alt+E'
                    : 'Show the document editor. Keyboard shortcut: Ctrl+Alt+E'
                "
                @click="toggleEditorVisible"
              >
                {{ editorVisible ? 'Hide editor' : 'Show editor' }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <!-- `documentStore.conflictMessage` (stores/document.ts) is set when the server rejects a
           manual edit because the document changed elsewhere while it was in flight (a 409). Same
           dismissible-notice shape as the app's busy-switch dialog surroundings (the app's existing
           convention for a dismissible inline notice), with a real per-viewer dismiss action
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

    <Transition name="modal">
      <div v-if="shortcutsOpen" class="modal-overlay shortcuts-overlay">
        <KeyboardShortcutsDialog @close="shortcutsOpen = false" />
      </div>
    </Transition>
    <Transition name="modal">
      <div v-if="helpOpen" class="modal-overlay help-overlay">
        <HelpDialog @close="helpOpen = false" />
      </div>
    </Transition>
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

      <!-- History is a genuine, reserved grid column (see `panesStyle` above) that only
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
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  height: 100vh;
  padding: 2rem;
  text-align: center;
}
.load-error p {
  margin: 0;
  color: var(--danger-color, #991b1b);
}
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
/* Left column (~80%): just the "Conversations (HUD)" box. Kept as a flex column (rather than
   collapsed straight into `.hud-box`) for future extensibility — a later addition to this column
   would otherwise have to reintroduce the wrapper. */
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
/* The "Conversations (HUD)" box and the right column's "Global Actions" box are each their own
   visually-boxed section, styled identically so the two-column layout reads as one system. */
.hud-box,
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
/* "Global Actions" is now `.toolbar-right`'s only content (Primary's own visible chrome moved into
   `ConversationThreadBox.vue`/`ConversationView.vue`'s own action rows), so it alone absorbs the
   column's stretched height, keeping the column's bottom edge level with the HUD box's own bottom
   edge. Two side-by-side columns: the checkbox toggles on the left, the action buttons on the
   right (see `.actions-col` below). */
.actions-group {
  flex: 1 1 auto;
  display: flex;
  gap: 0.75rem;
}
.actions-col {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1 1 0%;
  min-width: 0;
}
.actions-col-buttons {
  align-items: stretch;
}
.actions-col-buttons > button {
  width: 100%;
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
/* Deliberately small/unobtrusive — this two-column toolbar layout (see the comment on
   `.toolbar-columns` below) has no spare vertical room for a large heading. A flex row: the title
   text takes the available space (truncating with an ellipsis, per `.document-title-text` below)
   with the Keyboard-shortcuts/Help icon buttons pinned to the right. */
.document-title-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.document-title-text {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-bar-icons {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
/* A dismissible-notice shape shared with `HistoryPanel.vue`'s conventions elsewhere, but amber/
   warning-toned rather than a neutral info-blue — this reflects a real, already-happened
   data-loss event (the user's last edit was dropped), not just informational first-time guidance. */
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
/* These are independent, page-level "simple" modals with no nesting relationship to
   `.conversation-detail-overlay` below, but a user can open either one while a conversation is
   focused (`--z-overlay-detail`), so they must render above that tier — hence
   `--z-overlay-blocking` (style.css `:root`), the tier reserved for exactly this "must always
   render above everything else" case. */
.shortcuts-overlay {
  z-index: var(--z-overlay-blocking, 70);
}
.help-overlay {
  z-index: var(--z-overlay-blocking, 70);
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
/* A grid item's default min-width is `auto`, which respects its content's intrinsic minimum
   width — so once the Preview pane renders something wide (an unwrapped table or code block), its
   column refuses to shrink below that no matter what `fr` share the Preview|Canvas divider assigns
   it, making the divider look broken. `min-width: 0` lets each pane's own `overflow: auto` (already
   present in DocumentCanvas.vue/PreviewComponent.vue) do the shrinking/scrolling instead. */
.panes > * {
  min-width: 0;
}

/* Draggable, keyboard-operable resize handle between the major layout regions
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

/* History renders in normal grid flow, in its own reserved column (see `panesStyle`) —
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
     falls back to spanning `.panes`' full box. */
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
