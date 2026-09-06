import type { ConversationSeedSelectionDto } from '@rapid-ai-document-review/shared/contracts/http';
import { computeAnchorY, type AnchorPositionSource } from './anchorY.js';

/** The subset of `ConversationDto` this module's layout math actually needs — kept narrow so it
 *  stays independently testable with plain fixtures (T018) rather than a full `ConversationDto`. */
export interface ConversationLayoutInput {
  id: string;
  parentId: string | null;
  branchDepth: number;
  seedSelection: ConversationSeedSelectionDto | null;
  createdAt: string;
}

export interface ConversationLayoutEntry {
  id: string;
  column: number;
  /** Index among conversations sharing the same `parentId`, ordered by `createdAt` (FR-007). */
  siblingOrder: number;
  /** Final stacked vertical position, in the canvas's own coordinate space. */
  top: number;
}

/**
 * "Column" is a *display* concept, not literally `branchDepth` — see `DocumentCanvas.vue`'s
 * original `columnOf` comment (Phase 3/US1) for the full reasoning: data-model.md's "column =
 * branchDepth" contradicts spec.md's own FR-003/FR-004 (Main, `branchDepth: 0`, and any direct
 * highlight-anchored branch of Main, `branchDepth: 1`, explicitly share "the same right-hand
 * column area") and quickstart.md's worked Scenario 2 (a direct branch of Main → "column 0"; a
 * branch of *that* branch, `branchDepth: 2` → "column 1"; a branch of *that* → "column 2").
 * `max(0, branchDepth - 1)` is the mapping that satisfies every one of those scenarios at once.
 * Phase 4/US2 reuses this exact function (moved here from `DocumentCanvas.vue`, which now imports
 * it from this module instead of keeping a second copy) so the two phases can never disagree.
 */
export function columnOf(branchDepth: number): number {
  return Math.max(0, branchDepth - 1);
}

/**
 * Walks up `parentId` from `conversation` to the nearest ancestor that either (a) actually has a
 * `seedSelection` (a genuine highlight anchor — could be `conversation` itself), or (b) has no
 * `parentId` at all (Main, the only conversation created without a parent) — whichever comes
 * first. Guarded against a cycle or a dangling `parentId` (shouldn't occur, but this is UI layout
 * code, not data-integrity enforcement) by stopping and returning the current node instead of
 * looping forever. Shared by `resolveBaseAnchorY` below (US2/T020) and `HudPanel.vue`'s HUD
 * ordering (US4/T032, data-model.md's "resolve its root ancestor") — both need exactly this same
 * walk, just a different final projection of the landed-on conversation (a pixel Y vs. a plain
 * document offset for sorting), so the walk itself lives here once.
 */
export function resolveAnchorRoot(
  conversation: ConversationLayoutInput,
  byId: ReadonlyMap<string, ConversationLayoutInput>,
): ConversationLayoutInput {
  const visited = new Set<string>();
  let current = conversation;
  while (true) {
    if (current.seedSelection) return current;
    if (!current.parentId || visited.has(current.id)) return current;
    visited.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) return current;
    current = parent;
  }
}

/**
 * A conversation's *base* vertical anchor, before sibling-collision stacking. `data-model.md`'s
 * literal "`anchorY` is `0` when `seedSelection` is null" only actually holds for Main — a branch
 * created via the "Branch this conversation" affordance (T018/T021's gap #2) carries no document
 * `selection` of its own (there is no message-level anchor in this data model at all; see
 * spec.md's Assumptions section), so it would otherwise collapse to the very top of the document,
 * contradicting the whole point of User Story 2 (siblings stack near their *parent's* position,
 * one column further out). Instead: resolve the anchored root via `resolveAnchorRoot` above and use
 * *its* pixel position — bottoming out at `0` once the walk reaches Main.
 */
export function resolveBaseAnchorY(
  conversation: ConversationLayoutInput,
  byId: ReadonlyMap<string, ConversationLayoutInput>,
  editor: AnchorPositionSource | null,
): number {
  const root = resolveAnchorRoot(conversation, byId);
  return root.seedSelection ? computeAnchorY(root.seedSelection, editor) : 0;
}

