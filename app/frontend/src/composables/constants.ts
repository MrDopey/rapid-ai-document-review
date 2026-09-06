/**
 * Small shared string constants with no other natural home — kept in their own tiny module (rather
 * than folded into an unrelated composable) so multiple, otherwise-independent consumers can import
 * the one canonical value without pulling in anything else.
 */

/**
 * Shared tooltip text used by `HudPanel.vue` for both a row's own `title` (via `rowTitle()`) and
 * its Make/Clear Primary button `title`/`aria-label` (via `primaryButtonTitle()`) — one canonical
 * wording explains what "Primary" means everywhere it appears (FR-027/FR-009: Main stays Primary
 * by default), so the two can't diverge on it.
 */
export const PRIMARY_EXPLANATION =
  'Edits from this conversation apply to the document automatically, with no review step.';
