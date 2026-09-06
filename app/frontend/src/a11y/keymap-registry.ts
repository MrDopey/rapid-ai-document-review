/**
 * Single source of truth for every keyboard shortcut implemented in the app (FR-043a).
 * `KEYBOARD_SHORTCUTS` below is documentation only — it does not rebind or implement any
 * shortcut. Each entry documents a binding that lives in its own component: CodeMirror's
 * `keymap.of([...])` in EditorComponent.vue, the `@keydown` handler in ConversationView.vue's
 * composer (Enter/Ctrl+Enter/Shift+Enter/Alt+Enter — send/newline behavior, not a "hotkey" in the
 * conflict-checking sense below), and `useFocusTrap`'s Escape/Tab handling in focus-manager.ts.
 * tests/e2e/a11y.spec.ts uses this list to verify FR-043a's "reachable via a keyboard shortcut"
 * requirement without duplicating key combinations. A future help overlay uses the same list.
 *
 * `HOTKEY_BINDINGS` further down is the separate, MACHINE-CHECKABLE registry (added for the
 * hotkey-consolidation refactor): every app-level (non-CodeMirror) `document`-level keydown
 * binding's modifiers+code+scope, as structured data `findConflicts` can scan for duplicate/
 * conflicting combos. It intentionally does NOT include the CodeMirror document-editor bindings
 * or the composer's own Enter/newline handling above — those live in an entirely separate
 * keybinding system (CodeMirror's own `keymap.of([...])`) or aren't modifier-combo hotkeys at all,
 * so there's nothing for a conflict-checker to usefully compare them against; `KEYBOARD_SHORTCUTS`
 * still documents them for humans. The two lists deliberately overlap in content for the bindings
 * that appear in both (kept in sync by hand — a mismatch would only ever affect the human-readable
 * dialog text, never the conflict-detection guarantee, since `findConflicts` only ever reads
 * `HOTKEY_BINDINGS`).
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
    keys: 'Ctrl/Cmd+F',
    description: 'Open the in-editor find/replace panel (via @codemirror/search\'s searchKeymap), instead of the browser\'s native find-in-page.',
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
    keys: 'Ctrl+Alt+R',
    description:
      'Toggle "Show reasoning" for new agent responses. Works from anywhere except the document editor, the ' +
      'composer, or an open dialog.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+Shift+H',
    description:
      'Open or close the History panel. Works from anywhere except the document editor, the composer, or an ' +
      'open dialog. (Moved from the bare Ctrl+Alt+H, which now cycles the focused conversation panel — see ' +
      'below.)',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+H / Ctrl+Alt+ArrowLeft',
    description:
      'Focus the previous conversation among the currently-focused conversation panels, wrapping from the ' +
      'first back to the last. No-op with fewer than two focused conversations. Also fires while typing in a ' +
      'conversation composer (its main use case), but not from the document editor, the conversation-rename ' +
      'field, or while any dialog is open.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+L / Ctrl+Alt+ArrowRight',
    description:
      'Focus the next conversation among the currently-focused conversation panels, wrapping from the last ' +
      'back to the first. No-op with fewer than two focused conversations. Also fires while typing in a ' +
      'conversation composer (its main use case), but not from the document editor, the conversation-rename ' +
      'field, or while any dialog is open.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+Y',
    description:
      'Toggle "Sync scroll" — scrolling either the Editor or Preview pane also scrolls the other to the ' +
      'matching position. Works from anywhere except the document editor, the composer, or an open dialog.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+P',
    description:
      'Show or hide the Preview pane. The Canvas pane expands to use the freed space. No-op if the document ' +
      'editor is already hidden (at least one of Preview/Editor must stay visible). Works from anywhere except ' +
      'the document editor, the composer, or an open dialog.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+E',
    description:
      'Show or hide the document editor within the Canvas pane. The conversation sidebar stays visible and ' +
      'expands to use the freed space. No-op if the Preview pane is already hidden (at least one of ' +
      'Preview/Editor must stay visible). Works from anywhere except the document editor, the composer, or an ' +
      'open dialog.',
    scope: 'Global',
  },
  {
    keys: 'Ctrl+Alt+1..9',
    description:
      'Toggle focus for the Nth conversation (1-9) in the conversation list, top to bottom, in the same order ' +
      'and under the same Active/All filter the HUD list is currently showing. No-op if fewer than N ' +
      'conversations are visible under that filter, if the conversation isn\'t already focused and the ' +
      'simultaneously-focused limit has already been reached (un-focusing an already-focused conversation is ' +
      'always allowed), or while the History panel\'s diff view, the Help/Keyboard-shortcuts dialog, or any ' +
      'other modal dialog is open. Works from anywhere except the document editor, the composer, or an open ' +
      'dialog.',
    scope: 'Global',
  },
] as const;

/**
 * The "does this count as a blocking modal dialog" selector shared by `isEditingContext` and
 * `isOverlayOpen` below. Every dialog in this app marks its root `aria-modal="true"` — except
 * `ConversationDetailPanel.vue`'s own root (`.conversation-detail-dialog`), which is deliberately
 * excluded here even though it also carries `aria-modal="true"` (needed for its own
 * `useFocusTrap`): it's mounted for as long as a conversation stays focused, i.e. for exactly the
 * duration Ctrl+Alt+1..9 is meant to keep toggling that same conversation's focus, and
 * `useFocusTrap` (a11y/focus-manager.ts) moves keyboard focus *into* that panel (e.g. its own
 * "Close full view" button) the instant it becomes the most-recently-interacted one. So the very
 * next Ctrl+Alt+<N> keypress meant to un-focus it has its `event.target` sitting *inside*
 * `.conversation-detail-dialog` — both `isEditingContext`'s `target.closest(...)` check (which
 * looks at the event's own target) and `isOverlayOpen`'s document-wide `querySelector` need this
 * same exclusion, or that keypress reads as "some other dialog is open"/"target is inside a
 * dialog" and silently no-ops instead of un-focusing.
 *
 * (A previous fix here only added the exclusion to `isOverlayOpen`, leaving `isEditingContext`'s
 * own separate `[aria-modal="true"]` check unexcluded — since `onGlobalKeydown` calls
 * `isEditingContext` first, it kept short-circuiting there before `isOverlayOpen` was ever reached,
 * so the bug it was meant to fix — "Ctrl+Alt+N doesn't unfocus an already-focused conversation" —
 * persisted. A component test that dispatches its synthetic `keydown` on `document` itself (rather
 * than on whatever element real focus-trap-driven keyboard focus actually landed on) never caught
 * this: `document` has no `.closest` method, so `isEditingContext`'s
 * `typeof target.closest !== 'function'` guard made it return `false` immediately, without ever
 * reaching the `[aria-modal="true"]` check the real bug lived in.)
 *
 * Any *other* dialog nested inside that panel (e.g. `ConversationView.vue`'s close-confirmation
 * `.close-dialog`, or a busy-switch warning) keeps its own distinct `aria-modal="true"` element and
 * still counts, since this selector only excludes the panel's own root, not its descendants.
 */
