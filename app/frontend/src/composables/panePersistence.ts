/**
 * Every resizable split in the app (App.vue's Editor|Preview, content|sidebar, and
 * Conversations-list|conversation-detail; ConversationView.vue's transcript|proposed-edits)
 * persists into this one shared localStorage blob, keyed by viewer, rather than one key per
 * split — so `persistPaneSizes` read-merge-writes instead of replacing the blob outright: two
 * different components calling it back-to-back must not stomp on each other's fields.
 */
const PANE_SIZES_KEY = 'raidr:paneSizes';

type PaneSizesRecord = Record<string, number>;

function readStored(): PaneSizesRecord {
  try {
    const raw = localStorage.getItem(PANE_SIZES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as PaneSizesRecord) : {};
  } catch {
    return {};
  }
}

/** Reads whichever of `defaults`' keys are present (and numeric) in the shared blob, falling
 *  back to `defaults` for anything missing or corrupt. */
export function loadPaneSizes<K extends string>(defaults: Record<K, number>): Record<K, number> {
  const stored = readStored();
  const result = {} as Record<K, number>;
  for (const key of Object.keys(defaults) as K[]) {
    const value = stored[key];
    result[key] = typeof value === 'number' && Number.isFinite(value) ? value : defaults[key];
  }
  return result;
}

/** Best-effort, read-merge-write persistence — a quota/private-browsing error here must not
 *  break resizing. */
export function persistPaneSizes(values: PaneSizesRecord): void {
  try {
    const merged = { ...readStored(), ...values };
    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(merged));
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * 005-canvas-conversation-threads/T034 (data-model.md's `CanvasScrollPosition`, research.md §8):
 * the canvas's native scroll offsets — a distinct key from `PANE_SIZES_KEY` above since this is a
 * single `{ scrollLeft, scrollTop }` pair, not an extensible `defaults`-shaped record of named
 * `fr`/pixel splits. Same per-viewer, best-effort, non-throwing convention as the rest of this file.
 */
const CANVAS_SCROLL_KEY = 'raidr:canvasScrollPosition';

export interface CanvasScrollPosition {
  scrollLeft: number;
  scrollTop: number;
}

export function loadCanvasScrollPosition(): CanvasScrollPosition | null {
  try {
    const raw = localStorage.getItem(CANVAS_SCROLL_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as CanvasScrollPosition).scrollLeft === 'number' &&
      typeof (parsed as CanvasScrollPosition).scrollTop === 'number'
    ) {
      return parsed as CanvasScrollPosition;
    }
    return null;
  } catch {
    return null;
  }
}

export function persistCanvasScrollPosition(position: CanvasScrollPosition): void {
  try {
    localStorage.setItem(CANVAS_SCROLL_KEY, JSON.stringify(position));
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * "Sync scroll" toggle (App.vue's `.actions-group`, composables/scrollSync.ts) — a lone boolean,
 * same per-viewer/best-effort/non-throwing convention as the rest of this file, under its own key
 * for the same reason `CANVAS_SCROLL_KEY` is: not an `fr`/pixel split `loadPaneSizes` already
 * shapes for. Defaults to on whenever nothing valid is stored yet; an explicit stored `'false'`
 * (a user who toggled it off) is still respected.
 */
const SYNC_SCROLL_ENABLED_KEY = 'raidr:syncScrollEnabled';

export function loadSyncScrollEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SYNC_SCROLL_ENABLED_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function persistSyncScrollEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SYNC_SCROLL_ENABLED_KEY, String(enabled));
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * Preview/Editor visibility toggles (App.vue's `.actions-group`, Ctrl+Alt+1/Ctrl+Alt+2) — two
 * independent booleans, same per-viewer/best-effort/non-throwing/"defaults to on" convention as
 * `SYNC_SCROLL_ENABLED_KEY` above, each under its own key for the same reason that one is: not an
 * `fr`/pixel split `loadPaneSizes` already shapes for. App.vue itself is responsible for never
 * persisting (or reaching) a state where both are false — these loaders/setters don't enforce that
 * invariant themselves.
 *
 * `editorVisible` gates only `DocumentCanvas.vue`'s own `EditorComponent` child, not the whole
 * `DocumentCanvas` pane — the conversation sidebar/thread columns must stay visible/usable even
 * when the document editor is hidden, so `App.vue`'s `DocumentCanvas` pane always renders
 * regardless of this flag. Persisted under its own key, `raidr:editorVisible`, distinct from any
 * old `raidr:canvasVisible` key a viewer's browser might still hold — reusing that key would
 * silently reinterpret a stored "canvas hidden" value under this flag's different meaning; a fresh
 * key means such a viewer just resets to the default (editor visible) once instead.
 */
const PREVIEW_VISIBLE_KEY = 'raidr:previewVisible';
const EDITOR_VISIBLE_KEY = 'raidr:editorVisible';

function loadVisibilityFlag(key: string): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

function persistVisibilityFlag(key: string, visible: boolean): void {
  try {
    localStorage.setItem(key, String(visible));
  } catch {
    // Best-effort persistence only.
  }
}

export function loadPreviewVisible(): boolean {
  return loadVisibilityFlag(PREVIEW_VISIBLE_KEY);
}

export function persistPreviewVisible(visible: boolean): void {
  persistVisibilityFlag(PREVIEW_VISIBLE_KEY, visible);
}

export function loadEditorVisible(): boolean {
  return loadVisibilityFlag(EDITOR_VISIBLE_KEY);
}

export function persistEditorVisible(visible: boolean): void {
  persistVisibilityFlag(EDITOR_VISIBLE_KEY, visible);
}

/**
 * DocumentCanvas.vue's Editor|Conversation-sidebar split (`.canvas-content`'s `.editor-pane` vs
 * `.thread-columns`) — a second, independent drag-to-resize splitter one level down from
 * `PANE_SIZES_KEY`'s Preview|Canvas split above, mirroring that one's naming/clamp convention
 * (`MIN_PANE_FRACTION`-style drag clamp, per-viewer persistence) but scoped entirely to
 * `DocumentCanvas.vue`'s own internal layout. Stored as a single fraction (the editor pane's own
 * share of the split, clamped to `MIN_PANE_FRACTION`..`1 - MIN_PANE_FRACTION` — see
 * `DocumentCanvas.vue`'s `editorThreadResize`), so — like `CANVAS_SCROLL_KEY`/
 * `SYNC_SCROLL_ENABLED_KEY` above — it gets its own dedicated key rather than joining
 * `loadPaneSizes`'s extensible named-`fr` blob, which `previewFr`/`canvasFr` alone use.
 */
const EDITOR_SPLIT_KEY = 'raidr:editorSplit';

/** Falls back to `defaultFraction` (the caller's own default, since this module has no opinion on
 *  DocumentCanvas.vue's preferred initial split) when nothing valid is stored yet. */
export function loadEditorSplit(defaultFraction: number): number {
  try {
    const stored = localStorage.getItem(EDITOR_SPLIT_KEY);
    if (stored === null) return defaultFraction;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : defaultFraction;
  } catch {
    return defaultFraction;
  }
}

export function persistEditorSplit(fraction: number): void {
  try {
    localStorage.setItem(EDITOR_SPLIT_KEY, String(fraction));
  } catch {
    // Best-effort persistence only.
  }
}
