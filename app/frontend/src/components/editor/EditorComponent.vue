<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { ChangeSet, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
  undo,
  redo,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { search, searchKeymap } from '@codemirror/search';
import { focusCapBranchTooltip } from '../../composables/focusConfig.js';
import { ChangeBatcher } from './ChangeBatcher';

// 005-canvas-conversation-threads (branch-cap parity): `focusedConversationIds`/
// `maxFocusedConversations` are App.vue's own multi-focus state, threaded straight through
// DocumentCanvas.vue (which already receives them as its own props from App.vue, for
// ConversationThreadBox.vue's identical cap check) — same raw-props-down convention, just one level
// further. Defaults (an empty set, cap 3) match ConversationThreadBox.vue's own `maxFocused` default
// so a bare `mount(EditorComponent, { props: { modelValue } })` (existing tests) behaves as "never at
// cap".
const props = withDefaults(
  defineProps<{
    modelValue: string;
    focusedConversationIds?: ReadonlySet<string>;
    maxFocusedConversations?: number;
  }>(),
  { focusedConversationIds: () => new Set(), maxFocusedConversations: 3 },
);
const emit = defineEmits<{
  (e: 'change', changes: { from: number; to: number; insert: string }[]): void;
  (e: 'selection', range: { from: number; to: number } | null): void;
  (
    e: 'branch-from-selection',
    range: { from: number; to: number },
    includeSeedMessage: boolean,
  ): void;
}>();

const selection = ref<{ from: number; to: number } | null>(null);

/** No free slot left to auto-focus a newly created branch into — see `requestBranch`'s doc comment
 *  for why this blocks branch creation itself, not just auto-focus. */
const atFocusCap = computed(
  () => props.focusedConversationIds.size >= props.maxFocusedConversations,
);
const branchDisabled = computed(() => !selection.value || atFocusCap.value);

/** Priority when both a disabled-reason could apply: no-selection wins over at-cap, since without a
 *  selection these buttons are meaningless regardless of the focus cap. Each button keeps its own
 *  existing "highlight text…" copy for every other case — only the genuinely new "at cap" reason
 *  gets the shared cap tooltip. */
const branchNewTitle = computed(() =>
  selection.value && atFocusCap.value
    ? focusCapBranchTooltip(props.maxFocusedConversations)
    : 'Highlight text in the editor, then click here to start a focused conversation about just that passage, with an empty transcript. Keyboard shortcut: Alt+Shift+C',
);
const branchMainTitle = computed(() =>
  selection.value && atFocusCap.value
    ? focusCapBranchTooltip(props.maxFocusedConversations)
    : 'Highlight text in the editor, then click here to start a focused conversation about just that passage, seeded with the document and your selection as its first message. Keyboard shortcut: Alt+Shift+S',
);

const hostRef = ref<HTMLDivElement | null>(null);
// 005-canvas-conversation-threads: the root of this whole component (toolbar + host), not
// `hostRef` alone — `anchorTop` below needs an origin that starts flush with `DocumentCanvas.vue`'s
// `.canvas-content` (this component's parent there), which `.editor-pane` is (the first flex
// child, no margin) but `.editor-host` is not (it sits below `.editor-toolbar` inside
// `.editor-pane`). Using `.editor-host` alone would silently drop the toolbar's height from every
// anchor position, misaligning every conversation box by that amount.
const paneRef = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let applyingRemote = false;

const CLIENT_BATCH_DEBOUNCE_MS = 250;
// Pure debounce alone lets a sustained typing/paste burst (each edit arriving under
// CLIENT_BATCH_DEBOUNCE_MS after the last) push the flush out indefinitely, so the batch — and the
// cost of composing each new change onto it in ChangeBatcher's `compose` below — keeps growing for
// as long as the burst lasts. This caps that: a flush is forced at least this often regardless,
// bounding both the outbound payload size and the compose chain length, while still collapsing any
// burst shorter than this into one flush.
const CLIENT_BATCH_MAX_WAIT_MS = 1000;

// ChangeBatcher (./ChangeBatcher.ts) owns the accumulation buffer and debounce/max-wait timers as
// plain, CodeMirror/Vue-free logic; this composes/flattens one ChangeSet-shaped batch into the
// flat {from,to,insert}[] the backend expects — composed (not concatenated), since each CodeMirror
// update's offsets are relative to the document state left by the previous update in the batch,
// not to the original pre-batch text. Composing keeps the net result expressed relative to that
// one original base, which is what a flat batch must be for the backend to apply it correctly.
const changeBatcher = new ChangeBatcher<ChangeSet>(
  (batch) => {
    const changes: { from: number; to: number; insert: string }[] = [];
    batch.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    if (changes.length > 0) emit('change', changes);
  },
  {
    debounceMs: CLIENT_BATCH_DEBOUNCE_MS,
    maxWaitMs: CLIENT_BATCH_MAX_WAIT_MS,
    compose: (accumulated, change) => (accumulated ? accumulated.compose(change) : change),
  },
);

/** FR-011/FR-043a: branching from a selection is reachable both by these two focus-reachable
 * toolbar buttons and by a keyboard shortcut each bound directly in the editor's own keymap below
 * — neither requires a pointer-triggered context menu, and CodeMirror's own
 * Shift+Arrow/Shift+Ctrl+Arrow selection extension already makes the selection itself fully
 * keyboard-operable.
 *
 * `includeSeedMessage` (005-canvas-conversation-threads) distinguishes the two: `false` (the
 * "Branch (New)"/Alt+Shift+C path) keeps the empty-placeholder-conversation default; `true` (the
 * "Branch (Main)"/Alt+Shift+S path) asks the backend to also deliver the selection excerpt as
 * the branch's first message (`ConversationService.branch`'s `buildBranchSeedMessage` call).
 *
 * `branchDisabled` also gates the keyboard shortcuts here, not just the toolbar buttons' own
 * `:disabled` binding below — a native `disabled` attribute only blocks pointer/Enter activation of
 * the button element itself, not this keymap binding, which fires regardless of any button's state. */
function requestBranch(includeSeedMessage: boolean): boolean {
  if (branchDisabled.value) return false;
  emit('branch-from-selection', selection.value!, includeSeedMessage);
  return true;
}

onMounted(() => {
  const extensions: Extension[] = [
    history(),
    // Enter must not auto-indent: this is a plain-text Markdown document, and the language's
    // auto-indent stacks on top of whatever leading whitespace the user types themselves,
    // compounding indentation line over line (e.g. in nested lists or fenced code content).
    keymap.of([
      { key: 'Enter', run: insertNewline, shift: insertNewline },
      // A plain `key` binding (not `mac`-qualified `Mod-`) so this is the same physical shortcut
      // on every platform and deliberately avoids reserved browser chrome combos like
      // Ctrl/Cmd+Shift+B (bookmarks bar).
      { key: 'Alt-Shift-c', run: () => requestBranch(false) },
      // Same physical-key rationale as Alt-Shift-c above; "s" for "seed" mirrors the second
      // toolbar button's "Branch (Main)" label (keymap-registry.ts).
      { key: 'Alt-Shift-s', run: () => requestBranch(true) },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
    // @codemirror/search's `search()` extension supplies both the in-editor find/replace panel UI
    // and the state the searchKeymap's Mod-f/Mod-g/Shift-Mod-g/Escape bindings above operate on.
    // CodeMirror's keymap handling only fires when the editor itself has focus and the keydown
    // event reaches it, so Mod-f (Ctrl+F/Cmd+F) opens this panel exactly when focus is inside the
    // editor — no separate "is the editor focused" check needed — and is left completely alone
    // (falls through to the browser's native find) everywhere else in the app, since nothing else
    // in this codebase installs a global keydown listener that intercepts a bare Ctrl+F/Cmd+F
    // (App.vue's and HudPanel.vue's own global handlers only act on Ctrl+Alt+* combinations).
    search(),
    markdown(),
    EditorView.lineWrapping,
    // CodeMirror's own base theme hardcodes `.cm-content`'s caret-color to plain black (it has no
    // notion of this app's `prefers-color-scheme`-driven dark palette in style.css). In dark mode
    // the pane's background/text flip to the dark tokens below, but without this override the
    // caret stayed black-on-near-black — rendered, but invisible. Tying it to the same
    // `--text-color` token already used for the pane's own text keeps the caret exactly as visible
    // as the text around it in both schemes.
    EditorView.theme({
      '.cm-content': { caretColor: 'var(--text-color, #111)' },
      // research.md §2/FR-015: CodeMirror's own baseTheme unconditionally sets `.cm-scroller {
      // overflow: auto}` — that's a real, separately-injected stylesheet, so a plain scoped Vue
      // `<style>` rule targeting the same selector does not reliably win against it (confirmed by
      // an e2e assertion actually failing here: removing our own now-redundant copy of that rule
      // had no visible effect, because CodeMirror's own default was the one actually in force).
      // Overriding it through `EditorView.theme()` — the same mechanism CodeMirror itself uses —
      // is what actually defeats it, letting the document lay out at full content height with the
      // canvas's own native scroll (DocumentCanvas.vue) as the only way to move through it.
      '.cm-scroller': { overflow: 'visible' },
    }),
    // The actual focusable/editable node CodeMirror creates is `.cm-content`, a descendant of
    // `hostRef` — labelling `hostRef` itself (a plain, non-interactive wrapper div) would leave
    // the element assistive technology actually focuses without its own accessible name. Setting
    // these via `contentAttributes` puts role/aria-label/aria-multiline directly on that node.
    EditorView.contentAttributes.of({
      role: 'textbox',
      'aria-label': 'Document editor',
      'aria-multiline': 'true',
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;

      if (update.docChanged && !applyingRemote) {
        changeBatcher.add(update.changes);
      }

      if (update.selectionSet) {
        const range = update.state.selection.main;
        const next = range.empty ? null : { from: range.from, to: range.to };
        selection.value = next;
        emit('selection', next);
      }
    }),
  ];

  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions }),
    parent: hostRef.value!,
  });
});

