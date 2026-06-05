import { describe, expect, it } from "bun:test";
import {
  applyListPatchToJson,
  applyScalarPatchToJson,
  createScalarPatch,
  type ListPatch,
} from "./index.js";

describe("live JSON patching", () => {
  it("applies scalar patches without mutating the seed object", () => {
    const seed = { title: "Task", status: "in_progress", count: 1 };
    const patch = createScalarPatch("/tasks", "status", "complete");

    expect(applyScalarPatchToJson(seed, patch)).toEqual({
      title: "Task",
      status: "complete",
      count: 1,
    });
    expect(seed.status).toBe("in_progress");
  });

  it("applies list fields patches to one row field", () => {
    const seed = {
      todos: [
        { id: 1, title: "Ship", completed: false, status: "in_progress" },
        { id: 2, title: "Review", completed: false, status: "queued" },
      ],
    };
    const patch: ListPatch = {
      kind: "list",
      op: "fields",
      route: "/tasks",
      list: "todos",
      key: "1",
      changes: { status: "complete" },
    };

    const result = applyListPatchToJson(seed, patch, (row) => row.id);

    expect(result).toEqual({
      todos: [
        { id: 1, title: "Ship", completed: false, status: "complete" },
        { id: 2, title: "Review", completed: false, status: "queued" },
      ],
    });
    expect(seed.todos[0].status).toBe("in_progress");
  });

  it("applies insert, remove, move, and replace-row patches", () => {
    const seed = {
      todos: [
        { id: 1, title: "One", status: "queued" },
        { id: 2, title: "Two", status: "queued" },
      ],
    };

    const inserted = applyListPatchToJson(
      seed,
      { kind: "list", op: "insert", route: "/tasks", list: "todos", key: "3", index: 1, row: { id: 3, title: "Three", status: "queued" } },
      (row) => row.id,
    );
    expect(inserted.todos.map((todo) => todo.id)).toEqual([1, 3, 2]);

    const removed = applyListPatchToJson(inserted, { kind: "list", op: "remove", route: "/tasks", list: "todos", key: "1" }, (row) => row.id);
    expect(removed.todos.map((todo) => todo.id)).toEqual([3, 2]);

    const moved = applyListPatchToJson(removed, { kind: "list", op: "move", route: "/tasks", list: "todos", key: "2", from: 1, to: 0 }, (row) => row.id);
    expect(moved.todos.map((todo) => todo.id)).toEqual([2, 3]);

    const replaced = applyListPatchToJson(moved, { kind: "list", op: "replace-row", route: "/tasks", list: "todos", key: "2", row: { id: 2, title: "Two", status: "complete" } }, (row) => row.id);
    expect(replaced.todos[0]).toEqual({ id: 2, title: "Two", status: "complete" });
  });
});
