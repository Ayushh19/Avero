import { describe, expect, it } from 'vitest';
import { allocate, formatINR, includedGst, percentOf } from './money';

describe('allocate', () => {
  it('splits exactly, preserving the total', () => {
    const parts = allocate(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(parts).toEqual([334, 333, 333]);
  });

  it('is proportional to weights', () => {
    expect(allocate(500, [399900, 99900])).toEqual([400, 100]);
  });

  it('handles zero weights', () => {
    expect(allocate(100, [0, 0])).toEqual([100, 0]);
  });
});

describe('percentOf', () => {
  it('computes basis points with half-up rounding', () => {
    expect(percentOf(499900, 1000)).toBe(49990);
    expect(percentOf(5, 1000)).toBe(1);
  });
});

describe('includedGst', () => {
  it('extracts GST from an inclusive price', () => {
    // ₹1,180 incl. 18% GST → ₹180 GST
    expect(includedGst(118000, 1800)).toBe(18000);
  });
});

describe('formatINR', () => {
  it('uses Indian grouping', () => {
    expect(formatINR(12345600)).toBe('₹1,23,456');
  });
});
