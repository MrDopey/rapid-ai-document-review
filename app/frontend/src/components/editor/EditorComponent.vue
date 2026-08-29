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
  (e: 'branch-from-selection', range: { from: number; to: number }): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
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

/** FR-011/FR-043a: branching from a selection is reachable both by this focus-reachable toolbar
 * button and by a keyboard shortcut bound directly in the editor's own keymap below — neither
 * requires a pointer-triggered context menu, and CodeMirror's own Shift+Arrow/Shift+Ctrl+Arrow
 * selection extension already makes the selection itself fully keyboard-operable. */
function requestBranch(): boolean {
  if (!selection.value) return false;
  emit('branch-from-selection', selection.value);
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
      { key: 'Alt-Shift-c', run: () => requestBranch() },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown(),
    EditorView.lineWrapping,
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
});
</script>

<template>
  <div class="editor-pane">
    <div class="editor-toolbar">
      <span class="pane-eyebrow">Editor</span>
      <button
        type="button"
        class="branch-button"
        :disabled="!selection"
        title="Highlight text in the editor, then click here to start a focused conversation about just that passage. Keyboard shortcut: Alt+Shift+C"
        @click="requestBranch"
      >
        Start conversation from selection
      </button>
    </div>
    <div ref="hostRef" class="editor-host"></div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
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
.branch-button {
  font-size: 0.8rem;
}
.editor-host {
  flex: 1;
  min-height: 0;
  text-align: left;
}

/* Without this, CodeMirror's internal .cm-editor sizes to its content, leaving the empty
   remainder of the pane unclickable — clicking there does nothing instead of placing the
   cursor at the nearest position, as most text editors do. */
.editor-host :deep(.cm-editor) {
  height: 100%;
}

.editor-host :deep(.cm-scroller) {
  overflow: auto;
}
</style>