const BLOCKING_DIALOG_SELECTOR = '[aria-modal="true"]:not(.conversation-detail-dialog)';

export interface IsEditingContextOptions {
  /**
   * Exempts a conversation composer's own `<textarea>` (id prefix `composer-`) from the blanket
   * "any textarea is an editing context" rule below — added for the cycle-focused-conversations
   * hotkey (Ctrl+Alt+H/L, Ctrl+Alt+ArrowLeft/Right), whose primary trigger point is FROM INSIDE a
   * composer while typing (see `HOTKEY_BINDINGS`' `composerExempt` field further down). Every other
   * check still applies with this option set — a blocking dialog, the document editor's
   * `contenteditable` surface, or a plain `<input>` (the conversation-rename field) all still
   * count as an editing context regardless, since this only ever widens the *composer's own
   * textarea* exception, never any other element. Defaults to `false`, matching every pre-existing
   * caller's behavior unchanged.
   */
  allowComposer?: boolean;
}

/**
 * Shared "is the keyboard event's target an editable/interactive context that a global shortcut
 * listener must not hijack" guard, imported by every global `document`-level `keydown` listener in
 * the app (App.vue's `onGlobalKeydown`, HudPanel.vue's own conversation-list
 * Alt+A/Ctrl+Alt+J/K hotkeys). This module otherwise stays documentation-only (see the doc comment
 * above) — this predicate is the one piece of actual shared runtime logic every such listener
 * needs, not a shortcut-dispatch registry: bail out whenever focus is inside an open dialog (every
 * dialog in this app is marked `aria-modal="true"`, except `.conversation-detail-dialog` — see
 * `BLOCKING_DIALOG_SELECTOR` above), a plain form control (`<input>`/`<textarea>`/`<select>`), or a
 * `contenteditable` surface (CodeMirror's document-editor).
 */
