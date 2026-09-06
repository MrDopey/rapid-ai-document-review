/**
 * Small shared string constants with no other natural home — kept in their own tiny module (rather
 * than folded into an unrelated composable) so multiple, otherwise-independent consumers can import
 * the one canonical value without pulling in anything else.
 */

/**
 * De-dup fix: identical tooltip/notice text hand-duplicated in both `HudPanel.vue` (a row's
 * `title`, via `rowTitle()`) and `PrimaryPanel.vue` (the primary notice + Make/Clear-Primary button
 * titles) — explains what "Primary" means everywhere the word appears in either surface
 * (FR-027/FR-009: Main stays Primary by default — this is purely explanatory, it changes no
 * behaviour).
 */
export const PRIMARY_EXPLANATION =
  'Edits from this conversation apply to the document automatically, with no review step.';
