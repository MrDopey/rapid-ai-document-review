import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadEditorVisible,
  loadPreviewVisible,
  persistEditorVisible,
  persistPreviewVisible,
  loadEditorSplit,
  persistEditorSplit,
} from '../../src/composables/panePersistence.js';

// Preview/Editor visibility toggles (App.vue's `.actions-group`, Ctrl+Alt+P/Ctrl+Alt+E): persisted
// per-viewer via their own localStorage keys, same "defaults to on, best-effort, non-throwing"
// convention `loadSyncScrollEnabled`/`persistSyncScrollEnabled` already use — these loader/setter
// pairs are unit-tested directly here (rather than only indirectly through App.vue) the same way
// `focusConfig.spec.ts` tests its composable's pure logic directly.
//
// Bug-fix rename (editor-vs-canvas scope fix): `loadCanvasVisible`/`persistCanvasVisible` used to
// gate the whole `DocumentCanvas` pane (editor *and* conversation sidebar); the gate is now scoped
// to just the editor (a `DocumentCanvas` prop, not a pane-level `v-show`), so the flag/key were
// renamed to `editorVisible`/`raidr:editorVisible` to match.

describe('panePersistence — Preview/Editor visibility', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults both to visible when nothing is stored', () => {
    expect(loadPreviewVisible()).toBe(true);
    expect(loadEditorVisible()).toBe(true);
  });

  it('round-trips an explicit "hidden" preference for the Preview pane', () => {
    persistPreviewVisible(false);
    expect(loadPreviewVisible()).toBe(false);
    // The editor flag is independent — persisting Preview must not touch it.
    expect(loadEditorVisible()).toBe(true);
  });

  it('round-trips an explicit "hidden" preference for the editor', () => {
    persistEditorVisible(false);
    expect(loadEditorVisible()).toBe(false);
    expect(loadPreviewVisible()).toBe(true);
  });

  it('round-trips back to visible after an explicit "hidden" preference', () => {
    persistPreviewVisible(false);
    expect(loadPreviewVisible()).toBe(false);
    persistPreviewVisible(true);
    expect(loadPreviewVisible()).toBe(true);
  });

  it('persists the two flags under independent keys, not sharing state with `syncScrollEnabled`/pane sizes', () => {
    persistPreviewVisible(false);
    persistEditorVisible(false);
    expect(localStorage.getItem('raidr:previewVisible')).toBe('false');
    expect(localStorage.getItem('raidr:editorVisible')).toBe('false');
  });
});

// DocumentCanvas.vue's own Editor|Conversation-sidebar split — a second, independent splitter one
// level down from the Preview|Canvas split above (`loadPaneSizes`/`persistPaneSizes`'s
// `previewFr`/`canvasFr`). Same per-viewer, best-effort, non-throwing convention as the rest of
// this file, tested directly here the same way every other loader/setter pair above is.
describe('panePersistence — DocumentCanvas.vue Editor|Conversation-sidebar split', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('falls back to the caller-supplied default when nothing is stored', () => {
    expect(loadEditorSplit(0.6)).toBe(0.6);
    expect(loadEditorSplit(0.45)).toBe(0.45);
  });

  it('round-trips a persisted fraction', () => {
    persistEditorSplit(0.42);
    expect(loadEditorSplit(0.6)).toBeCloseTo(0.42);
  });

  it('falls back to the default when the stored value is corrupt/non-numeric', () => {
    localStorage.setItem('raidr:editorSplit', 'not-a-number');
    expect(loadEditorSplit(0.6)).toBe(0.6);
  });

  it('persists under its own independent key, not sharing state with Preview/Editor visibility or Preview|Canvas pane sizes', () => {
    persistEditorSplit(0.35);
    expect(localStorage.getItem('raidr:editorSplit')).toBe('0.35');
    expect(localStorage.getItem('raidr:paneSizes')).toBeNull();
    expect(localStorage.getItem('raidr:previewVisible')).toBeNull();
  });
});
