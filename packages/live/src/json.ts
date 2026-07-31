import type { ScalarPatch } from "./scalar.js";
import type { LiveListKey } from "./list.js";
import type { ListPatch } from "./patch.js";

export function applyScalarPatchToJson<T extends Record<string, unknown>>(seed: T, patch: ScalarPatch): T {
  return { ...seed, [patch.field]: patch.value };
}

export function applyListPatchToJson<T extends Record<string, unknown>, Row>(
  seed: T,
  patch: ListPatch<Row>,
  keyOf: (row: Row) => LiveListKey,
): T & Record<string, Row[]> {
  const current = Array.isArray(seed[patch.list]) ? (seed[patch.list] as Row[]) : [];
  return { ...seed, [patch.list]: applyListPatchToRows(current, patch, keyOf) } as T &
    Record<string, Row[]>;
}

/**
 * The row-array half of `applyListPatchToJson`, without the seed object
 * around it. `useLiveList()` reduces a store-delivered list with this — the
 * browser gets patches, never a whole array, and needs the app's own
 * `key(row)` to apply them.
 *
 * Always returns a new array, so it can drive React state directly.
 */
export function applyListPatchToRows<Row>(
  rows: Row[],
  patch: ListPatch<Row>,
  keyOf: (row: Row) => LiveListKey,
): Row[] {
  const current = [...rows];

  switch (patch.op) {
    case "fields":
      return current.map((row) =>
        String(keyOf(row)) === patch.key
          ? ({ ...(row as Record<string, unknown>), ...patch.changes } as Row)
          : row,
      );
    case "insert": {
      // A re-delivered insert (reconnect, replayed log) must not duplicate
      // the row — keys are unique by contract.
      if (current.some((row) => String(keyOf(row)) === patch.key)) return current;
      const next = [...current];
      next.splice(clampIndex(patch.index, next.length), 0, patch.row);
      return next;
    }
    case "remove":
      return current.filter((row) => String(keyOf(row)) !== patch.key);
    case "move":
      return moveRow(current, patch.key, patch.to, keyOf);
    case "replace-row":
      return current.map((row) => (String(keyOf(row)) === patch.key ? patch.row : row));
    default:
      return current;
  }
}

function moveRow<Row>(rows: Row[], key: string, to: number, keyOf: (row: Row) => LiveListKey): Row[] {
  const from = rows.findIndex((row) => String(keyOf(row)) === key);
  if (from === -1) return rows;

  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(clampIndex(to, next.length), 0, row);
  return next;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(index, length));
}
