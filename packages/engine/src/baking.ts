import { applyScalarPatchToHtml, createScalarPatch } from '@kiln/live';
import { applyListPatchToHtml } from '@kiln/live';
import { toScriptJson } from './assembler.js';

export const BAKED_SNAPSHOT_VERSION = 1;
// 2: island markers (data-kiln-island) may exist in shells (ADR-014).
// 3: layout markers renamed data-ps-layout → data-kiln-layout — old shells
//    would break fragment extraction and enhanced navigation.
// normalizeSnapshot rejects older versions, forcing a clean re-bake on the
// first request after deploy.
export const BAKED_RENDER_VERSION = 3;

export interface BakedSnapshot {
  schemaVersion: number;
  renderVersion: number;
  data: Record<string, unknown>;
  lists?: Record<string, Array<{ key: string; html: string }>>;
  updatedAt: string;
  /**
   * Fingerprint of the layout-pattern cache entries this page's shell was
   * assembled from at bake time (see boot.ts's computeLayoutSignature).
   * Only set on page-level snapshots that have layouts. Lets a promoted
   * page's cached shell detect that one of its layouts has since been
   * invalidated/re-baked (e.g. a deploy changed shared header/footer code)
   * even though the page's OWN data snapshot is unchanged — without this,
   * a promoted route would keep serving stale layout chrome forever, since
   * its full-page cache is otherwise never revisited once promoted.
   */
  layoutSignature?: string;
}

export function createBakedSnapshot(
  data: Record<string, unknown>,
  lists?: BakedSnapshot['lists'],
  layoutSignature?: string,
): BakedSnapshot {
  return {
    schemaVersion: BAKED_SNAPSHOT_VERSION,
    renderVersion: BAKED_RENDER_VERSION,
    data,
    lists,
    updatedAt: new Date().toISOString(),
    layoutSignature,
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
      // Function replacement so "$" sequences in the JSON are inert, and
      // toScriptJson so patched values can't break out of the script tag.
      result = result.replace(
        seedMatch[0],
        () => `<script>window.__kiln_seed=${toScriptJson(seed)}</script>`
      );
    } catch (e) {}
  }

  return result;
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
