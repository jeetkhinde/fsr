import { applyScalarPatchToHtml, createScalarPatch } from '@kiln/live';
import { applyListPatchToHtml } from '@kiln/live';

export const BAKED_SNAPSHOT_VERSION = 1;
export const BAKED_RENDER_VERSION = 1;

export interface BakedSnapshot {
  schemaVersion: number;
  renderVersion: number;
  data: Record<string, unknown>;
  lists?: Record<string, Array<{ key: string; html: string }>>;
  updatedAt: string;
}

export function createBakedSnapshot(
  data: Record<string, unknown>,
  lists?: BakedSnapshot['lists'],
): BakedSnapshot {
  return {
    schemaVersion: BAKED_SNAPSHOT_VERSION,
    renderVersion: BAKED_RENDER_VERSION,
    data,
    lists,
    updatedAt: new Date().toISOString(),
  };
}

export function materializeBakedShell(shell: string, rawSnapshot: unknown): string | null {
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (!snapshot) return null;
  let html = injectFsrSlots(shell, Object.entries(snapshot.data));
  for (const [list, rows] of Object.entries(snapshot.lists ?? {})) {
    for (const row of rows) {
      html = applyListPatchToHtml(html, {
        kind: 'list',
        route: '',
        list,
        key: row.key,
        op: 'replace-row',
        row: null,
        html: row.html,
      });
    }
  }
  return html;
}

function normalizeSnapshot(raw: unknown): BakedSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<BakedSnapshot>;
  if (
    candidate.schemaVersion !== BAKED_SNAPSHOT_VERSION ||
    candidate.renderVersion !== BAKED_RENDER_VERSION ||
    !candidate.data ||
    typeof candidate.data !== 'object'
  ) {
    return null;
  }
  return candidate as BakedSnapshot;
}

export function injectFsrSlots(shell: string, slots: [string, any][]): string {
  let result = shell;
  for (const [slotName, jsonVal] of slots) {
    result = applyScalarPatchToHtml(result, createScalarPatch('', slotName, jsonVal));
  }

  const seedMatch = result.match(/<script>window\.__kiln_seed=(.*?)<\/script>/);
  if (seedMatch) {
    try {
      const seed = JSON.parse(seedMatch[1]);
      for (const [slotName, jsonVal] of slots) {
        seed[slotName] = jsonVal;
      }
      result = result.replace(
        seedMatch[0],
        `<script>window.__kiln_seed=${JSON.stringify(seed)}</script>`
      );
    } catch (e) {}
  }

  return result;
}

export function findSLiveSlots(html: string): string[] {
  const names: string[] = [];
  let remaining = html;
  while (true) {
    const pos = remaining.indexOf('s-live="');
    if (pos === -1) break;
    remaining = remaining.slice(pos + 8);
    const end = remaining.indexOf('"');
    if (end === -1) break;
    const name = remaining.slice(0, end);
    if (name && !names.includes(name)) {
      names.push(name);
    }
    remaining = remaining.slice(end + 1);
  }
  return names;
}

import { renderToReadableStream } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';

export const OUTLET_TOKEN = '__KILN_OUTLET_7f3a9c4b__';

/**
 * Render a React element to an HTML string via the streaming API.
 *
 * Streaming (renderToReadableStream) is used over the legacy renderToString
 * so React 19 hoists document metadata (<title>/<meta>/<link>) and supports
 * Suspense. allReady waits for the full tree (incl. suspended boundaries)
 * before the string is consumed, so the output is complete markup.
 */
async function renderToHtml(element: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return await new Response(stream).text();
}

/**
 * SSR a page/fragment component in isolation (no layout wrapping).
 */
export async function bakeFragment(
  Component: (props: any) => any,
  props: Record<string, any>
): Promise<string> {
  return renderToHtml(createElement(Component, props));
}

/**
 * SSR a layout component with OUTLET_TOKEN as children.
 * The token appears verbatim in the output — replace it at assembly time.
 */
export async function bakeLayoutFragment(
  LayoutComponent: (props: any) => any,
  props: Record<string, any>
): Promise<string> {
  return renderToHtml(createElement(LayoutComponent, props, OUTLET_TOKEN));
}

/**
 * Bake both HTML fragment and JSON for a route segment in one pass.
 */
export async function bakeSegment(
  Component: (props: any) => any,
  props: Record<string, any>,
  isLayout: boolean
): Promise<{ html: string; json: string }> {
  const html = isLayout
    ? await bakeLayoutFragment(Component, props)
    : await bakeFragment(Component, props);
  return { html, json: JSON.stringify(props) };
}
