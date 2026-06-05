import { describe, expect, it } from "bun:test";
import {
  applyListPatchToHtml,
  applyListPatchToJson,
  reconcileListRows,
  todosAfterStatusChange,
  todosBefore,
} from "./index.js";

describe("live patch contract", () => {
  it("uses one small row fields patch for JSON and HTML status updates", () => {
    const [patch] = reconcileListRows({
      route: "/tasks",
      list: "todos",
      keyOf: (todo) => todo.id,
      previous: todosBefore,
      next: todosAfterStatusChange,
    });

    expect(patch).toEqual({
      kind: "list",
      op: "fields",
      route: "/tasks",
      list: "todos",
      key: "1",
      changes: { status: "complete" },
    });

    const serialized = JSON.stringify(patch);
    expect(serialized).not.toContain("<li");
    expect(serialized).not.toContain("</li>");
    expect(serialized).not.toContain("<html");
    expect(serialized).not.toContain("select ");
    expect(serialized).not.toContain("title");

    const json = applyListPatchToJson({ todos: todosBefore }, patch, (todo) => todo.id);
    expect(json.todos[0].status).toBe("complete");
    expect(json.todos[0].title).toBe("Ship");

    const html = [
      '<ul data-kiln-list="todos">',
      '<li data-kiln-key="1"><span data-kiln-field="title">Ship</span><span data-kiln-field="status">in_progress</span></li>',
      '<li data-kiln-key="2"><span data-kiln-field="title">Review</span><span data-kiln-field="status">queued</span></li>',
      "</ul>",
    ].join("");
    const patchedHtml = applyListPatchToHtml(html, patch);

    expect(patchedHtml).toContain('<span data-kiln-field="status">complete</span>');
    expect(patchedHtml).toContain('<span data-kiln-field="title">Ship</span>');
    expect(patchedHtml).toContain('<li data-kiln-key="2"><span data-kiln-field="title">Review</span><span data-kiln-field="status">queued</span></li>');
  });
});
