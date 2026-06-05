import { describe, expect, it } from "bun:test";
import { applyListPatchToHtml, applyScalarPatchToHtml, createScalarPatch, type ListPatch } from "./index.js";

describe("live HTML patching", () => {
  it("patches legacy scalar s-live markers", () => {
    const html = '<div><span s-live="status" class="badge">in_progress</span><span s-live="title">Ship</span></div>';
    const result = applyScalarPatchToHtml(html, createScalarPatch("/tasks", "status", "complete"));

    expect(result).toContain('<span s-live="status" class="badge">complete</span>');
    expect(result).toContain('<span s-live="title">Ship</span>');
  });

  it("patches generated scalar data-kiln-live-field markers", () => {
    const html = '<div><span data-kiln-live-field="status">in_progress</span></div>';

    expect(applyScalarPatchToHtml(html, createScalarPatch("/tasks", "status", "complete"))).toContain(
      '<span data-kiln-live-field="status">complete</span>',
    );
  });

  it("escapes scalar patch values as text", () => {
    const html = '<div><span s-live="status">safe</span></div>';
    const result = applyScalarPatchToHtml(html, createScalarPatch("/tasks", "status", '<script>alert("x")</script>'));

    expect(result).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("patches only matching list row fields", () => {
    const html = [
      '<ul data-kiln-list="todos">',
      '<li data-kiln-key="42" class="row">',
      '<input data-kiln-field="completed" type="checkbox">',
      '<span data-kiln-field="title">Ship</span>',
      '<span data-kiln-field="status">in_progress</span>',
      "</li>",
      '<li data-kiln-key="43"><span data-kiln-field="status">queued</span></li>',
      "</ul>",
    ].join("");
    const patch: ListPatch = {
      kind: "list",
      op: "fields",
      route: "/tasks",
      list: "todos",
      key: "42",
      changes: { status: "complete" },
    };

    const result = applyListPatchToHtml(html, patch);

    expect(result).toContain('<span data-kiln-field="title">Ship</span>');
    expect(result).toContain('<input data-kiln-field="completed" type="checkbox">');
    expect(result).toContain('<span data-kiln-field="status">complete</span>');
    expect(result).toContain('<li data-kiln-key="43"><span data-kiln-field="status">queued</span></li>');
  });

  it("removes and moves list row elements", () => {
    const html = '<ul data-kiln-list="todos"><li data-kiln-key="1">one</li><li data-kiln-key="2">two</li></ul>';

    const removed = applyListPatchToHtml(html, { kind: "list", op: "remove", route: "/tasks", list: "todos", key: "1" });
    expect(removed).toBe('<ul data-kiln-list="todos"><li data-kiln-key="2">two</li></ul>');

    const moved = applyListPatchToHtml(html, { kind: "list", op: "move", route: "/tasks", list: "todos", key: "2", from: 1, to: 0 });
    expect(moved).toBe('<ul data-kiln-list="todos"><li data-kiln-key="2">two</li><li data-kiln-key="1">one</li></ul>');
  });

  it("inserts and replaces rows only when rendered row HTML is supplied", () => {
    const html = '<ul data-kiln-list="todos"><li data-kiln-key="1">one</li></ul>';
    const unchanged = applyListPatchToHtml(html, {
      kind: "list",
      op: "insert",
      route: "/tasks",
      list: "todos",
      key: "2",
      index: 1,
      row: { id: 2 },
    });
    expect(unchanged).toBe(html);

    const inserted = applyListPatchToHtml(html, {
      kind: "list",
      op: "insert",
      route: "/tasks",
      list: "todos",
      key: "2",
      index: 1,
      row: { id: 2 },
      html: '<li data-kiln-key="2">two</li>',
    });
    expect(inserted).toBe('<ul data-kiln-list="todos"><li data-kiln-key="1">one</li><li data-kiln-key="2">two</li></ul>');

    const replaced = applyListPatchToHtml(inserted, {
      kind: "list",
      op: "replace-row",
      route: "/tasks",
      list: "todos",
      key: "2",
      row: { id: 2 },
      html: '<li data-kiln-key="2">TWO</li>',
    });
    expect(replaced).toBe('<ul data-kiln-list="todos"><li data-kiln-key="1">one</li><li data-kiln-key="2">TWO</li></ul>');
  });
});
