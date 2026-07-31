// HTML marker and fragment manipulation, extracted from boot.ts. Pure string
// work: no I/O, no config, no cache. The one exception is
// respondWithNavigationShape, which writes a KilnResponse — it lives here
// because it exists only to slice the marked-up HTML these functions produce.
import type { KilnRequest, KilnResponse } from '@kiln/core';
import { LiveProp } from '@kiln/core';
import { OUTLET_TOKEN } from '@kiln/engine';
import { warnOnce } from './dedup.js';

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function wrapPageSegment(
  pattern: string,
  html: string,
  live?: { route: string; storeFields: string[] } | null,
): string {
  let attrs = `data-kiln-layout="${escapeAttribute(pattern)}"`;
  if (live) {
    attrs += ` data-kiln-live="${escapeAttribute(live.route)}"`;
    if (live.storeFields.length > 0) {
      attrs += ` data-kiln-live-store="${escapeAttribute(live.storeFields.join(','))}"`;
    }
  }
  return `<div ${attrs} style="display:contents">${html}</div>`;
}

export function materializeLayoutSegment(pattern: string, shell: string, child: string): string {
  const slot = `<div data-ps-slot="${escapeAttribute(pattern)}" style="display:contents">${child}</div>`;
  const rendered = shell.replace(OUTLET_TOKEN, slot);
  if (/^\s*(?:<!DOCTYPE html>)?<html\b/i.test(rendered)) {
    return rendered.replace(
      /<body\b/i,
      `<body data-kiln-layout="${escapeAttribute(pattern)}"`,
    );
  }
  return `<div data-kiln-layout="${escapeAttribute(pattern)}" style="display:contents">${rendered}</div>`;
}

export function respondWithNavigationShape(
  res: KilnResponse,
  req: KilnRequest,
  layoutPatterns: string[],
  pagePattern: string,
  html: string,
): void {
  if (!req.isEnhanced) {
    res.html(html);
    return;
  }

  // Find the deepest layout the client already has mounted (walking from
  // innermost to outermost). Layouts strictly deeper than that one — plus
  // the page itself — are what the client is missing and must receive.
  let deepestPresentIndex = -1;
  for (let i = layoutPatterns.length - 1; i >= 0; i--) {
    if (req.layoutsPresent.includes(layoutPatterns[i])) {
      deepestPresentIndex = i;
      break;
    }
  }
  const deepestPresent = deepestPresentIndex >= 0 ? layoutPatterns[deepestPresentIndex] : undefined;
  if (!deepestPresent) {
    res.headers.set('silcrow-full-reload', 'true');
    res.html(html);
    return;
  }

  // Everything strictly deeper than what's already mounted: the next layout
  // in the chain if one exists (e.g. the client has the root and child
  // layout, but not yet the grandchild layout that this page needs), or the
  // bare page fragment if the client already has every layout in the chain
  // (e.g. switching between sibling pages/tabs under the same layout).
  const nextPattern = layoutPatterns[deepestPresentIndex + 1] ?? pagePattern;
  const fragmentBody = extractLayoutFragment(html, nextPattern) ?? html;
  res.headers.set('content-type', 'text/html; x-ps-fragment=1');
  res.html(
    `<div data-ps-slot="${escapeAttribute(deepestPresent)}" style="display:contents">${fragmentBody}</div>`,
  );
}

export function extractLayoutFragment(html: string, pattern: string): string | null {
  const marker = `data-kiln-layout="${escapeAttribute(pattern)}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  return extractBalancedDiv(html, markerIndex);
}

/** From an index inside a div's open tag, return that whole balanced
 * `<div>…</div>` region, or null when the markup never closes it. */
export function extractBalancedDiv(html: string, fromIndex: number): string | null {
  const start = html.lastIndexOf('<div', fromIndex);
  if (start < 0) return null;
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.lastIndex);
  }
  return null;
}

/**
 * ADR-014 I-4: silcrow never patches DOM inside `[data-kiln-island]`, so a
 * dom-target LiveProp slot rendered inside an island would bake fine but
 * silently never update. Warn the developer to use target: 'store' +
 * useLiveValue() instead. Exported for tests.
 */
export function warnDomLiveInsideIslands(html: string, route: string): void {
  const re = /data-kiln-island="([^"]+)"/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const fragment = extractBalancedDiv(html, m.index);
    if (fragment && fragment.includes('s-live="')) {
      warnOnce(
        `island-dom-live:${route}:${m[1]}`,
        `[kiln] route "${route}": island "${m[1]}" contains a dom-target LiveProp slot (s-live). ` +
          `Silcrow does not patch DOM inside islands — declare the field with target: 'store' and ` +
          `read it with useLiveValue() from @kiln/react.`,
      );
    }
  }
}

export function unwrapLiveProps(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([key, value]) => [
      key,
      value instanceof LiveProp || (value as any)?.constructor?.name === 'LiveProp'
        ? (value as LiveProp<unknown>).value
        : value,
    ]),
  );
}

export function applyLivePropMarkers(html: string, props: Record<string, unknown>): string {
  let result = html;
  for (const [name, raw] of Object.entries(props ?? {})) {
    if (!(raw instanceof LiveProp) && (raw as any)?.constructor?.name !== 'LiveProp') continue;
    // Store-target fields have no DOM slot by design (ADR-014 I-4): their
    // updates flow through the Silcrow store (useLiveValue), and silcrow
    // does not patch DOM inside islands.
    if ((raw as LiveProp<unknown>).deliveryTarget === 'store') continue;
    const value = (raw as LiveProp<unknown>).value;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const text = escapeHtml(String(value));
    if (result.includes(`s-live="${escapeAttribute(name)}"`)) continue;
    if (!text || text.length === 0) continue;

    // Auto-tagging locates the rendered value by plain text search, which is
    // only safe when the text is unambiguous. Two LiveProps rendering the
    // same value (or a value that appears as a substring elsewhere on the
    // page) would otherwise cause the wrong element to be tagged as the live
    // slot, silently mistargeting future patches. Skip (and warn) rather than
    // guess — the developer can add an explicit s-live="name" attribute.
    const occurrences = countOccurrences(result, text);
    if (occurrences === 0) continue;
    if (occurrences > 1) {
      console.warn(
        `[kiln] LiveProp "${name}" (value ${JSON.stringify(String(value))}) appears ${occurrences} times in the ` +
          `rendered HTML; auto-tagging is ambiguous and was skipped. Add an explicit s-live="${name}" attribute ` +
          `in the component to disambiguate.`,
      );
      continue;
    }

    // The single occurrence must be in text position. If it sits inside a
    // tag (e.g. an attribute value), wrapping it in a <span> would produce
    // broken markup — skip and ask for an explicit attribute instead.
    const idx = result.indexOf(text);
    if (result.lastIndexOf('<', idx) > result.lastIndexOf('>', idx)) {
      console.warn(
        `[kiln] LiveProp "${name}" (value ${JSON.stringify(String(value))}) only appears inside a tag/attribute; ` +
          `auto-tagging was skipped. Add an explicit s-live="${name}" attribute in the component.`,
      );
      continue;
    }
    result = result.replace(text, `<span s-live="${escapeAttribute(name)}">${text}</span>`);
  }
  return result;
}

/**
 * Every distinct `s-live="…"` slot name in a rendered document, in source
 * order. Used by the cached-shell path to notice slots the page's own load()
 * does not produce — those come from a layout, whose live registration only
 * happens on a full render.
 */
export function extractLiveSlotNames(html: string | null | undefined): string[] {
  if (!html) return [];
  const names: string[] = [];
  const re = /\ss-live="([^"]*)"/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}
