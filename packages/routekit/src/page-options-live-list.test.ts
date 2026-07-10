import { describe, expect, it } from "bun:test";
import { Live, LiveProp } from "@kiln/core";
import { extractLiveFields } from "./page-options.js";

describe("extractLiveFields", () => {
  it("does not treat Live.list values as scalar live fields", () => {
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
  });
});
