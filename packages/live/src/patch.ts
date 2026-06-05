import type { LiveListKey } from "./list.js";

export type ListPatch<T = unknown> =
  | { kind: "list"; op: "insert"; route: string; list: string; key: string; index: number; row: T }
  | { kind: "list"; op: "remove"; route: string; list: string; key: string }
  | { kind: "list"; op: "move"; route: string; list: string; key: string; from: number; to: number }
  | { kind: "list"; op: "fields"; route: string; list: string; key: string; changes: Record<string, unknown> }
  | { kind: "list"; op: "replace-row"; route: string; list: string; key: string; row: T };

export type RenderedListPatch<T = unknown> =
  | ListPatch<T>
  | { kind: "list"; op: "insert"; route: string; list: string; key: string; index: number; row: T; html: string }
  | { kind: "list"; op: "replace-row"; route: string; list: string; key: string; row: T; html: string };

export interface ReconcileListRowsInput<T> {
  route: string;
  list: string;
  keyOf(row: T): LiveListKey;
  previous: T[];
  next: T[];
}

interface IndexedRow<T> {
  key: string;
  index: number;
  row: T;
}

export function reconcileListRows<T>(input: ReconcileListRowsInput<T>): ListPatch<T>[] {
  const previous = indexRows(input.previous, input.keyOf, input.list, "previous");
  const next = indexRows(input.next, input.keyOf, input.list, "next");
  const nextKeys = input.next.map((row) => String(input.keyOf(row)));

  const removals: ListPatch<T>[] = [];
  const insertions: ListPatch<T>[] = [];
  const moves: ListPatch<T>[] = [];
  const fields: ListPatch<T>[] = [];
  const virtualOrder = input.previous.map((row) => String(input.keyOf(row))).filter((key) => next.has(key));

  for (const oldRow of previous.values()) {
    if (!next.has(oldRow.key)) {
      removals.push({ kind: "list", op: "remove", route: input.route, list: input.list, key: oldRow.key });
    }
  }

  for (const newRow of next.values()) {
    const oldRow = previous.get(newRow.key);
    if (!oldRow) {
      insertions.push({
        kind: "list",
        op: "insert",
        route: input.route,
        list: input.list,
        key: newRow.key,
        index: newRow.index,
        row: newRow.row,
      });
      virtualOrder.splice(Math.max(0, Math.min(newRow.index, virtualOrder.length)), 0, newRow.key);
    }
  }

  for (let targetIndex = 0; targetIndex < nextKeys.length; targetIndex += 1) {
    const key = nextKeys[targetIndex];
    const currentIndex = virtualOrder.indexOf(key);
    if (currentIndex === -1 || currentIndex === targetIndex) continue;

    moves.push({
      kind: "list",
      op: "move",
      route: input.route,
      list: input.list,
      key,
      from: currentIndex,
      to: targetIndex,
    });
    virtualOrder.splice(currentIndex, 1);
    virtualOrder.splice(targetIndex, 0, key);
  }

  for (const newRow of next.values()) {
    const oldRow = previous.get(newRow.key);
    if (!oldRow) continue;

    const changes = diffShallowFields(oldRow.row, newRow.row);
    if (changes === "replace-row") {
      fields.push({ kind: "list", op: "replace-row", route: input.route, list: input.list, key: newRow.key, row: newRow.row });
    } else if (Object.keys(changes).length > 0) {
      fields.push({ kind: "list", op: "fields", route: input.route, list: input.list, key: newRow.key, changes });
    }
  }

  return [...removals, ...insertions, ...moves, ...fields];
}

function indexRows<T>(
  rows: T[],
  keyOf: (row: T) => LiveListKey,
  list: string,
  label: "previous" | "next",
): Map<string, IndexedRow<T>> {
  const result = new Map<string, IndexedRow<T>>();
  rows.forEach((row, index) => {
    const key = String(keyOf(row));
    if (result.has(key)) {
      throw new Error(`Duplicate key "${key}" in ${label} rows for list "${list}"`);
    }
    result.set(key, { key, index, row });
  });
  return result;
}

function diffShallowFields(previous: unknown, next: unknown): Record<string, unknown> | "replace-row" {
  if (Object.is(previous, next)) return {};
  if (!isRecord(previous) || !isRecord(next)) return "replace-row";

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changes: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      changes[key] = next[key];
    }
  }
  return changes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
