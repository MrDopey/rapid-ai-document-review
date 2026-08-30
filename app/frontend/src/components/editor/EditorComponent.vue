<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { ChangeSet, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline, undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{
  (e: 'change', changes: { from: number; to: number; insert: string }[]): void;
  (e: 'selection', range: { from: number; to: number } | null): void;
  (e: 'branch-from-selection', range: { from: number; to: number }, includeSeedMessage: boolean): void;
}>();

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

const selection = ref<{ from: number; to: number } | null>(null);

const CLIENT_BATCH_DEBOUNCE_MS = 250;
// Composed (not concatenated): each CodeMirror update's offsets are relative to the document
// state left by the previous update in the batch, not to the original pre-batch text. Composing
// keeps the net result expressed relative to that one original base, which is what a flat
// {from,to,insert}[] batch must be for the backend to apply it correctly.
let accumulated: ChangeSet | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (!accumulated) return;
  const changes: { from: number; to: number; insert: string }[] = [];
  accumulated.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  accumulated = null;
  if (changes.length > 0) emit('change', changes);
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, CLIENT_BATCH_DEBOUNCE_MS);
}

/** FR-011/FR-043a: branching from a selection is reachable both by these two focus-reachable
 * toolbar buttons and by a keyboard shortcut each bound directly in the editor's own keymap below
 * — neither requires a pointer-triggered context menu, and CodeMirror's own
 * Shift+Arrow/Shift+Ctrl+Arrow selection extension already makes the selection itself fully
 * keyboard-operable.
 *
 * `includeSeedMessage` (005-canvas-conversation-threads) distinguishes the two: `false` (the
 * "Branch (New)"/Alt+Shift+C path) keeps the empty-placeholder-conversation default; `true` (the
 * "Branch (Main)"/Alt+Shift+S path) asks the backend to also deliver the selection excerpt as
 * the branch's first message (`ConversationService.branch`'s `buildBranchSeedMessage` call). */
function requestBranch(includeSeedMessage: boolean): boolean {
  if (!selection.value) return false;
  emit('branch-from-selection', selection.value, includeSeedMessage);
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
    ]),
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
    EditorView.contentAttributes.of({ role: 'textbox', 'aria-label': 'Document editor', 'aria-multiline': 'true' }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;

      if (update.docChanged && !applyingRemote) {
        accumulated = accumulated ? accumulated.compose(update.changes) : update.changes;
        scheduleFlush();
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
  if (flushTimer) clearTimeout(flushTimer);
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
          :disabled="!selection"
          title="Highlight text in the editor, then click here to start a focused conversation about just that passage, with an empty transcript. Keyboard shortcut: Alt+Shift+C"
          @click="requestBranch(false)"
        >
          Branch (New)
        </button>
        <button
          type="button"
          class="branch-button"
          :disabled="!selection"
          title="Highlight text in the editor, then click here to start a focused conversation about just that passage, seeded with the document and your selection as its first message. Keyboard shortcut: Alt+Shift+S"
          @click="requestBranch(true)"
        >
          Branch (Main)
        </button>
      </div>
    </div>
    <div ref="hostRef" class="editor-host"></div>
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
}
.editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border-bottom: 2px solid var(--border-color, #ddd);
  /* Fix 2/6: gives the Editor pane the same distinct-surface + visible-label treatment as the
     other regions (HUD, transcript, Preview). */
  background: var(--panel-bg, #f7f7f8);
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
