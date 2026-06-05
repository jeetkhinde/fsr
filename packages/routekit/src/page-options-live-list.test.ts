import { describe, expect, it } from "bun:test";
import { Live, LiveProp } from "@kiln/core";
import { extractLiveFields, extractLiveLists } from "./page-options.js";

describe("extractLiveLists", () => {
  it("extracts lists with inferred names without treating them as scalar fields", () => {
    const loadResult = {
      title: new LiveProp("Tasks", ["tasks.title"]),
      todos: Live.list<{ id: number; status: string }>({
        key: (todo: { id: number }) => todo.id,
        dependsOn: "another_table.col",
        initial: [{ id: 1, status: "in_progress" }],
        query: () => [],
      }),
    };

    expect(extractLiveFields(loadResult).map((field) => field.name)).toEqual(["title"]);
    expect(extractLiveLists(loadResult)).toEqual([
      {
        name: "todos",
        dependsOn: ["another_table.col"],
        keys: ["1"],
      },
    ]);
  });
});
