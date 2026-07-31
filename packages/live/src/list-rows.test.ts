import { describe, expect, it } from "bun:test";
import { applyListPatchToRows, type ListPatch } from "./index.js";

type Todo = { id: number; title: string; status: string };

const ROWS: Todo[] = [
  { id: 1, title: "One", status: "queued" },
  { id: 2, title: "Two", status: "queued" },
];
const keyOf = (row: Todo) => row.id;

describe("applyListPatchToRows", () => {
  it("applies each op to the array alone", () => {
    const inserted = applyListPatchToRows(
      ROWS,
      {
        kind: "list",
        op: "insert",
        route: "/tasks",
        list: "todos",
        key: "3",
        index: 1,
        row: { id: 3, title: "Three", status: "queued" },
      },
      keyOf,
    );
    expect(inserted.map((r) => r.id)).toEqual([1, 3, 2]);

    const fielded = applyListPatchToRows(
      inserted,
      { kind: "list", op: "fields", route: "/tasks", list: "todos", key: "3", changes: { status: "done" } },
      keyOf,
    );
    expect(fielded.find((r) => r.id === 3)?.status).toBe("done");

    const moved = applyListPatchToRows(
      fielded,
      { kind: "list", op: "move", route: "/tasks", list: "todos", key: "3", from: 1, to: 2 },
      keyOf,
    );
    expect(moved.map((r) => r.id)).toEqual([1, 2, 3]);

    const removed = applyListPatchToRows(
      moved,
      { kind: "list", op: "remove", route: "/tasks", list: "todos", key: "1" },
      keyOf,
    );
    expect(removed.map((r) => r.id)).toEqual([2, 3]);

    const replaced = applyListPatchToRows(
      removed,
      {
        kind: "list",
        op: "replace-row",
        route: "/tasks",
        list: "todos",
        key: "2",
        row: { id: 2, title: "Two!", status: "done" },
      },
      keyOf,
    );
    expect(replaced[0]).toEqual({ id: 2, title: "Two!", status: "done" });
  });

  it("never mutates the array it was given", () => {
    const before = [...ROWS];
    applyListPatchToRows(
      ROWS,
      { kind: "list", op: "remove", route: "/tasks", list: "todos", key: "1" },
      keyOf,
    );
    expect(ROWS).toEqual(before);
  });

  it("ignores a re-delivered insert instead of duplicating the row", () => {
    // The log replay useLiveList does on mount can hand the same insert to a
    // list that already applied it live.
    const patch: ListPatch<Todo> = {
      kind: "list",
      op: "insert",
      route: "/tasks",
      list: "todos",
      key: "3",
      index: 1,
      row: { id: 3, title: "Three", status: "queued" },
    };
    const once = applyListPatchToRows(ROWS, patch, keyOf);
    const twice = applyListPatchToRows(once, patch, keyOf);
    expect(twice.map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it("leaves the rows alone when a key matches nothing", () => {
    const out = applyListPatchToRows(
      ROWS,
      { kind: "list", op: "fields", route: "/tasks", list: "todos", key: "99", changes: { status: "done" } },
      keyOf,
    );
    expect(out).toEqual(ROWS);
  });
});
