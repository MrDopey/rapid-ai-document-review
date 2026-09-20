import { describe, expect, it } from 'vitest';
import {
  buildThreadTreeOrder,
  type ThreadTreeOrderSource,
} from '../../src/composables/threadTreeOrder.js';

// 011-linear-thread-mode: `buildThreadTreeOrder` is the pure function
// `threadFocusState.ts`'s Ctrl+Alt+J/K cycling and `ThreadModeView.vue`'s shared-HUD item list
// both build on — this file proves it reproduces `ThreadCard.vue`'s own on-screen left-to-right,
// top-to-bottom tree traversal exactly, using the same `useThreadSegments`-driven grouping rules.

interface Fixture {
  id: string;
  parentId?: string | null;
  doneAt?: string | null;
  createdAt: string;
  forkedFromMessageId?: string | null;
  messages?: string[];
}

function makeSource(fixtures: Fixture[]): ThreadTreeOrderSource {
  const threads = fixtures.map((f) => ({
    id: f.id,
    parentId: f.parentId ?? null,
    doneAt: f.doneAt ?? null,
    createdAt: f.createdAt,
    forkedFromMessageId: f.forkedFromMessageId ?? null,
  }));
  const messagesById = new Map(
    fixtures.map((f) => [f.id, (f.messages ?? []).map((id) => ({ id }))]),
  );
  return {
    threads,
    messagesFor: (threadId: string) => messagesById.get(threadId) ?? [],
  };
}

describe('buildThreadTreeOrder', () => {
  it('orders top-level (parent-less, or promoted-from-a-done-parent) threads by createdAt', () => {
    const source = makeSource([
      { id: 'root-b', createdAt: '2026-01-01T00:02:00.000Z', messages: ['b0'] },
      { id: 'root-a', createdAt: '2026-01-01T00:01:00.000Z', messages: ['a0'] },
    ]);
    expect(buildThreadTreeOrder(source).map((e) => e.id)).toEqual(['root-a', 'root-b']);
  });

  it("promotes a done thread's still-active child to a top-level entry (FR-011), sorted alongside true roots", () => {
    const source = makeSource([
      {
        id: 'root',
        createdAt: '2026-01-01T00:00:00.000Z',
        doneAt: '2026-01-02T00:00:00.000Z',
        messages: ['r0'],
      },
      {
        id: 'promoted-child',
        parentId: 'root',
        createdAt: '2026-01-01T00:01:00.000Z',
        forkedFromMessageId: 'r0',
        messages: ['c0'],
      },
    ]);
    const order = buildThreadTreeOrder(source);
    expect(order.map((e) => e.id)).toEqual(['promoted-child']);
    expect(order[0]!.depth).toBe(0);
  });

  it('visits an active child immediately after the parent segment it forked from, before moving to later segments/siblings', () => {
    // root's messages: r0 (branch-a forks here), r1 (branch-b forks here), r2 (tip)
    const source = makeSource([
      { id: 'root', createdAt: '2026-01-01T00:00:00.000Z', messages: ['r0', 'r1', 'r2'] },
      {
        id: 'branch-a',
        parentId: 'root',
        createdAt: '2026-01-01T00:05:00.000Z',
        forkedFromMessageId: 'r0',
        messages: ['a0'],
      },
      {
        id: 'branch-b',
        parentId: 'root',
        createdAt: '2026-01-01T00:01:00.000Z',
        forkedFromMessageId: 'r1',
        messages: ['b0'],
      },
    ]);
    const order = buildThreadTreeOrder(source);
    // Segment order follows MESSAGE order (r0 before r1), not branch createdAt (branch-b was
    // created earlier than branch-a) — matching `useThreadSegments`' own segment ordering.
    expect(order.map((e) => e.id)).toEqual(['root', 'branch-a', 'branch-b']);
    expect(order.map((e) => e.depth)).toEqual([0, 1, 1]);
  });

  it('recurses into nested branches (branch-of-a-branch) depth-first before returning to the next sibling group', () => {
    const source = makeSource([
      { id: 'root', createdAt: '2026-01-01T00:00:00.000Z', messages: ['r0'] },
      {
        id: 'branch',
        parentId: 'root',
        createdAt: '2026-01-01T00:01:00.000Z',
        forkedFromMessageId: 'r0',
        messages: ['b0'],
      },
      {
        id: 'sub-branch',
        parentId: 'branch',
        createdAt: '2026-01-01T00:02:00.000Z',
        forkedFromMessageId: 'b0',
        messages: ['s0'],
      },
    ]);
    const order = buildThreadTreeOrder(source);
    expect(order.map((e) => e.id)).toEqual(['root', 'branch', 'sub-branch']);
    expect(order.map((e) => e.depth)).toEqual([0, 1, 2]);
  });

  it('never visits a done thread nor any of its descendants inline (only reachable via DoneThreadsPanel)', () => {
    const source = makeSource([
      { id: 'root', createdAt: '2026-01-01T00:00:00.000Z', messages: ['r0'] },
      {
        id: 'done-branch',
        parentId: 'root',
        createdAt: '2026-01-01T00:01:00.000Z',
        forkedFromMessageId: 'r0',
        doneAt: '2026-01-02T00:00:00.000Z',
        messages: ['d0'],
      },
      {
        id: 'child-of-done',
        parentId: 'done-branch',
        createdAt: '2026-01-01T00:02:00.000Z',
        forkedFromMessageId: 'd0',
        messages: ['c0'],
      },
    ]);
    // `child-of-done`'s own parent is done but `child-of-done` itself is active — per FR-011 it
    // should be promoted to top-level, not silently dropped.
    expect(buildThreadTreeOrder(source).map((e) => e.id)).toEqual(['root', 'child-of-done']);
  });
});
