import { describe, expect, it } from 'vitest';
import type { Change } from 'diff';
import { splitIntoLines, groupByContext, groupParts } from '../../src/components/diff/collapseUnchanged.js';

describe('splitIntoLines', () => {
  it('re-chunks a multi-line unchanged part into one line each', () => {
    const parts: Change[] = [{ value: 'one\ntwo\nthree' }];
    const lines = splitIntoLines(parts);
    expect(lines).toHaveLength(3);
    expect(lines[0].parts).toEqual([{ value: 'one\n' }]);
    expect(lines[1].parts).toEqual([{ value: 'two\n' }]);
    expect(lines[2].parts).toEqual([{ value: 'three' }]);
  });

  it('keeps multiple parts on the same line together, in order', () => {
    const parts: Change[] = [
      { value: 'unchanged ' },
      { value: 'removed', removed: true },
      { value: 'added', added: true },
      { value: ' tail\nnext line' },
    ];
    const lines = splitIntoLines(parts);
    expect(lines).toHaveLength(2);
    expect(lines[0].parts).toEqual([
      { value: 'unchanged ' },
      { value: 'removed', removed: true },
      { value: 'added', added: true },
      { value: ' tail\n' },
    ]);
    expect(lines[1].parts).toEqual([{ value: 'next line' }]);
  });

  it('reproduces the original text when every line is rejoined', () => {
    const original = 'a\nb\nc\nd';
    const parts: Change[] = [{ value: original }];
    const lines = splitIntoLines(parts);
    const rejoined = lines.map((l) => l.parts.map((p) => p.value).join('')).join('');
    expect(rejoined).toBe(original);
  });
});

describe('groupByContext', () => {
  function line(value: string, flag?: 'added' | 'removed') {
    return { parts: [{ value: `${value}\n`, ...(flag ? { [flag]: true } : {}) }] };
  }

  it('keeps every line when nothing is far enough from a change to collapse', () => {
    const lines = [line('a'), line('b', 'added'), line('c')];
    const groups = groupByContext(lines, 3);
    expect(groups).toEqual([{ type: 'visible', lines }]);
  });

  it('collapses a long unchanged run beyond the context window on both sides', () => {
    const lines = [
      line('change', 'added'),
      line('ctx1'),
      line('ctx2'),
      line('far1'),
      line('far2'),
      line('far3'),
      line('ctx3'),
      line('ctx4'),
      line('change2', 'removed'),
    ];
    const groups = groupByContext(lines, 2);
    expect(groups.map((g) => g.type)).toEqual(['visible', 'collapsed', 'visible']);
    expect(groups[0].lines).toHaveLength(3); // change + 2 lines of context
    expect(groups[1].lines).toHaveLength(3); // far1..far3
    expect(groups[2].lines).toHaveLength(3); // 2 lines of context + change2
  });

  it('collapses everything when there is no change at all', () => {
    const lines = [line('a'), line('b'), line('c')];
    const groups = groupByContext(lines, 2);
    expect(groups).toEqual([{ type: 'collapsed', lines }]);
  });

  it('contextLines=0 keeps only the changed lines themselves', () => {
    const lines = [line('a'), line('b', 'added'), line('c')];
    const groups = groupByContext(lines, 0);
    expect(groups.map((g) => g.type)).toEqual(['collapsed', 'visible', 'collapsed']);
  });
});

describe('groupParts', () => {
  it('flattens a group back into one ordered Change[]', () => {
    const group = {
      type: 'visible' as const,
      lines: [{ parts: [{ value: 'a\n' }] }, { parts: [{ value: 'b\n' }, { value: 'c', added: true }] }],
    };
    expect(groupParts(group)).toEqual([{ value: 'a\n' }, { value: 'b\n' }, { value: 'c', added: true }]);
  });
});
