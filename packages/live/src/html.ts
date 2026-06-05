import type { ScalarPatch } from "./scalar.js";
import type { RenderedListPatch } from "./patch.js";

interface ElementRange {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  tagName: string;
}

export function applyScalarPatchToHtml(html: string, patch: ScalarPatch): string {
  const replacement = escapeHtml(valueToText(patch.value));
  let result = patchElementsWithAttr(html, "s-live", patch.field, replacement);
  result = patchElementsWithAttr(result, "data-kiln-live-field", patch.field, replacement);
  return result;
}

export function applyListPatchToHtml(html: string, patch: RenderedListPatch): string {
  const container = findElementByAttr(html, "data-kiln-list", patch.list);
  if (!container) return html;

  const containerHtml = html.slice(container.contentStart, container.contentEnd);
  const row = findElementByAttr(containerHtml, "data-kiln-key", patch.key);
  if (!row && patch.op !== "insert") return html;

  let patchedContainerHtml = containerHtml;
  switch (patch.op) {
    case "fields":
      patchedContainerHtml = applyFieldPatchToRow(containerHtml, row!, patch.changes);
      break;
    case "remove":
      patchedContainerHtml = containerHtml.slice(0, row!.start) + containerHtml.slice(row!.end);
      break;
    case "move":
      patchedContainerHtml = moveRowHtml(containerHtml, row!, patch.to);
      break;
    case "insert":
      if (!("html" in patch)) return html;
      patchedContainerHtml = insertRowHtml(containerHtml, patch.html, patch.index);
      break;
    case "replace-row":
      if (!("html" in patch)) return html;
      patchedContainerHtml = containerHtml.slice(0, row!.start) + patch.html + containerHtml.slice(row!.end);
      break;
  }

  return html.slice(0, container.contentStart) + patchedContainerHtml + html.slice(container.contentEnd);
}

function insertRowHtml(containerHtml: string, rowHtml: string, index: number): string {
  const rows = findElementsByAttr(containerHtml, "data-kiln-key");
  const insertIndex = Math.max(0, Math.min(index, rows.length));
  if (rows.length === 0 || insertIndex >= rows.length) {
    return containerHtml + rowHtml;
  }
  const target = rows[insertIndex];
  return containerHtml.slice(0, target.start) + rowHtml + containerHtml.slice(target.start);
}

function applyFieldPatchToRow(containerHtml: string, row: ElementRange, changes: Record<string, unknown>): string {
  let rowHtml = containerHtml.slice(row.start, row.end);
  for (const [field, value] of Object.entries(changes)) {
    rowHtml = patchElementsWithAttr(rowHtml, "data-kiln-field", field, escapeHtml(valueToText(value)));
  }
  return containerHtml.slice(0, row.start) + rowHtml + containerHtml.slice(row.end);
}

function moveRowHtml(containerHtml: string, row: ElementRange, to: number): string {
  const rowHtml = containerHtml.slice(row.start, row.end);
  const withoutRow = containerHtml.slice(0, row.start) + containerHtml.slice(row.end);
  const rows = findElementsByAttr(withoutRow, "data-kiln-key");
  const insertIndex = Math.max(0, Math.min(to, rows.length));

  if (rows.length === 0 || insertIndex >= rows.length) {
    return withoutRow + rowHtml;
  }

  const target = rows[insertIndex];
  return withoutRow.slice(0, target.start) + rowHtml + withoutRow.slice(target.start);
}

function patchElementsWithAttr(html: string, attrName: string, attrValue: string, escapedReplacement: string): string {
  const ranges = findElementsByAttr(html, attrName, attrValue);
  if (ranges.length === 0) return html;

  let result = html;
  for (const range of [...ranges].reverse()) {
    result = result.slice(0, range.contentStart) + escapedReplacement + result.slice(range.contentEnd);
  }
  return result;
}

function findElementsByAttr(html: string, attrName: string, attrValue?: string): ElementRange[] {
  const ranges: ElementRange[] = [];
  let offset = 0;
  while (offset < html.length) {
    const range = findElementByAttr(html, attrName, attrValue, offset);
    if (!range) break;
    ranges.push(range);
    offset = range.end;
  }
  return ranges;
}

function findElementByAttr(html: string, attrName: string, attrValue?: string, offset = 0): ElementRange | null {
  const attrNeedle = attrValue === undefined ? `${attrName}=` : `${attrName}="${attrValue}"`;
  const attrPos = html.indexOf(attrNeedle, offset);
  if (attrPos === -1) return null;

  const tagStart = html.lastIndexOf("<", attrPos);
  if (tagStart === -1 || html[tagStart + 1] === "/") return null;

  const tagEnd = html.indexOf(">", attrPos);
  if (tagEnd === -1) return null;

  const tagSource = html.slice(tagStart + 1, tagEnd).trim();
  const tagName = tagSource.match(/^([A-Za-z][A-Za-z0-9:-]*)/)?.[1];
  if (!tagName) return null;
  if (tagSource.endsWith("/")) {
    return { start: tagStart, end: tagEnd + 1, contentStart: tagEnd + 1, contentEnd: tagEnd + 1, tagName };
  }

  const closeStart = findClosingTag(html, tagName, tagEnd + 1);
  if (closeStart === -1) {
    return { start: tagStart, end: tagEnd + 1, contentStart: tagEnd + 1, contentEnd: tagEnd + 1, tagName };
  }

  const closeEnd = html.indexOf(">", closeStart);
  if (closeEnd === -1) return null;

  return {
    start: tagStart,
    end: closeEnd + 1,
    contentStart: tagEnd + 1,
    contentEnd: closeStart,
    tagName,
  };
}

function findClosingTag(html: string, tagName: string, offset: number): number {
  const pattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  pattern.lastIndex = offset;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const source = match[0];
    if (source.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (!source.endsWith("/>")) {
      depth += 1;
    }
  }
  return -1;
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