export function isEditingContext(event: KeyboardEvent, options: IsEditingContextOptions = {}): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest(BLOCKING_DIALOG_SELECTOR)) return true;
  if (options.allowComposer && target.tagName === 'TEXTAREA' && target.id.startsWith('composer-')) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.isContentEditable;
}

/**
 * Whether any modal dialog is currently open anywhere in the page, independent of where keyboard
 * focus/the event's own target currently sits. Every dialog in this app marks its root element
 * `aria-modal="true"` (the same attribute `isEditingContext` above already keys off of via
 * `target.closest`, both via the shared `BLOCKING_DIALOG_SELECTOR`) and moves focus into itself the
 * moment it opens (`useFocusTrap`, a11y/focus-manager.ts) — so in steady state this and
 * `isEditingContext` agree. This document-wide version exists for a guard that must hold for the
 * whole app regardless of which element currently has focus, rather than only for events whose own
 * target happens to be inside the dialog: today, App.vue's Ctrl+Alt+1..9 conversation-focus toggle,
 * which must stay a no-op while the History panel's diff view (RevisionDiffViewer.vue), the
 * Help/Keyboard-shortcuts dialogs, or any other dialog (a busy-switch or close-confirmation
 * warning, etc.) is open — added alongside `isEditingContext`, never in place of it.
 */
export function isOverlayOpen(): boolean {
  return document.querySelector(BLOCKING_DIALOG_SELECTOR) !== null;
}

// -------------------------------------------------------------------------------------------
// Machine-checkable hotkey registry (hotkey-consolidation refactor): a single structured list of
// every app-level (non-CodeMirror) `document`-level keydown BINDING DEFINITION — modifiers, the
// `event.code` it fires on, and its scope — so a developer (or `findConflicts` below, wired into
// a regression test) can mechanically detect duplicate/conflicting key combinations, instead of
// them being scattered across three separate `document`-level/element-level listeners in three
// files with no shared registry enforcing uniqueness.
//
// Deliberately data + conflict-checking ONLY, not a dispatch mechanism of its own: each owning
// component (App.vue, HudPanel.vue) still looks up its own bindings from this list (by `id`) and
// keeps its own local handler function for "what happens when it fires" — the actual behavior/
// state stays exactly where it always lived. This keeps `App.vue`'s toolbar-toggle logic in
// App.vue and `HudPanel.vue`'s list-cycling logic in HudPanel.vue, rather than forcing either
// into this module.
// -------------------------------------------------------------------------------------------

export interface HotkeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface HotkeyBinding {
  /** Unique key, e.g. `'toggle-history'` — how the owning component's dispatch table looks this
   *  binding's definition up, and how a conflict is reported. */
  id: string;
  modifiers: HotkeyModifiers;
  /** The `KeyboardEvent.code` value this binding fires on, e.g. `'KeyH'`, `'Digit1'`, `'ArrowLeft'`. */
  code: string;
  /** Reuses `KeyboardShortcut`'s own scope union (see above) so this list and the human-readable
   *  docs table always agree on what a scope name means. */
  scope: KeyboardShortcut['scope'];
  /** Human-readable summary — the source of truth this repo would draw a future generated docs
   *  entry from (today, `KEYBOARD_SHORTCUTS` above is still hand-authored in parallel; see that
   *  array's own doc comment for why). */
  description: string;
  /**
   * When true, this binding is exempted from the blanket "any textarea blocks a global shortcut"
   * rule while its `event.target` is a conversation composer's own `<textarea>` — see
   * `isEditingContext`'s `allowComposer` option above. Every owning listener must pass
   * `{ allowComposer: binding.composerExempt === true }` into `isEditingContext` when checking a
   * binding pulled from this list, rather than re-deriving the exemption itself, so the guard
   * logic stays centralized in one place (`isEditingContext`) instead of being reimplemented per
   * listener.
   */
  composerExempt?: boolean;
}

