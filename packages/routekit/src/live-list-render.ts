import { getLiveListMeta, isLiveList } from "@kiln/core";

interface ListRenderTarget {
  name: string;
  rows: unknown[];
  keyOf(row: unknown): string;
}

interface Range {
  start: number;
  end: number;
  openEnd: number;
}

export function applyLiveListMarkers(html: string, loadResult: Record<string, unknown>, route?: string): string {
  const targets = extractListTargets(loadResult);
  let result = html;
  const emptyNames: string[] = [];

  for (const target of targets) {
    if (target.rows.length === 0) {
      emptyNames.push(target.name);
      continue;
    }
    result = markList(result, target, route);
  }

  if (emptyNames.length > 0 && route) {
    result = markEmptyListSubscriptions(result, route, emptyNames);
  }

  return result;
}

export function extractLiveListRowHtml(html: string, listName: string): Map<string, string> {
  const result = new Map<string, string>();
  const container = findElementByAttribute(html, "data-kiln-list", listName);
  if (!container) return result;

  const content = html.slice(container.openEnd, container.closeStart);
  let offset = 0;
  while (offset < content.length) {
    const row = findElementByAttribute(content, "data-kiln-key", undefined, offset);
    if (!row) break;
    const openTag = content.slice(row.start, row.openEnd);
    const key = readAttribute(openTag, "data-kiln-key");
    if (key !== null) {
      result.set(key, content.slice(row.start, row.end));
    }
    offset = row.end;
  }
  return result;
}

function extractListTargets(loadResult: Record<string, unknown>): ListRenderTarget[] {
  const targets: ListRenderTarget[] = [];
  for (const [name, value] of Object.entries(loadResult ?? {})) {
    if (!isLiveList(value)) continue;
    const meta = getLiveListMeta(value);
    if (!meta) continue;
    targets.push({
      name,
      rows: value as unknown[],
      keyOf: (row) => meta.keyOf(row),
    });
  }
  return targets;
}

function markList(html: string, target: ListRenderTarget, route?: string): string {
  const rowMatches: { row: unknown; range: Range }[] = [];
  let searchFrom = 0;
  for (const row of target.rows) {
    const range = findMatchingRow(html, row, searchFrom);
    if (!range) return html;
    rowMatches.push({ row, range });
    searchFrom = range.end;
  }

  let result = html;
  for (const match of [...rowMatches].reverse()) {
    const markedRow = markRowFields(
      addAttribute(result.slice(match.range.start, match.range.end), "data-kiln-key", target.keyOf(match.row)),
      match.row,
    );
    result = result.slice(0, match.range.start) + markedRow + result.slice(match.range.end);
  }

  const firstRowStart = rowMatches[0].range.start;
  const listOpen = findNearestOpenTag(result, "ul", firstRowStart) ?? findNearestOpenTag(result, "ol", firstRowStart);
  if (!listOpen || result.slice(listOpen.start, listOpen.openEnd).includes("data-kiln-list=")) {
    return result;
  }

  let markedOpen = addAttribute(result.slice(listOpen.start, listOpen.openEnd), "data-kiln-list", target.name);
  if (route) {
    markedOpen = addAttribute(markedOpen, "data-kiln-live", route);
  }
  return result.slice(0, listOpen.start) + markedOpen + result.slice(listOpen.openEnd);
}

function markEmptyListSubscriptions(html: string, route: string, names: string[]): string {
  const bodyMatch = /<body\b[^>]*>/i.exec(html);
  const rootMatch = bodyMatch ?? /<[A-Za-z][A-Za-z0-9:-]*\b[^>]*>/.exec(html);
  if (!rootMatch || rootMatch.index === undefined) return html;

  let openTag = rootMatch[0];
  openTag = addAttribute(openTag, "data-kiln-live", route);
  const existing = readAttribute(openTag, "data-kiln-live-lists");
  const merged = Array.from(new Set([
    ...(existing ? existing.split(",").filter(Boolean) : []),
    ...names,
  ]));
  if (existing === null) {
    openTag = addAttribute(openTag, "data-kiln-live-lists", merged.join(","));
  } else {
    openTag = openTag.replace(
      /data-kiln-live-lists="[^"]*"/,
      `data-kiln-live-lists="${escapeAttr(merged.join(","))}"`,
    );
  }
  return html.slice(0, rootMatch.index) + openTag + html.slice(rootMatch.index + rootMatch[0].length);
}

