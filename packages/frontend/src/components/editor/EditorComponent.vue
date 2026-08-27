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
}>();

const hostRef = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let applyingRemote = false;

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

onMounted(() => {
  const extensions: Extension[] = [
    history(),
    // Enter must not auto-indent: this is a plain-text Markdown document, and the language's
    // auto-indent stacks on top of whatever leading whitespace the user types themselves,
    // compounding indentation line over line (e.g. in nested lists or fenced code content).
    keymap.of([
      { key: 'Enter', run: insertNewline, shift: insertNewline },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;

      if (update.docChanged && !applyingRemote) {
        accumulated = accumulated ? accumulated.compose(update.changes) : update.changes;
        scheduleFlush();
      }

      if (update.selectionSet) {
        const range = update.state.selection.main;
        emit('selection', range.empty ? null : { from: range.from, to: range.to });
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
  <div ref="hostRef" class="editor-host" role="textbox" aria-label="Document editor" aria-multiline="true"></div>
</template>

<style scoped>
.editor-host {
  height: 100%;
  text-align: left;
  border-right: 1px solid var(--border-color, #ccc);
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
