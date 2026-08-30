import type { ConversationSeedSelectionDto } from '@rapid-ai-document-review/shared/contracts/http';

/** Anything that can resolve a document offset to a pixel Y relative to its own host element's
 *  top edge — `EditorComponent.vue`'s exposed `anchorTop` satisfies this today. Kept as a small
 *  interface (rather than importing CodeMirror's `EditorView` type here) so this module stays
 *  independently testable with a plain fake, per T011. */
export interface AnchorPositionSource {
  anchorTop(pos: number): number | null;
}

/**
 * Document-space Y (data-model.md's `ConversationLayout.anchorY`) for a conversation's anchor:
 * `0` (top of document) when `seedSelection` is `null` (Main, or any conversation created without
 * a selection); otherwise the pixel Y of the selection's start, resolved via CodeMirror through
 * `editor`. Falls back to `0` if the editor isn't mounted yet or can't resolve the position (e.g.
 * an orphaned anchor whose offset no longer exists in a shorter document) rather than throwing —
 * losing exact vertical placement in that rare case is preferable to breaking the whole canvas.
 */
export function computeAnchorY(
  seedSelection: ConversationSeedSelectionDto | null,
  editor: AnchorPositionSource | null,
): number {
  if (!seedSelection || !editor) return 0;
  return editor.anchorTop(seedSelection.from) ?? 0;
}
