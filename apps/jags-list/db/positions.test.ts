import { describe, expect, it } from 'bun:test';
import { positionAtEnd, positionBetween, needsRebalance, rebalance } from './positions.js';

describe('fractional positions', () => {
  it('positionAtEnd returns 1024 for an empty column and max+1024 otherwise', () => {
    expect(positionAtEnd([])).toBe(1024);
    expect(positionAtEnd([1024])).toBe(2048);
    expect(positionAtEnd([1024, 3000, 2048])).toBe(4024); // max is 3000
  });

  it('positionBetween returns the midpoint, or an end offset when a side is null', () => {
    expect(positionBetween(1024, 2048)).toBe(1536);
    expect(positionBetween(null, 2048)).toBe(1024); // before the first
    expect(positionBetween(1024, null)).toBe(2048); // after the last
    expect(positionBetween(null, null)).toBe(1024); // empty
  });

  it('needsRebalance flags a collapsed gap', () => {
    expect(needsRebalance([1024, 2048, 3072])).toBe(false);
    expect(needsRebalance([1.0, 1.0000001])).toBe(true); // gap < 1e-6
    expect(needsRebalance([5])).toBe(false);
    expect(needsRebalance([])).toBe(false);
  });

  it('rebalance produces evenly spaced positions', () => {
    expect(rebalance(0)).toEqual([]);
    expect(rebalance(3)).toEqual([1024, 2048, 3072]);
  });
});
