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