// Ctrl+Alt+1..9 (`focus-toggle-1`..`focus-toggle-9`): generated from a range rather than
// hand-written, so there's exactly one place that ever has to get "9" right.
const FOCUS_TOGGLE_BINDINGS: readonly HotkeyBinding[] = Array.from({ length: 9 }, (_, i) => {
  const n = i + 1;
  return {
    id: `focus-toggle-${n}`,
    modifiers: { ctrl: true, alt: true, shift: false },
    code: `Digit${n}`,
    scope: 'Global',
    description: `Toggle focus for conversation position ${n} (1-based, top to bottom) in the conversation list.`,
    composerExempt: false,
  } satisfies HotkeyBinding;
});

/**
 * Every app-level (non-CodeMirror) keyboard binding currently dispatched somewhere in the app.
 * `findConflicts` (below) is run over exactly this list by
 * `tests/unit/keymap-registry.spec.ts` as a regression guard — any future addition that collides
 * with an existing combo fails that test instead of silently shadowing (or being shadowed by) an
 * existing shortcut.
 *
 * Owned by App.vue's `onGlobalKeydown` (`scope: 'Global'`):
 *   toggle-reasoning, toggle-history, toggle-sync-scroll, toggle-preview, toggle-editor,
 *   focus-toggle-1..9, cycle-conversation-prev(-arrow), cycle-conversation-next(-arrow).
 * Owned by HudPanel.vue's own `onGlobalKeydown` (`scope: 'Conversation list'`):
 *   toggle-filter, cycle-next, cycle-prev.
 */
export const HOTKEY_BINDINGS: readonly HotkeyBinding[] = [
  {
    id: 'toggle-reasoning',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyR',
    scope: 'Global',
    description: 'Toggle "Show reasoning" for new agent responses.',
  },
  {
    id: 'toggle-history',
    modifiers: { ctrl: true, alt: true, shift: true },
    code: 'KeyH',
    scope: 'Global',
    description: 'Open or close the History panel.',
  },
  {
    id: 'toggle-sync-scroll',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyY',
    scope: 'Global',
    description: 'Toggle "Sync scroll" between the Editor and Preview panes.',
  },
  {
    id: 'toggle-preview',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyP',
    scope: 'Global',
    description: 'Show or hide the Preview pane.',
  },
  {
    id: 'toggle-editor',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyE',
    scope: 'Global',
    description: 'Show or hide the document editor within the Canvas pane.',
  },
  ...FOCUS_TOGGLE_BINDINGS,
  // Cycle-focused-conversations (new): moves which already-focused conversation panel is "active"
  // (App.vue's `lastInteractedId`), wrapping at both ends — never adds/removes a focused panel.
  // `composerExempt: true` on all four: this shortcut's primary trigger point is FROM INSIDE a
  // composer textarea while typing (see `isEditingContext`'s `allowComposer` option above).
  {
    id: 'cycle-conversation-prev',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyH',
    scope: 'Global',
    composerExempt: true,
    description: 'Focus the previous currently-focused conversation panel (wraps).',
  },
  {
    id: 'cycle-conversation-prev-arrow',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'ArrowLeft',
    scope: 'Global',
    composerExempt: true,
    description: 'Focus the previous currently-focused conversation panel (wraps).',
  },
  {
    id: 'cycle-conversation-next',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyL',
    scope: 'Global',
    composerExempt: true,
    description: 'Focus the next currently-focused conversation panel (wraps).',
  },
  {
    id: 'cycle-conversation-next-arrow',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'ArrowRight',
    scope: 'Global',
    composerExempt: true,
    description: 'Focus the next currently-focused conversation panel (wraps).',
  },
  {
    id: 'toggle-filter',
    modifiers: { ctrl: false, alt: true, shift: false },
    code: 'KeyA',
    scope: 'Conversation list',
    description: 'Toggle the conversation list between "Active only" and "All".',
  },
  {
    id: 'cycle-next',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyJ',
    scope: 'Conversation list',
    description: 'Select the next conversation in the conversation list (wraps).',
  },
  {
    id: 'cycle-prev',
    modifiers: { ctrl: true, alt: true, shift: false },
    code: 'KeyK',
    scope: 'Conversation list',
    description: 'Select the previous conversation in the conversation list (wraps).',
  },
];

