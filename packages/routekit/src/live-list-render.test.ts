import { describe, expect, it } from "bun:test";
import { Live } from "@kiln/core";
import { applyLiveListMarkers, extractLiveListRowHtml } from "./live-list-render.js";

type Todo = {
  id: number;
  title: string;
  completed: boolean;
  status: string;
};

describe("applyLiveListMarkers", () => {
  it("adds generated list, row, and field markers without public JSX props", () => {
    const todos = Live.list<Todo>({
      key: (todo) => todo.id,
      dependsOn: "another_table.col",
      initial: [
        { id: 1, title: "Ship", completed: false, status: "in_progress" },
        { id: 2, title: "Review", completed: false, status: "queued" },
      ],
      query: () => [],
    });

    const html = [
      "<ul>",
      "<li><label><input type=\"checkbox\" readonly=\"\"/><span>Ship</span><span>in_progress</span></label></li>",
      "<li><label><input type=\"checkbox\" readonly=\"\"/><span>Review</span><span>queued</span></label></li>",
      "</ul>",
    ].join("");

    const marked = applyLiveListMarkers(html, { todos }, "/todos");

    expect(marked).toContain('<ul data-kiln-list="todos" data-kiln-live="/todos">');
    expect(marked).toContain('<li data-kiln-key="1">');
    expect(marked).toContain('<li data-kiln-key="2">');
    expect(marked).toContain('<span data-kiln-field="status" data-kiln-live-field="status">in_progress</span>');
    expect(marked).toContain('<span data-kiln-field="title" data-kiln-live-field="title">Review</span>');
    expect(marked).not.toContain("s-live=");
    expect(marked).not.toContain("s-key=");
  });

  it("extracts keyed row HTML after marker generation", () => {
    const todos = Live.list<Todo>({
      key: (todo) => todo.id,
      initial: [
        { id: 1, title: "Ship", completed: false, status: "queued" },
        { id: 2, title: "Review", completed: false, status: "ready" },
      ],
      query: () => [],
    });
    const marked = applyLiveListMarkers(
      "<ul><li><span>Ship</span><span>queued</span></li><li><span>Review</span><span>ready</span></li></ul>",
      { todos },
      "/todos",
    );

    const rows = extractLiveListRowHtml(marked, "todos");

    expect(rows.get("1")).toContain('data-kiln-key="1"');
    expect(rows.get("2")).toContain('data-kiln-key="2"');
  });

  it("marks the route live root with empty list subscriptions", () => {
    const todos = Live.list<Todo>({
      key: (todo) => todo.id,
      dependsOn: "todo_events",
      query: () => [],
    });

    const marked = applyLiveListMarkers(
      "<html><head></head><body><main><ul></ul></main></body></html>",
      { todos },
      "/todos",
    );

    expect(marked).toContain('<body data-kiln-live="/todos" data-kiln-live-lists="todos">');
  });
});