function findMatchingRow(html: string, row: unknown, offset: number): Range | null {
  const expectedValues = rowTextValues(row);
  if (expectedValues.length === 0) return null;

  let pos = offset;
  while (pos < html.length) {
    const range = findNextElement(html, "li", pos);
    if (!range) return null;
    const rowHtml = html.slice(range.start, range.end);
    if (expectedValues.every((value) => rowHtml.includes(escapeHtml(value)))) {
      return range;
    }
    pos = range.end;
  }
  return null;
}

function markRowFields(rowHtml: string, row: unknown): string {
  if (!isRecord(row)) return rowHtml;
  let result = rowHtml;
  for (const [field, value] of Object.entries(row)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const escaped = escapeHtml(String(value));
    result = result.replace(
      new RegExp(`<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>${escapeRegExp(escaped)}</\\1>`, "u"),
      (source, tag, attrs) => {
        if (String(attrs).includes("data-kiln-field=")) return source;
        return `<${tag}${attrs} data-kiln-field="${escapeAttr(field)}" data-kiln-live-field="${escapeAttr(field)}">${escaped}</${tag}>`;
      },
    );
  }
  return result;
}

function rowTextValues(row: unknown): string[] {
  if (!isRecord(row)) return [];
  return Object.entries(row)
    .filter(([, value]) => typeof value === "string")
    .map(([, value]) => String(value));
}

function findNextElement(html: string, tagName: string, offset: number): Range | null {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  open.lastIndex = offset;
  const match = open.exec(html);
  if (!match) return null;
  const start = match.index;
  const openEnd = start + match[0].length;

  // Depth-track instead of a naive indexOf for the closing tag, so a
  // same-tag element nested inside doesn't cause this element's range to
  // end at the *inner* close tag.
  const tag = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tag.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return { start, openEnd, end: tag.lastIndex };
    }
  }
  return null;
}

function findNearestOpenTag(html: string, tagName: string, before: number): Range | null {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  let last: Range | null = null;
  while ((match = open.exec(html))) {
    if (match.index >= before) break;
    last = { start: match.index, openEnd: match.index + match[0].length, end: match.index + match[0].length };
  }
  return last;
}

interface AttributeElementRange {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
}

function findElementByAttribute(
  html: string,
  attrName: string,
  attrValue?: string,
  offset = 0,
): AttributeElementRange | null {
  const attrPattern = attrValue === undefined
    ? new RegExp(`${escapeRegExp(attrName)}="[^"]*"`, "g")
    : new RegExp(`${escapeRegExp(attrName)}="${escapeRegExp(escapeAttr(attrValue))}"`, "g");
  attrPattern.lastIndex = offset;
  const attrMatch = attrPattern.exec(html);
  if (!attrMatch) return null;

  const start = html.lastIndexOf("<", attrMatch.index);
  const openEndIndex = html.indexOf(">", attrMatch.index);
  if (start === -1 || openEndIndex === -1) return null;
  const openEnd = openEndIndex + 1;
  const tagName = html.slice(start + 1, openEndIndex).match(/^([A-Za-z][A-Za-z0-9:-]*)/)?.[1];
  if (!tagName) return null;

  const closeStart = findClosingTag(html, tagName, openEnd);
  if (closeStart === -1) return null;
  const closeEnd = html.indexOf(">", closeStart);
  if (closeEnd === -1) return null;
  return { start, openEnd, closeStart, end: closeEnd + 1 };
}

function findClosingTag(html: string, tagName: string, offset: number): number {
  const pattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  pattern.lastIndex = offset;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (!match[0].endsWith("/>")) {
      depth += 1;
    }
  }
  return -1;
}

function readAttribute(openTag: string, name: string): string | null {
  const value = openTag.match(new RegExp(`${escapeRegExp(name)}="([^"]*)"`))?.[1];
  if (value === undefined) return null;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function addAttribute(openTagOrElement: string, name: string, value: string): string {
  const openEnd = openTagOrElement.indexOf(">");
  if (openEnd === -1 || openTagOrElement.slice(0, openEnd).includes(`${name}=`)) return openTagOrElement;
  return openTagOrElement.slice(0, openEnd) + ` ${name}="${escapeAttr(value)}"` + openTagOrElement.slice(openEnd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
