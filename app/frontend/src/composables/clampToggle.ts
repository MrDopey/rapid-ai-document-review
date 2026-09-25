import { ref, watch } from 'vue';

/** research.md: "comfortably show a few lines of text" — a fixed pixel value (not an ideal-lines
 *  count) so the JS overflow check below and the CSS clamp applied in the template agree on
 *  exactly the same number, with a single source of truth. Shared by every clampable block that
 *  uses this controller (e.g. `MessageBubble.vue`'s message text and `ToolCallMessage.vue`'s
 *  per-call bodies), so they all clamp/expand identically. */
export const CLAMP_HEIGHT_PX = 160;

/**
 * One clamp/expand/collapse controller, shared by a "primary" clampable region (e.g. a message's
 * own text) and any number of "secondary" clampable regions (e.g. each tool-call block in that
 * same message) — every clampable region registers its element under its own id rather than
 * getting its own separate set of refs/computeds, so "is this block tall enough to need a toggle"
 * and "clamp to CLAMP_HEIGHT_PX until expanded" are implemented exactly once.
 *
 * The primary id's expanded flag is owned by the caller (deferring to a prop/emit pair the parent
 * owns, per data-model.md); every secondary id gets its own independently-toggleable, local/
 * unpersisted flag instead — EXCEPT that whenever the primary's expanded value actually changes,
 * for *any* reason (its own toggle, or a parent's bulk "Expand all"/"Collapse all", FR-009,
 * changing the driving prop directly), every currently-registered secondary id snaps to match it.
 * This cascade rule lives here, in the shared controller, rather than as separate wiring in each
 * component, so any future secondary clampable block gets it automatically just by registering
 * under this same controller — a bulk collapse can never leave one individually-expanded block
 * stuck open.
 */