/** Whether `event`'s own modifiers+code match `binding`'s definition exactly (including a
 *  modifier the binding does NOT require — e.g. a stray Shift press never accidentally matches a
 *  non-Shift binding). The one modifier this deliberately never checks is Meta/Cmd — every caller
 *  in this app bails out on `event.metaKey` itself, up front, before ever reaching this. */
export function matchesBinding(event: KeyboardEvent, binding: HotkeyBinding): boolean {
  return (
    event.ctrlKey === binding.modifiers.ctrl &&
    event.altKey === binding.modifiers.alt &&
    event.shiftKey === binding.modifiers.shift &&
    event.code === binding.code
  );
}

export interface HotkeyConflict {
  a: HotkeyBinding;
  b: HotkeyBinding;
}

/**
 * Whether two bindings' own scopes could ever both be reachable for the very same keypress —
 * i.e. whether an identical modifiers+code combo between them is a REAL conflict, not just two
 * unrelated bindings that happen to share a scope name.
 *
 * The judgment call this app makes: `'Document editor'` is CodeMirror's own, entirely separate
 * keymap system (`keymap.of([...])`, EditorComponent.vue) — its own dispatch never reaches (and
 * is never reached by) any of this module's `document`-level listeners, so it only ever conflicts
 * with itself. Every other scope this list actually uses (`'Global'`, `'Conversation list'`) is
 * dispatched by a plain `document`-level `keydown` listener gated by the same `isEditingContext`/
 * `isOverlayOpen` guards (App.vue's `onGlobalKeydown` and HudPanel.vue's own both fire for the
 * exact same keypresses, just filtering to their own scope) — so two bindings in either of those
 * scopes, or one in each, are always simultaneously reachable and must never collide. This also
 * covers the composer-exempt bindings above (`composerExempt: true`): a composer keydown still
 * bubbles to the very same `document`-level listeners as everything else (see `App.vue`'s
 * `onGlobalKeydown`), so a composer-reachable combo is checked against every other scope here too,
 * not carved out into its own conflict-free bucket.
 */
function reachableTogether(a: KeyboardShortcut['scope'], b: KeyboardShortcut['scope']): boolean {
  if (a === 'Document editor' || b === 'Document editor') return a === b;
  return true;
}

/** Scans `bindings` for any two distinct entries sharing an identical `{ctrl, alt, shift, code}`
 *  combo within scopes that could actually both be reached by the same keypress (see
 *  `reachableTogether` above) — `tests/unit/keymap-registry.spec.ts` runs this over the live
 *  `HOTKEY_BINDINGS` list as a zero-conflicts regression guard. */
export function findConflicts(bindings: readonly HotkeyBinding[]): HotkeyConflict[] {
  const conflicts: HotkeyConflict[] = [];
  for (let i = 0; i < bindings.length; i += 1) {
    for (let j = i + 1; j < bindings.length; j += 1) {
      const a = bindings[i]!;
      const b = bindings[j]!;
      if (!reachableTogether(a.scope, b.scope)) continue;
      if (
        a.modifiers.ctrl === b.modifiers.ctrl &&
        a.modifiers.alt === b.modifiers.alt &&
        a.modifiers.shift === b.modifiers.shift &&
        a.code === b.code
      ) {
        conflicts.push({ a, b });
      }
    }
  }
  return conflicts;
}
