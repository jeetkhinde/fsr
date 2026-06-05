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
  const current = Array.isArray(seed[patch.list]) ? ([...(seed[patch.list] as Row[])] as Row[]) : [];

  let nextRows: Row[];
  switch (patch.op) {
    case "fields":
      nextRows = current.map((row) => (String(keyOf(row)) === patch.key ? ({ ...(row as Record<string, unknown>), ...patch.changes } as Row) : row));
      break;
    case "insert":
      nextRows = [...current];
      nextRows.splice(clampIndex(patch.index, nextRows.length), 0, patch.row);
      break;
    case "remove":
      nextRows = current.filter((row) => String(keyOf(row)) !== patch.key);
      break;
    case "move":
      nextRows = moveRow(current, patch.key, patch.to, keyOf);
      break;
    case "replace-row":
      nextRows = current.map((row) => (String(keyOf(row)) === patch.key ? patch.row : row));
      break;
  }

  return { ...seed, [patch.list]: nextRows } as T & Record<string, Row[]>;
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
