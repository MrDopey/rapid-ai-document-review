/**
 * Single source of truth for every keyboard shortcut implemented in the app (FR-043a).
 * This registry is documentation only — it does not rebind or implement any shortcut. Each entry
 * documents a binding that lives in its own component: CodeMirror's `keymap.of([...])` in
 * EditorComponent.vue, the `@keydown` handler in ConversationView.vue's composer, and
 * `useFocusTrap`'s Escape/Tab handling in focus-manager.ts.
 * tests/e2e/a11y.spec.ts uses this list to verify FR-043a's "reachable via a keyboard shortcut"
 * requirement without duplicating key combinations. A future help overlay uses the same list.
 */

export interface KeyboardShortcut {
  /** Human-readable key combination, matching how it's described in the owning component. */
  keys: string;
  description: string;
  /** Where the shortcut is active. */
  scope: 'Document editor' | 'Conversation composer' | 'Dialogs' | 'Conversation list' | 'Global';
}

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    keys: 'Shift+Arrow / Shift+Ctrl+Arrow',
    description: 'Extend the text selection in the document editor.',
    scope: 'Document editor',
  },
  {
    keys: 'Alt+Shift+C',
    description: '"Branch (New)": start a conversation branch from the current editor selection, with an empty transcript.',
    scope: 'Document editor',
  },
  {
    keys: 'Alt+Shift+S',
    description:
      '"Branch (Main)": start a conversation branch from the current editor selection, seeded with the ' +
      'document and the selection as its first message.',
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
    description: 'Refresh the conversation’s context to the latest document revision, then send.',
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
      'Cancel the open dialog (confirm-close, busy-switch warning, or diff preview) and return focus to the ' +
      'control that opened it.',
    scope: 'Dialogs',
  },
  {
    keys: 'Alt+A',
    description:
      'Toggle the conversation list between "Active only" (hides closed conversations) and "All". Works from ' +
      'anywhere except the document editor, the composer, or an open dialog.',
    scope: 'Conversation list',
  },
  {
    keys: 'Ctrl+Alt+J',
    description:
      'Select the next conversation in the conversation list, within the current filter (active-only or all). ' +
      'Wraps to the first conversation from the last.',
    scope: 'Conversation list',
  },
  {
    keys: 'Ctrl+Alt+K',
    description:
      'Select the previous conversation in the conversation list, within the current filter (active-only or ' +
      'all). Wraps to the last conversation from the first.',
    scope: 'Conversation list',
  },
  {
    keys: 'Ctrl+Alt+P',
    description:
      'Dismiss the Primary conversation notice, matching the "Dismiss" button — a one-shot action, not a ' +
      'toggle. Works from anywhere except the document editor, the composer, or an open dialog.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+R',
    description:
      'Toggle "Show reasoning" for new agent responses. Works from anywhere except the document editor, the ' +
      'composer, or an open dialog.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+H',
    description:
      'Open or close the History panel. Works from anywhere except the document editor, the composer, or an ' +
      'open dialog.',
    scope: 'Global',
  },
] as const;