export function useClampToggle(
  primaryId: string,
  getPrimaryExpanded: () => boolean,
  setPrimaryExpanded: (value: boolean) => void,
) {
  const els = new Map<string, HTMLElement>();
  // Whether a given id's content is actually taller than the clamp — the expand/collapse button
  // only appears when there's something to expand/collapse. `scrollHeight` reports the true,
  // unclipped content height regardless of whether `overflow: hidden`/`max-height` happens to be
  // applied at the time it's read, so this is accurate whether currently expanded or collapsed.
  const overflowing = ref<Record<string, boolean>>({});
  // 011-linear-thread-mode follow-up: each overflowing id's own measured `scrollHeight`, kept in
  // step with `overflowing` by the same `recompute()` pass. `clampStyle` below uses this so
  // *both* the collapsed and expanded states of an overflowing block resolve to a concrete pixel
  // `max-height` (160px vs. this element's own real height) rather than expanded meaning "no
  // `max-height` at all" — two concrete numbers is what lets a `transition: max-height` in the
  // consuming component's `<style>` actually animate the toggle instead of snapping instantly,
  // which is what Thread mode's tree layout (`ThreadCard.vue`) needs: its branch-connector lines
  // have no coordinates of their own to recalculate (they're `position: absolute` purely relative
  // to their own `.thread-branch-fork`, at a fixed offset — see that file's own doc comment), so
  // the only thing standing between a toggle and a fluid reflow was this instant snap.
  const heights = ref<Record<string, number>>({});
  const secondaryExpanded = ref<Record<string, boolean>>({});

  watch(getPrimaryExpanded, (value) => {
    for (const id of els.keys()) {
      if (id !== primaryId) secondaryExpanded.value[id] = value;
    }
  });

  function isExpanded(id: string): boolean {
    return id === primaryId ? getPrimaryExpanded() : (secondaryExpanded.value[id] ?? false);
  }

  function setExpanded(id: string, value: boolean): void {
    if (id === primaryId) {
      setPrimaryExpanded(value);
    } else {
      secondaryExpanded.value[id] = value;
    }
  }

  // `els` itself is a plain, non-reactive `Map`, so it can't drive a computed — `secondaryExpanded`
  // doubles as the reactive registry of which secondary ids are currently mounted. The `!(id in
  // ...)` guard matters: a redundant `setEl(id, sameEl)` fires on every re-render of an unchanged
  // v-for entry (Vue's function-ref dispatch only passes `null` on a genuine unmount), so without
  // it every re-render would stomp an already-expanded secondary back to collapsed.
  function setEl(id: string, el: Element | null): void {
    if (el instanceof HTMLElement) {
      els.set(id, el);
      if (id !== primaryId && !(id in secondaryExpanded.value)) {
        secondaryExpanded.value[id] = false;
      }
    } else {
      els.delete(id);
      if (id !== primaryId) delete secondaryExpanded.value[id];
    }
  }

  function recompute(): void {
    for (const [id, el] of els) {
      overflowing.value[id] = el.scrollHeight > CLAMP_HEIGHT_PX;
      heights.value[id] = el.scrollHeight;
    }
  }

  function isOverflowing(id: string): boolean {
    return overflowing.value[id] ?? false;
  }

  // Non-overflowing content is left completely alone (`undefined`, exactly as before this doc
  // comment's `heights` addition) — it never had a toggle, so it never needs a `max-height` at
  // all. An overflowing id, though, now always resolves to a concrete `max-height` on *both*
  // sides of its toggle (this element's own measured height at rest — no clip, and visually
  // identical to the old unclamped/`undefined` expanded state) rather than losing `max-height`
  // altogether once expanded, so a `transition: max-height` in the consuming component's
  // `<style>` has two real numbers to animate between instead of jumping from 160px to "none".
  function clampStyle(id: string): { maxHeight: string; overflow: string } | undefined {
    if (!isOverflowing(id)) return undefined;
    const collapsed = !isExpanded(id);
    return {
      maxHeight: `${collapsed ? CLAMP_HEIGHT_PX : (heights.value[id] ?? CLAMP_HEIGHT_PX)}px`,
      overflow: 'hidden',
    };
  }

  function label(id: string): string {
    return isExpanded(id) ? 'Show less' : 'Show more';
  }

  function toggle(id: string): void {
    setExpanded(id, !isExpanded(id));
  }

  // Message-scoped bulk toggle: any consumer registering 2+ secondaries under one primary gets
  // this for free (e.g. `ToolCallMessage.vue`'s multiple tool-call rows); a consumer with 0-1
  // secondaries (e.g. `MessageBubble.vue`'s single text region) always sees `canBulkToggle()` as
  // false, so no per-type gating is needed in the consumer itself. Plain functions, like
  // `isOverflowing`/`isExpanded`/`label` above, not bare `computed()` refs: Vue only auto-unwraps a
  // nested ref reached via a plain returned object inside `{{ }}` text interpolation, not inside a
  // `v-if`/`:attr` expression — returning a ref here would make `v-if="clamp.canBulkToggle"` always
  // truthy (the ref object itself), regardless of its `.value`.
  function anySecondaryCollapsed(): boolean {
    return Object.keys(secondaryExpanded.value).some((id) => !secondaryExpanded.value[id]);
  }

  function canBulkToggle(): boolean {
    const ids = Object.keys(secondaryExpanded.value);
    return ids.length >= 2 && ids.some((id) => overflowing.value[id]);
  }

  function bulkLabel(): string {
    return anySecondaryCollapsed() ? 'Expand all' : 'Collapse all';
  }

  // Deliberately not `toggle(primaryId)`: once a secondary has been toggled independently of the
  // primary, the primary's own stored flag can disagree with "are all secondaries expanded," so a
  // blind flip of it can invert the wrong direction relative to what `bulkLabel()` just told the
  // user. Derive the target value from actual secondary state instead.
  //
  // Also can't rely solely on `setExpanded(primaryId, target)` triggering the cascade `watch`
  // above: that watch only fires on an actual *change* to the primary's value, so when the
  // primary's own flag already happens to equal `target` (e.g. `expanded` defaults to `true` while
  // every secondary defaults to collapsed, since the cascade watch isn't `immediate`), setting it
  // to the same value again is a no-op and the secondaries would never move. Set every registered
  // secondary directly, and still call `setExpanded` on the primary so the caller's own persisted
  // state stays in sync regardless of whether that particular call changes anything.
  function toggleAll(): void {
    const target = anySecondaryCollapsed();
    for (const id of Object.keys(secondaryExpanded.value)) {
      secondaryExpanded.value[id] = target;
    }
    setExpanded(primaryId, target);
  }

  return {
    setEl,
    recompute,
    isOverflowing,
    isExpanded,
    toggle,
    clampStyle,
    label,
    canBulkToggle,
    bulkLabel,
    toggleAll,
  };
}
