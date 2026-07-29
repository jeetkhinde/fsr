// Live.list materialization and watcher registration, extracted from boot.ts.
// Everything here is about getting a Live.list from "declared in load()" to
// "registered with the watcher and snapshotted", including the re-render
// callback the watcher invokes to produce replacement row HTML.
import type { KilnConfig } from '@kiln/core';
import {
  cloneLiveListRows,
  getLiveListMeta,
  isLiveList,
  type LiveList,
} from '@kiln/core';
import { bakeSegment, type FsrStore, type FsrWatcher } from '@kiln/engine';
import { applyLiveListMarkers, extractLiveListRowHtml } from './live-list-render.js';
import { unwrapLiveProps } from './html-markers.js';

export async function materializeLiveLists(loadResult: any, store?: FsrStore): Promise<any> {
  if (!loadResult || typeof loadResult !== 'object') return loadResult;
  const next = { ...loadResult };
  for (const [name, value] of Object.entries(loadResult)) {
    if (!isLiveList(value)) continue;
    const meta = getLiveListMeta(value);
    if (!meta) continue;
    if (!store) {
      if ((value as unknown[]).length === 0) {
        throw new Error(`Live.list "${name}" requires an FsrStore to execute its query`);
      }
      continue;
    }
    const rows = await store.executeLiveListQuery(meta.query);
    next[name] = cloneLiveListRows(value as LiveList<unknown>, rows);
  }
  return next;
}

export function assertEmbeddedLiveLists(loadResult: any, kilnConfig?: KilnConfig): void {
  if (kilnConfig?.fsr?.watcher !== 'external' || !hasLiveLists(loadResult)) return;
  // Why this can't work rather than just that it doesn't: a Live.list carries
  // three functions — keyOf, query and the renderRows re-render callback (see
  // registerLiveLists below). An out-of-process watcher would have to CALL
  // them, and closures cannot cross a process boundary; renderRows in
  // particular has to SSR the page component, so it can only run somewhere
  // that has the component graph loaded.
  throw new Error(
    'Live.list requires config.fsr.watcher = "embedded". A live list registers ' +
      'closures (keyOf, query, and a renderRows callback that SSRs the page ' +
      'component); those cannot be serialized to an out-of-process watcher. ' +
      'Use the embedded watcher, or replace the Live.list with scalar ' +
      'Live.value fields, which carry no callbacks.',
  );
}

export function hasLiveLists(loadResult: any): boolean {
  return Boolean(
    loadResult && typeof loadResult === 'object' && Object.values(loadResult).some((value) => isLiveList(value))
  );
}

export async function registerLiveLists(input: {
  route: string;
  pageComponent: any;
  pageProps: Record<string, unknown>;
  finalHtml: string;
  htmlPath: string | null;
  jsonPath: string | null;
  watcher: FsrWatcher;
  isLayout?: boolean;
  defaultDebounce?: number;
  defaultRevalidate?: number | false;
}): Promise<void> {
  for (const [name, value] of Object.entries(input.pageProps)) {
    if (!isLiveList(value)) continue;
    const meta = getLiveListMeta(value);
    if (!meta) continue;
    const rows = value as unknown[];
    const rendered = extractLiveListRowHtml(input.finalHtml, name);
    const snapshotRows = rows.map((row) => {
      const key = meta.keyOf(row);
      const html = rendered.get(key);
      if (html === undefined) {
        throw new Error(`Live.list "${name}" did not render keyed HTML for row "${key}"`);
      }
      return { key, data: row, html };
    });

    await input.watcher.registerLiveList(
      {
        route: input.route,
        name,
        dependsOn: meta.dependsOn,
        debounce: meta.debounce ?? input.defaultDebounce,
        revalidate: meta.revalidate ?? input.defaultRevalidate,
        keyOf: meta.keyOf,
        query: meta.query,
        renderRows: async (replacementRows) => {
          const replacementProps = unwrapLiveProps({
            ...input.pageProps,
            [name]: cloneLiveListRows(value as LiveList<unknown>, replacementRows),
          });
          const baked = await bakeSegment(input.pageComponent, replacementProps, input.isLayout ?? false);
          const marked = applyLiveListMarkers(baked.html, replacementProps, input.route);
          return extractLiveListRowHtml(marked, name);
        }
      },
      {
        route: input.route,
        name,
        dependsOn: meta.dependsOn,
        debounceSecs: meta.debounce ?? input.defaultDebounce,
        revalidateSecs: meta.revalidate ?? input.defaultRevalidate,
        rows: snapshotRows,
        htmlPath: input.htmlPath,
        jsonPath: input.jsonPath
      }
    );
  }
}
