import { describe, expect, it } from "bun:test";
import { reconcileListRows } from "./index.js";

type Todo = {
  id: number;
  title: string;
  completed: boolean;
  status: string;
};

const keyOf = (todo: Todo) => todo.id;

describe("list row reconciliation", () => {
  it("emits insert patches for new rows", () => {
    const patches = reconcileListRows<Todo>({
      route: "/tasks",
      list: "todos",
      keyOf,
      previous: [{ id: 1, title: "Ship", completed: false, status: "queued" }],
      next: [
        { id: 1, title: "Ship", completed: false, status: "queued" },
        { id: 2, title: "Review", completed: false, status: "queued" },
      ],
    });

    expect(patches).toEqual([
      {
        kind: "list",
        op: "insert",
        route: "/tasks",
        list: "todos",
        key: "2",
        index: 1,
        row: { id: 2, title: "Review", completed: false, status: "queued" },
      },
    ]);
  });

  it("emits remove patches for missing rows", () => {
    const patches = reconcileListRows<Todo>({
      route: "/tasks",
      list: "todos",
      keyOf,
      previous: [
        { id: 1, title: "Ship", completed: false, status: "queued" },
        { id: 2, title: "Review", completed: false, status: "queued" },
      ],
      next: [{ id: 2, title: "Review", completed: false, status: "queued" }],
    });

    expect(patches).toEqual([
      { kind: "list", op: "remove", route: "/tasks", list: "todos", key: "1" },
    ]);
  });

  it("emits move patches for reordered rows", () => {
    const patches = reconcileListRows<Todo>({
      route: "/tasks",
      list: "todos",
      keyOf,
      previous: [
        { id: 1, title: "Ship", completed: false, status: "queued" },
        { id: 2, title: "Review", completed: false, status: "queued" },
      ],
      next: [
        { id: 2, title: "Review", completed: false, status: "queued" },
        { id: 1, title: "Ship", completed: false, status: "queued" },
      ],
    });

    expect(patches).toEqual([
      { kind: "list", op: "move", route: "/tasks", list: "todos", key: "2", from: 1, to: 0 },
    ]);
  });

  it("emits fields patches with only changed shallow fields", () => {
    const patches = reconcileListRows<Todo>({
      route: "/tasks",
      list: "todos",
      keyOf,
      previous: [{ id: 1, title: "Ship", completed: false, status: "in_progress" }],
      next: [{ id: 1, title: "Ship", completed: false, status: "complete" }],
    });

    expect(patches).toEqual([
      {
        kind: "list",
        op: "fields",
        route: "/tasks",
        list: "todos",
        key: "1",
        changes: { status: "complete" },
      },
    ]);
  });

  it("emits no patches for unchanged rows", () => {
    const rows = [{ id: 1, title: "Ship", completed: false, status: "queued" }];

    expect(reconcileListRows<Todo>({ route: "/tasks", list: "todos", keyOf, previous: rows, next: rows })).toEqual([]);
  });

  it("throws for duplicate keys in previous rows", () => {
    expect(() =>
      reconcileListRows<Todo>({
        route: "/tasks",
        list: "todos",
        keyOf,
        previous: [
          { id: 1, title: "Ship", completed: false, status: "queued" },
          { id: 1, title: "Duplicate", completed: false, status: "queued" },
        ],
        next: [],
      }),
    ).toThrow("Duplicate key \"1\" in previous rows for list \"todos\"");
  });

  it("throws for duplicate keys in next rows", () => {
    expect(() =>
      reconcileListRows<Todo>({
        route: "/tasks",
        list: "todos",
        keyOf,
        previous: [],
        next: [
          { id: 1, title: "Ship", completed: false, status: "queued" },
          { id: 1, title: "Duplicate", completed: false, status: "queued" },
        ],
      }),
    ).toThrow("Duplicate key \"1\" in next rows for list \"todos\"");
  });

  it("orders mixed operations as removals, insertions, moves, then fields", () => {
    const patches = reconcileListRows<Todo>({
      route: "/tasks",
      list: "todos",
      keyOf,
      previous: [
        { id: 1, title: "Remove", completed: false, status: "queued" },
        { id: 2, title: "Move", completed: false, status: "queued" },
        { id: 3, title: "Patch", completed: false, status: "queued" },
      ],
      next: [
        { id: 3, title: "Patch", completed: false, status: "complete" },
        { id: 2, title: "Move", completed: false, status: "queued" },
        { id: 4, title: "Insert", completed: false, status: "queued" },
      ],
    });

    expect(patches.map((patch) => patch.op)).toEqual(["remove", "insert", "move", "fields"]);
  });
});
