/**
 * Single source of truth for every keyboard shortcut already implemented in the app (FR-043a).
 * Nothing here rebinds or re-implements a shortcut — each entry documents a binding that already
 * lives in its own component (CodeMirror's `keymap.of([...])` in EditorComponent.vue, the
 * `@keydown` handler in ConversationView.vue's composer, `useFocusTrap`'s Escape/Tab handling in
 * focus-manager.ts). Consumed by tests/e2e/a11y.spec.ts to verify FR-043a's "reachable via a
 * keyboard shortcut" requirement without hard-coding the key combination twice, and available for
 * a future help overlay without needing to re-derive this list from the components themselves.
 */

export interface KeyboardShortcut {
  /** Human-readable key combination, matching how it's described in the owning component. */
  keys: string;
  description: string;
  /** Where the shortcut is active. */
  scope: 'Document editor' | 'Conversation composer' | 'Dialogs';
}

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    keys: 'Shift+Arrow / Shift+Ctrl+Arrow',
    description: 'Extend the text selection in the document editor (native CodeMirror behaviour).',
    scope: 'Document editor',
  },
  {
    keys: 'Alt+Shift+C',
    description:
      'Start a conversation branch from the current editor selection (FR-011/FR-043a) — same action as the ' +
      'focus-reachable "Start conversation from selection" toolbar button.',
    scope: 'Document editor',
  },
  {
    keys: 'Ctrl/Cmd+Z',
    description: 'Undo the last editor change.',
    scope: 'Document editor',
  },
  {
    keys: 'Ctrl+Y (Windows/Linux) / Cmd+Shift+Z (macOS)',
    description: 'Redo the last undone editor change.',
    scope: 'Document editor',
  },
  {
    keys: 'Enter',
    description: 'Send the composer message.',
    scope: 'Conversation composer',
  },
  {
    keys: 'Ctrl/Cmd+Enter',
    description: 'Refresh this conversation’s context to the latest document revision, then send (FR-018).',
    scope: 'Conversation composer',
  },
  {
    keys: 'Shift+Enter / Alt+Enter',
    description: 'Insert a newline in the composer without sending.',
    scope: 'Conversation composer',
  },
  {
    keys: 'Tab / Shift+Tab',
    description: 'Move focus among the controls of an open dialog — focus is trapped inside it while it is open.',
    scope: 'Dialogs',
  },
  {
    keys: 'Escape',
    description:
      'Cancel/close the open dialog (confirm-close, busy-switch warning, or diff preview) and return focus to ' +
      'the control that opened it (FR-043d).',
    scope: 'Dialogs',
  },
] as const;
