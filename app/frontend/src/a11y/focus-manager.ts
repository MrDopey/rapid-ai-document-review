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
export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean> | (() => boolean),
  options: FocusTrapOptions = {},
): void {
  let previouslyFocused: HTMLElement | null = null;
  let trapped = false;

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
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

  function enter(): void {
    if (trapped) return;
    trapped = true;
    previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeydown, true);
    void nextTick(() => {
      const container = containerRef.value;
      if (!container) return;
      const focusables = focusablesIn(container);
      (focusables[0] ?? container).focus();
    });
  }

  function exit(): void {
    if (!trapped) return;
    trapped = false;
    document.removeEventListener('keydown', handleKeydown, true);
    // The triggering control (e.g. "Preview"/"Close") may itself have been removed from the DOM
    // in the meantime (unlikely, but not impossible) — focus() on a detached element is a no-op.
    previouslyFocused?.focus?.();
    previouslyFocused = null;
  }

  const read = typeof active === 'function' ? active : () => active.value;

  watch(read, (isActive) => (isActive ? enter() : exit()), { immediate: true });

  onBeforeUnmount(exit);
}
