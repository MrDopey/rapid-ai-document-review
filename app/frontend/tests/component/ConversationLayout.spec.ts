import { describe, expect, it } from 'vitest';
import {
  columnOf,
  computeConversationLayout,
  orderConversationsByAnchor,
  resolveBaseAnchorY,
  type ConversationLayoutInput,
} from '../../src/components/canvas/conversationLayout.js';
import type { AnchorPositionSource } from '../../src/components/canvas/anchorY.js';

// Spec: specs/005-canvas-conversation-threads (User Story 2, FR-006/FR-007/FR-012, T018).

function fakeEditor(topByPos: Record<number, number | null>): AnchorPositionSource {
  return { anchorTop: (pos: number) => topByPos[pos] ?? null };
}

function conv(partial: Partial<ConversationLayoutInput> & { id: string }): ConversationLayoutInput {
  return {
    parentId: null,
    branchDepth: 0,
    seedSelection: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('columnOf', () => {
  it('maps branchDepth to a display column via max(0, branchDepth - 1)', () => {
    expect(columnOf(0)).toBe(0); // Main
    expect(columnOf(1)).toBe(0); // a direct branch of Main — same column as Main
    expect(columnOf(2)).toBe(1); // a branch of that branch
    expect(columnOf(3)).toBe(2);
  });
});

describe('resolveBaseAnchorY', () => {
  it("returns a conversation's own anchor when it has a seedSelection", () => {
    const editor = fakeEditor({ 100: 250 });
    const c = conv({ id: 'a', seedSelection: { from: 100, to: 110, text: 'x' } });
    expect(resolveBaseAnchorY(c, new Map([['a', c]]), editor)).toBe(250);
  });

  it('returns 0 for Main (no seedSelection, no parent)', () => {
    const main = conv({ id: 'main' });
    expect(resolveBaseAnchorY(main, new Map([['main', main]]), null)).toBe(0);
  });

  it('inherits the nearest ancestor anchor when branched with no selection of its own (gap #2)', () => {
    const editor = fakeEditor({ 100: 250 });
    const main = conv({ id: 'main', branchDepth: 0 });
    const highlight = conv({
      id: 'h',
      parentId: 'main',
      branchDepth: 1,
      seedSelection: { from: 100, to: 110, text: 'x' },
    });
    // "Branch this conversation" on `h` with no document selection — must inherit h's own 250,
    // not collapse to 0 (data-model.md's literal null-selection rule would otherwise place every
    // such branch at the very top of the document).
    const branchOfHighlight = conv({
      id: 'b1',
      parentId: 'h',
      branchDepth: 2,
      seedSelection: null,
    });
    const byId = new Map([
      ['main', main],
      ['h', highlight],
      ['b1', branchOfHighlight],
    ]);
    expect(resolveBaseAnchorY(branchOfHighlight, byId, editor)).toBe(250);
  });

  it('walks multiple generations and bottoms out at 0 through Main when no ancestor has a selection', () => {
    const main = conv({ id: 'main', branchDepth: 0 });
    const child = conv({ id: 'c1', parentId: 'main', branchDepth: 1, seedSelection: null });
    const grandchild = conv({ id: 'c2', parentId: 'c1', branchDepth: 2, seedSelection: null });
    const byId = new Map([
      ['main', main],
      ['c1', child],
      ['c2', grandchild],
    ]);
    expect(resolveBaseAnchorY(grandchild, byId, null)).toBe(0);
  });

  it('does not infinite-loop on a (pathological) parent cycle', () => {
    const a = conv({ id: 'a', parentId: 'b', seedSelection: null });
    const b = conv({ id: 'b', parentId: 'a', seedSelection: null });
    const byId = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(resolveBaseAnchorY(a, byId, null)).toBe(0);
  });
});

// HudPanel.vue's HUD ordering (US4/T032) and App.vue's focus-panel stacking both delegate to this
// function directly (see its own doc comment above) — exercised here as a plain unit, independent
// of either caller's rendering.
describe('orderConversationsByAnchor', () => {
  it("orders conversations by their anchor root's document position ascending", () => {
    const main = conv({ id: 'main' }); // no seedSelection anywhere in its chain -> key -1
    const rootB = conv({ id: 'rootB', seedSelection: { from: 10, to: 20, text: 'y' } });
    const rootA = conv({ id: 'rootA', seedSelection: { from: 50, to: 60, text: 'x' } });
    const byId = new Map([
      ['main', main],
      ['rootB', rootB],
      ['rootA', rootA],
    ]);
    const ordered = orderConversationsByAnchor([rootA, rootB, main], byId);
    expect(ordered.map((c) => c.id)).toEqual(['main', 'rootB', 'rootA']);
  });

  it('keeps a branch grouped with its root, root leading its own group', () => {
    const root = conv({ id: 'root', seedSelection: { from: 30, to: 40, text: 'z' } });
    const branch = conv({ id: 'branch', parentId: 'root', branchDepth: 1, seedSelection: null });
    const byId = new Map([
      ['root', root],
      ['branch', branch],
    ]);
    const ordered = orderConversationsByAnchor([branch, root], byId);
    expect(ordered.map((c) => c.id)).toEqual(['root', 'branch']);
  });

  it('breaks a tie between two roots at the same anchor position by root id, without interleaving their groups (stable tiebreak)', () => {
    // Both `main` and `zzz-root` resolve to key -1 (neither has a `seedSelection` anywhere in its
    // own chain), so without the root-id tiebreak their branches could interleave arbitrarily.
    const main = conv({ id: 'main' });
    const mainBranch = conv({
      id: 'main-branch',
      parentId: 'main',
      branchDepth: 1,
      seedSelection: null,
    });
    const other = conv({ id: 'zzz-root' });
    const otherBranch = conv({
      id: 'zzz-branch',
      parentId: 'zzz-root',
      branchDepth: 1,
      seedSelection: null,
    });
    const byId = new Map([
      ['main', main],
      ['main-branch', mainBranch],
      ['zzz-root', other],
      ['zzz-branch', otherBranch],
    ]);
    const ordered = orderConversationsByAnchor([otherBranch, other, mainBranch, main], byId);
    expect(ordered.map((c) => c.id)).toEqual(['main', 'main-branch', 'zzz-root', 'zzz-branch']);
  });

  it("falls back to each conversation's original array position as a stable tiebreak within one root's own group", () => {
    const root = conv({ id: 'root', seedSelection: { from: 30, to: 40, text: 'z' } });
    const b1 = conv({ id: 'b1', parentId: 'root', branchDepth: 1, seedSelection: null });
    const b2 = conv({ id: 'b2', parentId: 'root', branchDepth: 1, seedSelection: null });
    const byId = new Map([
      ['root', root],
      ['b1', b1],
      ['b2', b2],
    ]);
    const ordered = orderConversationsByAnchor([root, b2, b1], byId);
    expect(ordered.map((c) => c.id)).toEqual(['root', 'b2', 'b1']);
  });
});

describe('computeConversationLayout', () => {
  const minGap = 16;

  it('orders siblings sharing a parent by createdAt', () => {
    const parent = conv({ id: 'p', branchDepth: 1 });
    const first = conv({
      id: 's1',
      parentId: 'p',
      branchDepth: 2,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    const second = conv({
      id: 's2',
      parentId: 'p',
      branchDepth: 2,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    const entries = computeConversationLayout([parent, second, first], {
      anchorYOf: () => 0,
      heightOf: () => 100,
      minGap,
    });
    expect(entries.find((e) => e.id === 's1')!.siblingOrder).toBe(0);
    expect(entries.find((e) => e.id === 's2')!.siblingOrder).toBe(1);
  });

  it('pushes a second sibling down by at least minGap instead of overlapping the first (FR-007)', () => {
    const first = conv({
      id: 's1',
      parentId: 'p',
      branchDepth: 1,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    const second = conv({
      id: 's2',
      parentId: 'p',
      branchDepth: 1,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    const entries = computeConversationLayout([first, second], {
      anchorYOf: () => 200, // both siblings inherit the same base anchor (their shared parent's)
      heightOf: () => 120,
      minGap,
    });
    const e1 = entries.find((e) => e.id === 's1')!;
    const e2 = entries.find((e) => e.id === 's2')!;
    expect(e1.top).toBe(200);
    expect(e2.top).toBeGreaterThanOrEqual(e1.top + 120 + minGap);
  });

  it('does not push down when there is no actual overlap', () => {
    const a = conv({ id: 'a', branchDepth: 1, createdAt: '2026-01-01T00:00:01.000Z' });
    const b = conv({ id: 'b', branchDepth: 1, createdAt: '2026-01-01T00:00:02.000Z' });
    const entries = computeConversationLayout([a, b], {
      anchorYOf: (c) => (c.id === 'a' ? 0 : 500),
      heightOf: () => 50,
      minGap,
    });
    expect(entries.find((e) => e.id === 'b')!.top).toBe(500);
  });

  it('reflows a later box upward when an earlier one is simply absent from the input (FR-012)', () => {
    const a = conv({ id: 'a', branchDepth: 1, createdAt: '2026-01-01T00:00:01.000Z' });
    const b = conv({ id: 'b', branchDepth: 1, createdAt: '2026-01-01T00:00:02.000Z' });
    const c = conv({ id: 'c', branchDepth: 1, createdAt: '2026-01-01T00:00:03.000Z' });
    const withAll = computeConversationLayout([a, b, c], {
      anchorYOf: () => 0,
      heightOf: () => 100,
      minGap,
    });
    const cWithB = withAll.find((e) => e.id === 'c')!.top;

    // `b` "leaves view" (e.g. closed-and-filtered, or hidden) — the caller simply omits it from
    // the array on the next recompute; no separate removal event/API is needed.
    const withoutB = computeConversationLayout([a, c], {
      anchorYOf: () => 0,
      heightOf: () => 100,
      minGap,
    });
    const cWithoutB = withoutB.find((e) => e.id === 'c')!.top;
    expect(cWithoutB).toBeLessThan(cWithB);
  });

  it('separates conversations at the same column that are not siblings but still collide', () => {
    const a = conv({
      id: 'a',
      parentId: 'p1',
      branchDepth: 1,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    const b = conv({
      id: 'b',
      parentId: 'p2',
      branchDepth: 1,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    const entries = computeConversationLayout([a, b], {
      anchorYOf: () => 100, // unrelated conversations that happen to share a base anchor
      heightOf: () => 80,
      minGap,
    });
    const eb = entries.find((e) => e.id === 'b')!;
    expect(eb.top).toBeGreaterThanOrEqual(100 + 80 + minGap);
  });
});
