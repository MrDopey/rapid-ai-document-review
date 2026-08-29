import type { Ref } from 'vue';

/** Shared by every resize-handle site in the app (see `panePersistence.ts` for the matching
 *  shared persistence half). Originally App.vue implemented its own drag/keyboard logic twice
 *  (Editor|Preview, content|sidebar); this composable factors that out so the two newer vertical
 *  splits (App.vue's Conversations-list|conversation-detail, ConversationView.vue's
 *  transcript|proposed-edits) reuse it instead of adding a third and fourth near-identical copy. */

export type ResizeAxis = 'horizontal' | 'vertical';

const KEYBOARD_RESIZE_STEP_PX = 24;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface UseResizeHandleOptions {
  /** 'horizontal' = a vertical dividing line the user drags left/right (ArrowLeft/ArrowRight).
   *  'vertical' = a horizontal dividing line the user drags up/down (ArrowUp/ArrowDown). */
  axis: ResizeAxis;
  /** The element whose `getBoundingClientRect()` the drag/keyboard math is computed against. */
  containerEl: Ref<HTMLElement | null>;
  /**
   * Called once at the start of each gesture (one pointerdown-to-pointerup drag, or one keyboard
   * step) with the container's rect at that moment. Must return the delta-applier for that one
   * gesture — capturing any "start of gesture" state (e.g. the starting `fr` values) in its
   * closure, exactly like the per-drag closures this composable replaces used to. The returned
   * function receives the total signed delta, in px, since the gesture began along `axis`
   * (positive = right for horizontal, down for vertical) and owns all clamping and ref updates;
   * this composable never touches the underlying refs itself.
   */
  beginGesture: (containerRect: DOMRect) => (deltaPx: number) => void;
  /** Called once after a drag ends (pointerup) or a keyboard step is applied, to persist. */
  onSettle: () => void;
}

export interface UseResizeHandle {
  startDrag: (event: PointerEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
}

export function useResizeHandle(options: UseResizeHandleOptions): UseResizeHandle {
  const { axis, containerEl, beginGesture, onSettle } = options;
  const forwardKey = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backwardKey = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';

  function pointerPos(event: PointerEvent): number {
    return axis === 'horizontal' ? event.clientX : event.clientY;
  }

  function startDrag(startEvent: PointerEvent): void {
    startEvent.preventDefault();
    const containerRect = containerEl.value?.getBoundingClientRect();
    if (!containerRect) return;
    const startPos = pointerPos(startEvent);
    const applyDelta = beginGesture(containerRect);

    function onMove(moveEvent: PointerEvent): void {
      applyDelta(pointerPos(moveEvent) - startPos);
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onSettle();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Keyboard-operable equivalent of the drag above (WCAG 2.2 AA, FR-043). */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== forwardKey && event.key !== backwardKey) return;
    event.preventDefault();
    const containerRect = containerEl.value?.getBoundingClientRect();
    if (!containerRect) return;
    const direction = event.key === forwardKey ? 1 : -1;
    beginGesture(containerRect)(direction * KEYBOARD_RESIZE_STEP_PX);
    onSettle();
  }

  return { startDrag, onKeydown };
}
