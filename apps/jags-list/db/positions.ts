/** Fractional ordering: items carry a `double precision` position; inserting
 * between two neighbours takes their midpoint, so a move rewrites one row.
 * When midpoints collapse below EPSILON, the caller rebalances the group. */
const STEP = 1024;
const EPSILON = 1e-6;

export function positionAtEnd(positions: number[]): number {
  if (positions.length === 0) return STEP;
  return Math.max(...positions) + STEP;
}

export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return STEP;
  if (before === null) return after! - STEP;
  if (after === null) return before + STEP;
  return (before + after) / 2;
}

export function needsRebalance(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < EPSILON) return true;
  }
  return false;
}

export function rebalance(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * STEP);
}
