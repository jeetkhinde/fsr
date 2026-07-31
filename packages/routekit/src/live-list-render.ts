import { getLiveListMeta, isLiveList } from "@kiln/core";
import type { LiveListDelivery } from "@kiln/live";
import { warnOnce } from "./dedup.js";

interface ListRenderTarget {
  name: string;
  rows: unknown[];
  delivery: LiveListDelivery;
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
  // Lists the client must subscribe to even though no [data-kiln-list]
  // element will carry the name: a list that rendered no rows, and a
  // store-delivered list, which is deliberately never marked.
  const subscribeOnlyNames: string[] = [];
  const storeNames: string[] = [];

  for (const target of targets) {
    if (target.delivery !== 'dom') storeNames.push(target.name);
    // A store-delivered list's rows are the island's to render; marking them
    // would invite silcrow to patch DOM React owns.
    if (target.delivery === 'store' || target.rows.length === 0) {
      subscribeOnlyNames.push(target.name);
      continue;
    }
    result = markList(result, target, route);
  }

  if ((subscribeOnlyNames.length > 0 || storeNames.length > 0) && route) {
    result = markRootListSubscriptions(result, route, subscribeOnlyNames, storeNames);
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
      delivery: meta.target ?? 'dom',
      keyOf: (row) => meta.keyOf(row),
    });
  }
  return targets;
}

/** Rows the app marked itself with data-kiln-row={key}. Returns null when the
 * page uses no markers at all, so the caller falls back to the <li> scan. */
function findMarkedRows(
  html: string,
  target: ListRenderTarget,
): { row: unknown; range: Range }[] | null {
  const byKey = new Map<string, unknown>();
  for (const row of target.rows) byKey.set(target.keyOf(row), row);

  const matches: { row: unknown; range: Range }[] = [];
  let sawMarker = false;
  let offset = 0;

  while (offset < html.length) {
    const found = findElementByAttribute(html, "data-kiln-row", undefined, offset);
    if (!found) break;
    sawMarker = true;
    const key = readAttribute(html.slice(found.start, found.openEnd), "data-kiln-row");
    const row = key === null ? undefined : byKey.get(key);
    if (row !== undefined) {
      matches.push({ row, range: { start: found.start, openEnd: found.openEnd, end: found.end } });
    } else if (key !== null) {
      warnOnce(
        `live-list-row-key:${target.name}:${key}`,
        `[kiln] Live.list "${target.name}" has an element with data-kiln-row="${key}" that matches ` +
          `no row key. The value must equal the list's key(row) — that element will not update.`,
      );
    }
    offset = found.end;
  }

  return sawMarker ? matches : null;
}

function markList(html: string, target: ListRenderTarget, route?: string): string {
  const marked = findMarkedRows(html, target);

  let rowMatches: { row: unknown; range: Range }[];
  if (marked !== null) {
    if (marked.length === 0) return html;
    rowMatches = marked;
  } else {
    rowMatches = [];
    let searchFrom = 0;
    for (const row of target.rows) {
      const range = findMatchingRow(html, row, searchFrom);
      if (!range) return html;
      rowMatches.push({ row, range });
      searchFrom = range.end;
    }
  }

  let result = html;
  for (const match of [...rowMatches].reverse()) {
    const markedRow = markRowFields(
      addAttribute(result.slice(match.range.start, match.range.end), "data-kiln-key", target.keyOf(match.row)),
      match.row,
    );
    result = result.slice(0, match.range.start) + markedRow + result.slice(match.range.end);
  }

  // Explicitly-marked rows can sit in any container, so discover it; the <li>
  // path keeps looking for the ul/ol it has always assumed.
  const firstRowStart = rowMatches[0]!.range.start;
  const listOpen =
    marked !== null
      ? findEnclosingOpenTag(result, firstRowStart)
      : findNearestOpenTag(result, "ul", firstRowStart) ?? findNearestOpenTag(result, "ol", firstRowStart);
  if (!listOpen || result.slice(listOpen.start, listOpen.openEnd).includes("data-kiln-list=")) {
    return result;
  }

  let markedOpen = addAttribute(result.slice(listOpen.start, listOpen.openEnd), "data-kiln-list", target.name);
  if (route) {
    markedOpen = addAttribute(markedOpen, "data-kiln-live", route);
  }
  return result.slice(0, listOpen.start) + markedOpen + result.slice(listOpen.openEnd);
}

function markRootListSubscriptions(
  html: string,
  route: string,
  subscribeOnlyNames: string[],
  storeNames: string[],
): string {
  const bodyMatch = /<body\b[^>]*>/i.exec(html);
  const rootMatch = bodyMatch ?? /<[A-Za-z][A-Za-z0-9:-]*\b[^>]*>/.exec(html);
  if (!rootMatch || rootMatch.index === undefined) return html;

  let openTag = rootMatch[0];
  openTag = addAttribute(openTag, "data-kiln-live", route);
  if (subscribeOnlyNames.length > 0) {
    openTag = mergeNameList(openTag, "data-kiln-live-lists", subscribeOnlyNames);
  }
  // Tells the client which lists to feed into the store — and, just as
  // importantly, which ones must NOT trigger the missing-container reload,
  // since a store-delivered list is never expected to have a container.
  if (storeNames.length > 0) {
    openTag = mergeNameList(openTag, "data-kiln-list-store", storeNames);
  }
  return html.slice(0, rootMatch.index) + openTag + html.slice(rootMatch.index + rootMatch[0].length);
}

function mergeNameList(openTag: string, attribute: string, names: string[]): string {
  const existing = readAttribute(openTag, attribute);
  const merged = Array.from(new Set([
    ...(existing ? existing.split(",").filter(Boolean) : []),
    ...names,
  ]));
  if (existing === null) {
    return addAttribute(openTag, attribute, merged.join(","));
  }
  return openTag.replace(
    new RegExp(`${attribute}="[^"]*"`),
    `${attribute}="${escapeAttr(merged.join(","))}"`,
  );
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

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

/** The innermost element enclosing `index`. Unlike findNearestOpenTag this
 * takes no tag name — an explicitly-marked row can sit inside any container,
 * so the container has to be discovered rather than assumed. Scans forward
 * keeping a stack, which is what makes "innermost still-open" correct. */
export function findEnclosingOpenTag(html: string, index: number): Range | null {
  if (index <= 0) return null;
  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)\b[^>]*?(\/?)>/g;
  const stack: Array<Range & { tagName: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    if (match.index >= index) break;
    const openEnd = match.index + match[0].length;

    const isClosing = match[1] === "/";
    const tagName = match[2]!.toLowerCase();
    const selfClosing = match[3] === "/" || VOID_ELEMENTS.has(tagName);

    if (selfClosing) continue;
    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    stack.push({ start: match.index, openEnd, end: openEnd, tagName });
  }

  const top = stack[stack.length - 1];
  return top ? { start: top.start, openEnd: top.openEnd, end: top.end } : null;
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
