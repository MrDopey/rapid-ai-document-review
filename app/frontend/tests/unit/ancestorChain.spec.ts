import { describe, expect, it } from 'vitest';
import {
  buildAncestorChain,
  type AncestorChainThread,
} from '../../src/composables/ancestorChain.js';

interface Msg {
  id: string;
}

function makeThreads(): Map<string, AncestorChainThread> {
  return new Map<string, AncestorChainThread>([
    ['root-1', { id: 'root-1', name: 'Root', parentId: null, forkedFromMessageId: null }],
    ['branch-1', { id: 'branch-1', name: 'Branch', parentId: 'root-1', forkedFromMessageId: 'r2' }],
    [
      'branch-2',
      { id: 'branch-2', name: 'Grandchild', parentId: 'branch-1', forkedFromMessageId: 'b1' },
    ],
  ]);
}

function makeMessages(): Map<string, Msg[]> {
  return new Map<string, Msg[]>([
    ['root-1', [{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }, { id: 'r3' }]],
    ['branch-1', [{ id: 'b0' }, { id: 'b1' }, { id: 'b2' }]],
    ['branch-2', [{ id: 'g0' }, { id: 'g1' }]],
  ]);
}

describe('buildAncestorChain', () => {
  it('a root thread (no parent) has an empty ancestor chain and its own full messages', () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chain = buildAncestorChain(
      'root-1',
      (id) => threads.get(id) ?? null,
      (id) => messages.get(id) ?? [],
    );

    expect(chain.ancestors).toEqual([]);
    expect(chain.ownMessages).toEqual([{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
  });

  it('a one-level branch gets its parent as a single sliced ancestor', () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chain = buildAncestorChain(
      'branch-1',
      (id) => threads.get(id) ?? null,
      (id) => messages.get(id) ?? [],
    );

    expect(chain.ancestors).toEqual([
      {
        threadId: 'root-1',
        threadName: 'Root',
        messages: [{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }],
      },
    ]);
    expect(chain.ownMessages).toEqual([{ id: 'b0' }, { id: 'b1' }, { id: 'b2' }]);
  });

  it('a two-level chain (root -> branch -> grandchild) walks root-first, slicing EACH ancestor at its own child fork point, and never slices the target thread itself', () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chain = buildAncestorChain(
      'branch-2',
      (id) => threads.get(id) ?? null,
      (id) => messages.get(id) ?? [],
    );

    expect(chain.ancestors).toEqual([
      {
        threadId: 'root-1',
        threadName: 'Root',
        // Sliced up to and including 'r2' — branch-1's own forkedFromMessageId — 'r3' (which
        // belongs to a sibling path off root-1, not this lineage) is excluded.
        messages: [{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }],
      },
      {
        threadId: 'branch-1',
        threadName: 'Branch',
        // Sliced up to and including 'b1' — branch-2's own forkedFromMessageId — 'b2' (a sibling
        // path off branch-1) is excluded.
        messages: [{ id: 'b0' }, { id: 'b1' }],
      },
    ]);
    // The target thread's own messages are the FULL list, never sliced.
    expect(chain.ownMessages).toEqual([{ id: 'g0' }, { id: 'g1' }]);
  });

  it('returns empty chain/messages for an unresolvable thread id', () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chain = buildAncestorChain(
      'missing',
      (id) => threads.get(id) ?? null,
      (id) => messages.get(id) ?? [],
    );

    expect(chain).toEqual({ ancestors: [], ownMessages: [] });
  });

  it("falls back to an ancestor's full message list when its boundary message cannot be found (e.g. not yet loaded)", () => {
    const threads = makeThreads();
    const messages = new Map<string, Msg[]>([
      ['root-1', []], // not yet loaded
      ['branch-1', [{ id: 'b0' }, { id: 'b1' }]],
    ]);
    const chain = buildAncestorChain(
      'branch-1',
      (id) => threads.get(id) ?? null,
      (id) => messages.get(id) ?? [],
    );

    expect(chain.ancestors).toEqual([{ threadId: 'root-1', threadName: 'Root', messages: [] }]);
  });

  it('is defensive against a cyclic parentId chain (does not loop forever)', () => {
    const threads = new Map<string, AncestorChainThread>([
      ['a', { id: 'a', name: 'A', parentId: 'b', forkedFromMessageId: 'x' }],
      ['b', { id: 'b', name: 'B', parentId: 'a', forkedFromMessageId: 'y' }],
    ]);
    const messages = new Map<string, Msg[]>([
      ['a', []],
      ['b', []],
    ]);
    const chain = buildAncestorChain(
      'a',
      (id) => threads.get(id) ?? null,
      (id) => messages.get(id) ?? [],
    );

    expect(chain.ancestors).toEqual([{ threadId: 'b', threadName: 'B', messages: [] }]);
  });
});
