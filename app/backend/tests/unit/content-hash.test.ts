import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../../src/list-items/content-hash.ts';

describe('computeContentHash', () => {
  it('returns the same hash for the same input', () => {
    expect(computeContentHash('fix the intro paragraph')).toBe(
      computeContentHash('fix the intro paragraph'),
    );
  });

  it('returns a different hash for different input', () => {
    expect(computeContentHash('fix the intro paragraph')).not.toBe(
      computeContentHash('fix the conclusion'),
    );
  });
});