onBeforeUnmount(() => {
  changeBatcher.dispose();
  view?.destroy();
});

// External content changes (initial load, restore, remote sync) replace the doc without
// re-triggering an outbound PATCH.
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === next) return;
    applyingRemote = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
    applyingRemote = false;
  },
);

defineExpose({
  undo: () => view && undo(view),
  redo: () => view && redo(view),
  /** 005-canvas-conversation-threads: pixel Y of document offset `pos`, relative to this
   *  component's own host element's top edge (not the viewport) — `coordsAtPos` itself returns
   *  viewport-relative coordinates, which shift as the canvas scrolls, so both rects are read at
   *  the same instant and subtracted to get a value that stays valid regardless of scroll
   *  position. Used by `DocumentCanvas.vue`/`anchorY.ts` to colocate conversation boxes with
   *  their highlighted anchor. */
  anchorTop: (pos: number): number | null => {
    if (!view || !paneRef.value) return null;
    const coords = view.coordsAtPos(pos);
    if (!coords) return null;
    return coords.top - paneRef.value.getBoundingClientRect().top;
  },
});
</script>

<template>
  <div ref="paneRef" class="editor-pane">
    <div class="editor-toolbar">
      <span class="pane-eyebrow">Editor</span>
      <div class="branch-buttons">
        <button
          type="button"
          class="branch-button"
          :disabled="branchDisabled"
          :title="branchNewTitle"
          @click="requestBranch(false)"
        >
          Branch (New)
        </button>
        <button
          type="button"
          class="branch-button"
          :disabled="branchDisabled"
          :title="branchMainTitle"
          @click="requestBranch(true)"
        >
          Branch (Main)
        </button>
      </div>
    </div>
    <div ref="hostRef" class="editor-host" />
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  /* No forced height: this pane now lives inside DocumentCanvas.vue's natively-scrolling canvas
     (research.md §1/§2) and must size to its own full content height — a floating page, not a
     viewport-bounded box with its own internal scrollbar. */
  border-right: 1px solid var(--border-color, #ccc);
  /* Without an explicit flex-basis, this pane defaults to flex: 0 1 auto — shrink-to-fit sized by
     its content's intrinsic (max-content) width. CodeMirror 6 virtualizes line rendering around
     the visible viewport of `.document-canvas` (mounting/unmounting line DOM as the user scrolls),
     so different lines scrolling into view have different intrinsic widths, which would
     recalculate this pane's shrink-to-fit width and push `.thread-columns` sideways every scroll
     tick. `flex: 1 1 0` + `min-width: 0` makes this pane's width a pure function of the flex split
     with `.thread-columns` in `.canvas-content` (DocumentCanvas.vue), independent of whichever
     lines CodeMirror currently has mounted — same pattern as App.vue's `min-width: 0` handling for
     its own shrink-to-fit-vs-flex layout. Width only; the floating-page height behavior above is
     untouched. */
  flex: 1 1 0;
  min-width: 0;
}
.editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border-bottom: 2px solid var(--border-color, #ddd);
  /* Gives the Editor pane the same distinct-surface + visible-label treatment as the
     other regions (HUD, transcript, Preview). */
  background: var(--panel-bg, #f7f7f8);
  /* .editor-pane deliberately has no forced height (comment above) and lives entirely in-flow
     inside DocumentCanvas.vue's .document-canvas, the actual scrolling ancestor — so without
     position: sticky below, scrolling a long document scrolls this toolbar away with it.
     position: sticky pins it to the top of that scrollport instead; the opaque background above
     already prevents content from showing through underneath. --z-sticky only needs to beat this
     same stacking context's own unstyled (z-index: auto) content scrolling beneath it — it's far
     below every app-level overlay's z-index (style.css's --z-overlay/--z-overlay-detail/
     --z-overlay-primary/--z-indicator scale, used by App.vue's .shortcuts-overlay/.help-overlay/
     .conversation-detail-overlay, HistoryPanel.vue's .diff-overlay, EditsList.vue's
     .preview-overlay, PrimaryPanel.vue's/ConversationView.vue's confirmation dialogs, and
     ReconnectingIndicator.vue), so it can never sit on top of any of those. */
  position: sticky;
  top: 0;
  z-index: var(--z-sticky, 2);
}
/* .pane-eyebrow's shared text styling now lives in style.css. */
.branch-buttons {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.branch-button {
  font-size: 0.8rem;
}
.editor-host {
  text-align: left;
}

/* research.md §2: no inner `.cm-scroller` overflow — the document lays out at full content
   height (a floating page) inside the canvas's own native scroll (DocumentCanvas.vue), avoiding
   wheel-event scroll-chaining between a second, competing scroll container and the outer canvas
   (FR-015). */
</style>
