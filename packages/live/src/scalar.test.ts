import { describe, expect, it } from "bun:test";
import { createScalarPatch, isScalarPatch } from "./index.js";

describe("scalar live patches", () => {
  it("creates a small route field patch", () => {
    expect(createScalarPatch("/tasks", "status", "complete")).toEqual({
      kind: "scalar",
      route: "/tasks",
      field: "status",
      value: "complete",
    });
  });

  it("keeps object values as JSON values", () => {
    const patch = createScalarPatch("/tasks", "summary", { open: 2 });

    expect(patch.value).toEqual({ open: 2 });
    expect(typeof patch.value).toBe("object");
    expect(JSON.stringify(patch)).not.toContain("<");
  });

  it("rejects invalid patch objects", () => {
    expect(isScalarPatch({ kind: "scalar", route: "/tasks", field: "status", value: "done" })).toBe(true);
    expect(isScalarPatch({ kind: "scalar", route: "/tasks", value: "done" })).toBe(false);
    expect(isScalarPatch({ kind: "list", route: "/tasks", field: "status", value: "done" })).toBe(false);
    expect(isScalarPatch(null)).toBe(false);
  });
});
