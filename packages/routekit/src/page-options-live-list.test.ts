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

  // Regression: extraction used to flatten LiveProp.dependsOn (already a
  // string[]) down to its FIRST entry, so Live.value(x, ['a','b']) silently
  // registered only 'a' and writes to 'b' never invalidated the slot.
  // Under-invalidation is the unsafe direction — it serves stale content
  // indefinitely — and it contradicted ADR-018's "explicit deps are
  // preserved, never replaced".
  it("keeps all explicit dependsOn entries, not just the first", () => {
    const loadResult = {
      value: new LiveProp("x", ["tasks", "projects"]),
    };

    expect(extractLiveFields(loadResult)[0].dependsOn).toEqual(["tasks", "projects"]);
  });

  it("normalizes the single-string and options.dependsOn forms to an array", () => {
    // Both legacy shapes have to come back as string[] now that
    // LiveFieldMeta.dependsOn is an array — boot.ts spreads it directly.
    const fromOptions = new LiveProp("x", []) as any;
    fromOptions.dependsOn = [];
    fromOptions.options = { dependsOn: "sessions" };

    expect(extractLiveFields({ a: fromOptions })[0].dependsOn).toEqual(["sessions"]);

    const fromString = new LiveProp("x", []) as any;
    fromString.dependsOn = "tasks";
    expect(extractLiveFields({ b: fromString })[0].dependsOn).toEqual(["tasks"]);
  });

  it("leaves dependsOn undefined when a field declares none (auto-deps supplies it)", () => {
    expect(extractLiveFields({ c: new LiveProp("x", []) })[0].dependsOn).toBeUndefined();
  });
});
