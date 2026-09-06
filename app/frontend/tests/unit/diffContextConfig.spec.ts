import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIFF_CONTEXT_LINES,
  resolveDiffContextLines,
} from '../../src/composables/diffContextConfig.js';

describe('resolveDiffContextLines', () => {
  it('falls back to the default when unset or empty', () => {
    expect(resolveDiffContextLines(undefined)).toBe(DEFAULT_DIFF_CONTEXT_LINES);
    expect(resolveDiffContextLines('')).toBe(DEFAULT_DIFF_CONTEXT_LINES);
  });

  it('falls back to the default for non-integer or negative values', () => {
    expect(resolveDiffContextLines('abc')).toBe(DEFAULT_DIFF_CONTEXT_LINES);
    expect(resolveDiffContextLines('1.5')).toBe(DEFAULT_DIFF_CONTEXT_LINES);
    expect(resolveDiffContextLines('-1')).toBe(DEFAULT_DIFF_CONTEXT_LINES);
  });

  it('accepts 0 (collapse everything but the changed lines themselves)', () => {
    expect(resolveDiffContextLines('0')).toBe(0);
  });

  it('parses a valid positive integer', () => {
    expect(resolveDiffContextLines('10')).toBe(10);
  });
});
