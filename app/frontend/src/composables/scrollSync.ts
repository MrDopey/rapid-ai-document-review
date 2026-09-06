/**
 * Synchronized scrolling between the Editor pane (DocumentCanvas.vue's own native scroll
 * container, `.document-canvas`) and the Preview pane (PreviewComponent.vue's `.preview-pane`).
 *
 * Mapping strategy: proportional scroll position (`scrollTop / (scrollHeight - clientHeight)`),
 * not a precise line/character-offset mapping. A precise mapping would need both panes keyed to
 * the same structure, but they aren't: `DocumentCanvas.vue`'s scroll container spans not just the
 * editor's floating page but also its conversation-thread columns beside it (arbitrary extra
 * height that has nothing to do with document length), while CodeMirror's own internal scroller is
 * deliberately disabled there (`.cm-scroller { overflow: visible }`, see EditorComponent.vue) so
 * there's no independent "editor scroll position" to read a line from in the first place. Preview
 * renders the whole document as one sanitized HTML blob (PreviewComponent.vue), not line-by-line.
 * Proportional position is the best common ground between the two given that.
 *
 * Feedback-loop guard: a plain `syncing` flag, not a "which pane is the source" enum — set before
 * a programmatic `scrollTop` assignment and cleared on the next animation frame (standard
 * technique for this: assigning `scrollTop` dispatches a native `scroll` event, synchronously or on
 * the next tick depending on the browser, so the flag must still be set when that event arrives).
 * While set, both panes' own scroll handlers no-op, so the assignment never ping-pongs back.
 */

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 0 for a pane that isn't scrollable at all (nothing to be proportional about), else clamped to
 *  [0, 1] — defensive against a pane whose content shrank out from under a stale ratio. */
export function scrollRatioOf(el: ScrollMetrics): number {
  const scrollable = el.scrollHeight - el.clientHeight;
  if (scrollable <= 0) return 0;
  return Math.min(1, Math.max(0, el.scrollTop / scrollable));
}

function applyScrollRatio(el: HTMLElement, ratio: number): void {
  const scrollable = el.scrollHeight - el.clientHeight;
  el.scrollTop = scrollable > 0 ? ratio * scrollable : 0;
}

/**
 * Wires two scrollable elements together: scrolling either one, while `isEnabled()` is true, sets
 * the other's scroll position to the same proportional ratio. Returns a cleanup function that
 * removes both listeners.
 *
 * `isEnabled` is a getter (not a plain boolean) so toggling sync on/off doesn't require
 * re-attaching listeners — an ineffective handler while disabled has the same observable effect as
 * "no scroll-linking happens at all" (each pane scrolls independently), since it never touches the
 * other pane's scroll position.
 */
export function attachScrollSync(
  elA: HTMLElement,
  elB: HTMLElement,
  isEnabled: () => boolean,
): () => void {
  let syncing = false;

  function syncTo(source: HTMLElement, target: HTMLElement): void {
    if (syncing || !isEnabled()) return;
    syncing = true;
    applyScrollRatio(target, scrollRatioOf(source));
    requestAnimationFrame(() => {
      syncing = false;
    });
  }

  const onAScroll = (): void => syncTo(elA, elB);
  const onBScroll = (): void => syncTo(elB, elA);

  elA.addEventListener('scroll', onAScroll);
  elB.addEventListener('scroll', onBScroll);

  return () => {
    elA.removeEventListener('scroll', onAScroll);
    elB.removeEventListener('scroll', onBScroll);
  };
}
