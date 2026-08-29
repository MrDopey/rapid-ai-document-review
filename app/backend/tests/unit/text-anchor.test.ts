import { describe, expect, it } from 'vitest';
import { reconcile } from '../../src/document/text-anchor.js';

describe('text-anchor reconcile', () => {
  it('applies a clean single operation', () => {
    const result = reconcile(
      [{ old_string: 'the quick fox', new_string: 'the slow fox' }],
      'the quick fox jumps',
    );
    expect(result.outcome).toBe('clean');
    if (result.outcome === 'clean') {
      expect(result.patches).toEqual([{ from: 0, to: 13, insert: 'the slow fox' }]);
    }
  });

  it('applies multiple disjoint operations atomically in descending offset order', () => {
    const text = 'alpha beta gamma delta';
    const result = reconcile(
      [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'delta', new_string: 'DELTA' },
      ],
      text,
    );
    expect(result.outcome).toBe('clean');
    if (result.outcome === 'clean') {
      expect(result.patches.map((p) => p.insert)).toEqual(['DELTA', 'ALPHA']);
      expect(result.patches[0]!.from).toBeGreaterThan(result.patches[1]!.from);
    }
  });

  it('reports not_found when the anchor text is gone', () => {
    const result = reconcile(
      [{ old_string: 'missing text', new_string: 'x' }],
      'this document has nothing matching',
    );
    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.detail.operations).toEqual([
        { index: 0, reason: 'not_found', occurrences: 0 },
      ]);
    }
  });

  it('reports ambiguous when the anchor appears more than once', () => {
    const result = reconcile(
      [{ old_string: 'repeat', new_string: 'x' }],
      'repeat this and repeat that',
    );
    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.detail.operations).toEqual([
        { index: 0, reason: 'ambiguous', occurrences: 2 },
      ]);
    }
  });

  it('reports overlapping when two resolved ranges intersect', () => {
    const text = 'abcdefgh';
    const result = reconcile(
      [
        { old_string: 'abcdef', new_string: 'X' },
        { old_string: 'cdefgh', new_string: 'Y' },
      ],
      text,
    );
    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.detail.operations).toHaveLength(2);
      expect(result.detail.operations.every((o) => o.reason === 'overlapping')).toBe(true);
    }
  });

  it('is all-or-nothing: one bad operation conflicts the whole proposal', () => {
    const text = 'one two three';
    const result = reconcile(
      [
        { old_string: 'one', new_string: '1' },
        { old_string: 'missing', new_string: '?' },
      ],
      text,
    );
    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.detail.operations).toEqual([
        { index: 1, reason: 'not_found', occurrences: 0 },
      ]);
    }
  });

  it('treats an empty new_string as a deletion', () => {
    const result = reconcile([{ old_string: 'remove me ', new_string: '' }], 'remove me please');
    expect(result.outcome).toBe('clean');
    if (result.outcome === 'clean') {
      expect(result.patches).toEqual([{ from: 0, to: 10, insert: '' }]);
    }
  });
});
