import { describe, expect, it } from 'vitest';
import { useThreadSegments } from '../../src/composables/useThreadSegments.js';

describe('useThreadSegments', () => {
  it('a thread with zero branches renders as one segment, flagged as the tip', () => {
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    const segments = useThreadSegments('t-root', messages, [
      { id: 't-root', forkedFromMessageId: null },
    ]);

    expect(segments).toEqual([
      { threadId: 't-root', startIndex: 0, endIndex: 2, isTipSegment: true, childBranchIds: [] },
    ]);
  });

  it('one branch partway through splits the parent into two segments — only the last is the tip', () => {
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    const otherThreads = [
      { id: 't-root', forkedFromMessageId: null },
      { id: 't-branch-a', forkedFromMessageId: 'm2' },
    ];
    const segments = useThreadSegments('t-root', messages, otherThreads);

    expect(segments).toEqual([
      {
        threadId: 't-root',
        startIndex: 0,
        endIndex: 1,
        isTipSegment: false,
        childBranchIds: ['t-branch-a'],
      },
      { threadId: 't-root', startIndex: 2, endIndex: 2, isTipSegment: true, childBranchIds: [] },
    ]);
  });

  it("two branches anchored at the same message both appear in that split point's childBranchIds", () => {
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    const otherThreads = [
      { id: 't-root', forkedFromMessageId: null },
      { id: 't-branch-a', forkedFromMessageId: 'm2' },
      { id: 't-branch-b', forkedFromMessageId: 'm2' },
    ];
    const segments = useThreadSegments('t-root', messages, otherThreads);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      threadId: 't-root',
      startIndex: 0,
      endIndex: 1,
      isTipSegment: false,
      childBranchIds: ['t-branch-a', 't-branch-b'],
    });
    expect(segments[1]).toEqual({
      threadId: 't-root',
      startIndex: 2,
      endIndex: 2,
      isTipSegment: true,
      childBranchIds: [],
    });
  });

  it('returns no segments for an empty message list', () => {
    expect(useThreadSegments('t-root', [], [])).toEqual([]);
  });
});