/**
 * data-model.md's "HUD ordering", factored out of `HudPanel.vue` (005-canvas-conversation-threads,
 * multi-focus overlay) so App.vue's stack of simultaneously-focused detail panels can be arranged
 * in the exact same order as the HUD itself, without a second, independently-maintained ordering
 * mechanism: for each conversation, resolve its root ancestor via `resolveAnchorRoot` above and
 * sort by that root's document-offset position ascending (Main's root has no `seedSelection` at
 * all, so it sorts before every real offset, which are always >= 0). Conversations sharing the
 * same root are grouped contiguously — sorted first by the shared root's position, then by the
 * root's own id (so two distinct roots that happen to tie on position, e.g. Main itself and a
 * "Branch this conversation" chain off Main with no highlight anywhere in it, still don't
 * interleave), then with the root conversation itself always leading its own group, then by each
 * conversation's original position in `conversations` as a stable tie-break within one root's own
 * group.
 */
export function orderConversationsByAnchor<T extends ConversationLayoutInput>(
  conversations: readonly T[],
  byId: ReadonlyMap<string, ConversationLayoutInput>,
): T[] {
  const indexed = conversations.map((c, i) => ({ c, i, root: resolveAnchorRoot(c, byId) }));
  const rootKey = (root: ConversationLayoutInput) =>
    root.seedSelection ? root.seedSelection.from : -1;
  indexed.sort((a, b) => {
    const ka = rootKey(a.root);
    const kb = rootKey(b.root);
    if (ka !== kb) return ka - kb;
    if (a.root.id !== b.root.id) return a.root.id.localeCompare(b.root.id);
    const aIsRoot = a.c.id === a.root.id;
    const bIsRoot = b.c.id === b.root.id;
    if (aIsRoot !== bIsRoot) return aIsRoot ? -1 : 1;
    return a.i - b.i;
  });
  return indexed.map((entry) => entry.c);
}

function siblingOrdersOf(conversations: readonly ConversationLayoutInput[]): Map<string, number> {
  const byParent = new Map<string | null, ConversationLayoutInput[]>();
  for (const c of conversations) {
    const list = byParent.get(c.parentId);
    if (list) list.push(c);
    else byParent.set(c.parentId, [c]);
  }
  const orders = new Map<string, number>();
  for (const list of byParent.values()) {
    const sorted = [...list].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    sorted.forEach((c, index) => orders.set(c.id, index));
  }
  return orders;
}

export interface ConversationLayoutOptions {
  /** Base anchor Y (pre-stacking) for a conversation — typically `resolveBaseAnchorY` above. */
  anchorYOf: (conversation: ConversationLayoutInput) => number;
  /** Current rendered (or best-estimate) height of a conversation's box, in pixels. */
  heightOf: (conversationId: string) => number;
  /** Minimum vertical gap enforced between two stacked boxes in the same column (FR-007/FR-012). */
  minGap: number;
}

/**
 * Column + stacked-position layout for every *visible* conversation (research.md §6). Only the
 * conversations actually present in `conversations` are laid out — a closed-and-filtered-out or
 * otherwise hidden conversation simply isn't in that array, so the boxes below it in the same
 * column naturally close the gap it would have left (FR-012's "reflow up on removal"). This is the
 * mechanism Phase 6 (US4)'s `HudPanel` "Active only" filter (once reintroduced) plugs into for
 * free — filtering the array this function receives is the entire integration point; no separate
 * "removed" event or reflow trigger is needed.
 */
export function computeConversationLayout(
  conversations: readonly ConversationLayoutInput[],
  options: ConversationLayoutOptions,
): ConversationLayoutEntry[] {
  const siblingOrders = siblingOrdersOf(conversations);
  const byColumn = new Map<number, ConversationLayoutInput[]>();
  for (const c of conversations) {
    const column = columnOf(c.branchDepth);
    const list = byColumn.get(column);
    if (list) list.push(c);
    else byColumn.set(column, [c]);
  }

  const result: ConversationLayoutEntry[] = [];
  for (const [column, entries] of byColumn) {
    const withBase = entries
      .map((c) => ({ c, base: options.anchorYOf(c) }))
      .sort(
        (a, b) =>
          a.base - b.base ||
          a.c.createdAt.localeCompare(b.c.createdAt) ||
          a.c.id.localeCompare(b.c.id),
      );

    let cursorBottom = Number.NEGATIVE_INFINITY;
    for (const { c, base } of withBase) {
      const top =
        cursorBottom === Number.NEGATIVE_INFINITY
          ? base
          : Math.max(base, cursorBottom + options.minGap);
      cursorBottom = top + options.heightOf(c.id);
      result.push({ id: c.id, column, siblingOrder: siblingOrders.get(c.id) ?? 0, top });
    }
  }
  return result;
}
