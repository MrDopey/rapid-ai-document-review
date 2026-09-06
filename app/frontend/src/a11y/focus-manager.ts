import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue';

/**
 * FR-043d: opening a diff preview or any blocking dialog (confirm-close, US7; busy-switch
 * warning, US5) MUST move focus to its first interactive element; dismissing it (accept, drop,
 * cancel, or Escape) MUST return focus to the control that opened it.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el === document.activeElement;
}

function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

export interface FocusTrapOptions {
  /** Called when Escape is pressed while the trap is active — wire to the same handler as the
   *  dialog's own Cancel/Close control (never call it directly; let the option decide). */
  onEscape?: () => void;
  /**
   * Optional getter for the element focus should move to the moment the trap activates, tried
   * BEFORE falling back to the container's first focusable element. Added for
   * `ConversationDetailPanel.vue`: it returns that panel's own composer textarea (`#composer-<id>`)
   * so switching between focused conversations (including via the cycle-focused-conversations
   * hotkey) lands the user's cursor back in the composer, ready to keep typing, instead of on the
   * panel's "Close full view" button — the plain first-focusable default every other trap still
   * uses. Only consulted at the instant `active` turns true; a stale/absent element (returns
   * `null`/`undefined`, or an element that isn't actually inside the trapped container) falls
   * straight through to the default first-focusable behavior, so this is safe to leave unset or to
   * return `null` for the common case (every other dialog in the app).
   */
  getPreferredInitialFocus?: () => HTMLElement | null;
  /**
   * Whether `exit()` restores focus to whatever had it before the trap activated. Defaults to
   * `true`, matching every pre-existing caller (a genuine "open a modal, close it, give focus back
   * to the control that opened it" dialog). Set to `false` for `ConversationDetailPanel.vue`: its
   * `active` prop isn't an open/close signal the way every other caller's is — several panels can
   * be simultaneously mounted at once (the multi-focus overlay), with `active` only marking which
   * ONE is currently the interacted-with member of that set, so going from `active: true` to
   * `false` usually means "a *different*, still-open sibling panel just became active," not "this
   * dialog is closing." Restoring focus in that case is actively harmful: `previouslyFocused` was
   * captured whenever THIS panel itself last activated, which can be a stale reference sitting
   * inside a co-existing sibling panel (e.g. that sibling's own composer) rather than a genuine
   * "what was focused before any of this opened" snapshot — refocusing it fires a real `focusin` on
   * that sibling's own root, which `ConversationDetailPanel.vue` treats as "this panel was just
   * interacted with" (`@focusin="emit('interact')"`), silently flipping `lastInteractedId` right
   * back and undoing whatever switch (a digit-focus press, or the cycle-focused-conversations
   * hotkey) just happened. Tab/Escape trapping and the initial-focus-on-activate behavior above are
   * unaffected either way — only the exit-time restoration is skipped.
   */
  restoreFocusOnExit?: boolean;
}

/**
 * Traps Tab/Shift+Tab within `containerRef` while `active` is true, focuses the container's first
 * focusable element the moment it becomes true, and restores focus to whatever element had focus
 * beforehand once it becomes false (or the owning component unmounts, whichever comes first —
 * covers both a dialog that's toggled by a `v-if` in a persistent parent, like
 * ConversationView.vue's close dialog, and one whose entire host component is mounted/unmounted
 * by a parent's `v-if`, like DiffViewer.vue).
 *
 * `active` may be a ref (for the former case) or a plain getter (`() => true` for the latter,
 * since the component's own mount/unmount already is the on/off signal).
 */
// 005-canvas-conversation-threads: a stack of every currently-active trap, most-recently-entered
// last. Before this feature, no two `useFocusTrap` instances were ever active at once (each
// dialog's host was mounted standalone), so a single document-level Escape listener per trap was
// enough. Phase 6 (US4) started nesting one (`ConversationView.vue`'s own dialogs — the diff
// preview, the close-confirmation dialog, the busy-switch warning) inside another
// (`App.vue`'s single conversation-detail overlay) for the first time. Without this stack, an
// Escape press reached *every* active trap's listener (all registered on `document`, so
// `stopPropagation` alone can't stop sibling listeners on the same node from also firing) —
// closing the inner dialog *and* the outer overlay in one keypress instead of just the topmost
// one, which unmounted the very button focus was supposed to return to. Only the top of this
// stack now acts on Escape, and calls `stopImmediatePropagation` so no older/outer trap's listener
// runs at all for that keypress — the standard "close the most recently opened dialog first"
// behavior any stack of modals needs.
const activeTraps: { handleKeydown: (event: KeyboardEvent) => void }[] = [];

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean> | (() => boolean),
  options: FocusTrapOptions = {},
): void {
  let previouslyFocused: HTMLElement | null = null;
  let trapped = false;

  function handleKeydown(event: KeyboardEvent): void {
    // Only the innermost (most recently entered) active trap responds — see the module doc
    // comment above.
    if (activeTraps[activeTraps.length - 1] !== self) return;

    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const container = containerRef.value;
    if (!container) return;
    const focusables = focusablesIn(container);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const self = { handleKeydown };

  function enter(): void {
    if (trapped) return;
    trapped = true;
    previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeydown, true);
    activeTraps.push(self);
    void nextTick(() => {
      const container = containerRef.value;
      if (!container) return;
      const focusables = focusablesIn(container);
      // Checked via `container.contains(...)` rather than membership in `focusables` above: the
      // latter runs through `isVisible`'s `el.offsetParent !== null` check, which jsdom's
      // `HTMLElement` always reports as `null` (no real layout engine) regardless of whether the
      // element is genuinely visible — so relying on it here would make the preferred element
      // silently and permanently unreachable under every component test using jsdom, while still
      // working by coincidence in a real browser. A plain "is this element actually inside the
      // trapped container" containment check is sufficient: every caller only ever returns an
      // element it just rendered (or null), never a stale/disabled one.
      const preferred = options.getPreferredInitialFocus?.() ?? null;
      const target =
        preferred && container.contains(preferred) ? preferred : (focusables[0] ?? container);
      target.focus();
    });
  }

  function exit(): void {
    if (!trapped) return;
    trapped = false;
    document.removeEventListener('keydown', handleKeydown, true);
    const index = activeTraps.indexOf(self);
    if (index !== -1) activeTraps.splice(index, 1);
    // See `restoreFocusOnExit`'s own doc comment above for why `ConversationDetailPanel.vue` opts
    // out of this (default-on) restoration.
    if (options.restoreFocusOnExit !== false) {
      // The triggering control (e.g. "Preview"/"Close") may itself have been removed from the DOM
      // in the meantime (unlikely, but not impossible) — focus() on a detached element is a no-op.
      previouslyFocused?.focus?.();
    }
    previouslyFocused = null;
  }

  const read = typeof active === 'function' ? active : () => active.value;

  watch(read, (isActive) => (isActive ? enter() : exit()), { immediate: true });

  onBeforeUnmount(exit);
}
