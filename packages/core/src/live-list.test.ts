import { describe, expect, it } from "bun:test";
import { Live, cloneLiveListRows, getLiveListMeta, isLiveList } from "./index.js";

type Todo = {
  id: number;
  title: string;
};

describe("Live.list", () => {
  it("creates an array-like list with hidden metadata and no public name", () => {
    const todos = Live.list({
      key: (todo: Todo) => todo.id,
      dependsOn: "another_table.col",
      initial: [
        { id: 1, title: "Ship" },
        { id: 2, title: "Review" },
      ],
      query: async () => [],
    });

    expect(Array.isArray(todos)).toBe(true);
    expect(isLiveList(todos)).toBe(true);
    expect(todos).toHaveLength(2);

    const meta = getLiveListMeta(todos);
    expect(meta?.kind).toBe("list");
    expect(meta?.dependsOn).toEqual(["another_table.col"]);
    expect(meta?.keyOf(todos[0])).toBe("1");
    expect(meta?.keyOf(todos[1])).toBe("2");
    expect("name" in (meta ?? {})).toBe(false);
  });

  it("keeps normal map usage unchanged", () => {
    const todos = Live.list({
      key: (todo: Todo) => todo.id,
      initial: [{ id: 7, title: "Natural JSX" }],
      query: async () => [],
    });

    expect(todos.map((todo) => ({ key: todo.id, title: todo.title }))).toEqual([
      { key: 7, title: "Natural JSX" },
    ]);
  });

  it("clones replacement rows while preserving hidden metadata", () => {
    const todos = Live.list({
      key: (todo: Todo) => todo.id,
      dependsOn: "todo_events",
      query: async () => [],
    });

    const replacement = cloneLiveListRows(todos, [{ id: 9, title: "Queried" }]);

    expect(replacement).toEqual([{ id: 9, title: "Queried" }]);
    expect(isLiveList(replacement)).toBe(true);
    expect(getLiveListMeta(replacement)).toBe(getLiveListMeta(todos));
    expect(Object.keys(replacement)).toEqual(["0"]);
  });
});
