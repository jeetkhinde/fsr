import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
import { applyLiveListMarkers, extractLiveListRowHtml } from './live-list-render.js';

import { discoverRoutes } from './discover.js';
import { extractPageOptions, extractLiveFields } from './page-options.js';
import type { PageRoute, LayoutNode } from './manifest.js';
import type {
  KilnRequest,
  KilnResponse,
  KilnConfig,
  ServerAdapter,
} from '@kiln/core';
import {
  cloneLiveListRows,
  getLiveListMeta,
  isLiveList,
  type LiveList,
  LiveProp,
} from '@kiln/core';
import {
  KilnCache,
  type FsrStore,
  type FsrWatcher,
  bakeSegment,
  OUTLET_TOKEN,
  createBakedSnapshot,
  hoistHeadTags,
  injectJsonSeed,
  injectKilnScript,
  materializeBakedShell,
} from '@kiln/engine';

// ---------------------------------------------------------------------------
// Legacy FSR script injection (kept for backward compat)
// ---------------------------------------------------------------------------

const FSR_SCRIPT_TAG = '<script src="/_kiln/live.js" defer></script>';

/** Insert the FSR client script tag before </head>, or append if no </head>. */
export function injectFsrScriptTag(html: string): string {
  const headEnd = html.indexOf('</head>');
  if (headEnd !== -1) {
    return html.slice(0, headEnd) + FSR_SCRIPT_TAG + html.slice(headEnd);
  }
  return html + FSR_SCRIPT_TAG;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CacheOptions {
  redis: any | null;
  cacheDir: string;
  ttlSecs: number;
}

export interface StartKilnOptions {
  ignoreGlobs?: string[];
  fsr?: boolean;
  promoteAfter?: number;
  store?: FsrStore;
  watcher?: FsrWatcher;
  redis?: { getClient(): any };
}

// ---------------------------------------------------------------------------
// Content-negotiation helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the caller wants raw JSON (data-only) rather than HTML.
 * JSON is only returned when explicitly requested. Enhanced navigation uses
 * layout-aware HTML fragments so the existing layout DOM remains mounted.
 */
function wantsJson(req: KilnRequest): boolean {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return false;
  return accept.includes('application/json');
}

// ---------------------------------------------------------------------------
// Layout signature — lets a promoted page's cached shell detect that one of
// its layouts has since been invalidated (see BakedSnapshot.layoutSignature
// for the full rationale). Reads the SAME cache entries `deleteLayout()`
// removes, so it's always consistent with the pattern-level layout cache.
// ---------------------------------------------------------------------------

async function computeLayoutSignature(patterns: string[], cache: KilnCache): Promise<string> {
  const htmls = await Promise.all(patterns.map((p) => cache.getLayoutHtml(p)));
  return htmls
    .map((html, i) => `${patterns[i]}:${html ? Bun.hash(html).toString(36) : 'MISSING'}`)
    .join('|');
}

// ---------------------------------------------------------------------------
// Page handler
// ---------------------------------------------------------------------------

export function buildPageHandler(
  module: any,
  pageMeta: PageRoute,
  layoutNodes: LayoutNode[],
  cacheOpts: CacheOptions,
  kilnConfig?: KilnConfig,
  store?: FsrStore,
  watcher?: FsrWatcher
) {
  const cache = new KilnCache(cacheOpts);
  let localHitCount = 0;
  let locallyPromoted = false;

  return async (req: KilnRequest, res: KilnResponse) => {
    // Wire prebakeNext as fire-and-forget prefetch for subsequent routes
    if (typeof req.prebakeNext === 'function') {
      const originalPrebake = req.prebakeNext;
      req.prebakeNext = (nextPath: string) => {
        // Fire and forget — no await
        try {
          originalPrebake(nextPath);
        } catch {
          /* ignore */
        }
      };
    }

    // 1. Resolve layout patterns for content negotiation
    const layoutPatterns = pageMeta.layouts.map((layoutPath) => {
      const node = layoutNodes.find((l) => l.filePath === layoutPath);
      return node ? node.pattern : '/';
    });
    const options = extractPageOptions(module);
    const promoteAfter = options.promoteAfter ?? kilnConfig?.fsr?.promoteAfterHits ?? 2;
    const revalidate = options.revalidate ?? kilnConfig?.fsr?.revalidateSeconds ?? 300;
    const purgeAfter = options.purgeAfter ?? kilnConfig?.fsr?.purgeAfterSeconds ?? 2_592_000;
    let hitStatus: 'Tombstoned' | 'JustPromoted' | 'Normal' = 'Normal';
    let promoted = false;

    if (store && typeof store.ensureRouteRow === 'function' && typeof store.incrementHit === 'function') {
      await store.ensureRouteRow(
        req.path,
        promoteAfter === false ? null : promoteAfter,
        revalidate === false ? 0 : revalidate,
        purgeAfter,
        options.patchMode
      );
      hitStatus = await store.incrementHit(req.path);
      promoted = hitStatus === 'JustPromoted' || await store.isPromoted?.(req.path) === true;
    } else {
      if (promoteAfter !== false) {
        localHitCount += 1;
        if (!locallyPromoted && localHitCount >= promoteAfter) {
          locallyPromoted = true;
          hitStatus = 'JustPromoted';
        }
        promoted = locallyPromoted;
      }
    }

    let pageProps: any = {};
    let rawPageProps: any = {};
    let pagePropsLoaded = false;
    const loadPageProps = async () => {
      if (pagePropsLoaded) return pageProps;
      pagePropsLoaded = true;
      if (typeof module.load !== 'function') return pageProps;
      try {
        rawPageProps = await module.load(req);
        assertEmbeddedLiveLists(rawPageProps, kilnConfig);
        rawPageProps = await materializeLiveLists(rawPageProps, store);
        pageProps = unwrapLiveProps(rawPageProps);
        return pageProps;
      } catch (err: any) {
        if (err.type === 'Redirect') {
          res.redirect(err.message, err.status);
          return null;
        }
        throw err;
      }
    };

    // 2. Content negotiation — JSON shortcut (explicit header OR page declared json_first)
    if (wantsJson(req) || options.jsonFirst) {
      const data = await loadPageProps();
      if (data === null) return;
      res.json(data);
      return;
    }

    // 3. HTML cache check
    const cachedHtml = promoted ? await cache.getHtml(req.path) : null;
    if (promoted && !cachedHtml) {
      hitStatus = 'JustPromoted';
      promoted = false;
    }
    const cachedSnapshot = cachedHtml ? await cache.getJson(req.path) : null;
    let materialized = cachedHtml ? materializeBakedShell(cachedHtml, cachedSnapshot) : null;

    // A promoted page's cached shell embeds its layouts' HTML as it looked
    // at bake time. If any of those layouts have since been re-baked or
    // invalidated (e.g. cache.deleteLayout() after a deploy), the cached
    // shell is stale even though the page's OWN data snapshot still matches
    // — without this check a promoted route would never notice and would
    // keep serving old header/footer/sidebar chrome indefinitely.
    if (materialized && layoutPatterns.length > 0) {
      const currentSignature = await computeLayoutSignature(layoutPatterns, cache);
      const cachedSignature = (cachedSnapshot as { layoutSignature?: string } | null)?.layoutSignature;
      if (currentSignature !== cachedSignature) {
        materialized = null;
      }
    }

    if (cachedHtml && !materialized) {
      await cache.delete(req.path);
      hitStatus = 'JustPromoted';
      promoted = false;
    }
    if (materialized) {
      if (kilnConfig?.fsr?.watcher === 'external') {
        const loaded = await loadPageProps();
        if (loaded === null) return;
      }
      if (!watcher || watcher.hasRegisteredRoute(req.path)) {
        await store?.touchRoute?.(req.path);
        respondWithNavigationShape(res, req, layoutPatterns, pageMeta.pattern, materialized);
        return;
      }
      const loaded = await loadPageProps();
      if (loaded === null) return;

      const liveFields = extractLiveFields(rawPageProps);
      if (store && watcher && liveFields.length > 0) {
        watcher.registerLoader({
          route: req.path,
          load: async () => {
            const l = typeof module.load === 'function' ? await module.load(req) : {};
            return l as Record<string, unknown>;
          },
        });
      }

      if (!hasLiveLists(rawPageProps) && liveFields.length === 0) {
        await store?.touchRoute?.(req.path);
        respondWithNavigationShape(res, req, layoutPatterns, pageMeta.pattern, materialized);
        return;
      }
    }

    // 4. Resolve layout nodes with their modules
    const layoutEntries = await Promise.all(
      pageMeta.layouts.map(async (layoutPath) => {
        const node = layoutNodes.find((l) => l.filePath === layoutPath);
        const absolutePath = path.resolve(layoutPath);
        const layoutModule = await import(pathToFileURL(absolutePath).href);
        return { node, module: layoutModule };
      })
    );

    // 5. Resolve each layout's baked HTML, and load the page's own props, in
    // parallel. Layouts are cached PER PATTERN (e.g. "/dashboard"), not per
    // concrete route: a layout's load() may only depend on params owned by
    // its own pattern (never req.query, never a descendant page's params —
    // see docs/layout-caching.md), which makes it always safe to bake once
    // and share across every route underneath it. This is what lets a
    // change to shared chrome (header/footer/sidebar) invalidate with a
    // single cache entry instead of requiring every route to re-bake.
    const layoutPropsArr: any[] = new Array(layoutEntries.length).fill({});
    const rawLayoutPropsArr: any[] = new Array(layoutEntries.length).fill({});
    const layoutBaked: { html: string }[] = new Array(layoutEntries.length);
    const layoutFromCache: boolean[] = new Array(layoutEntries.length).fill(false);
    let aborted = false;

    await Promise.all([
      // Page load (always per-request — pages are never pattern-cached)
      (async () => {
        const loaded = await loadPageProps();
        if (loaded === null) aborted = true;
      })(),
      // Layout resolution: reuse the pattern-level cache when present,
      // otherwise load() + bake + populate the cache for next time.
      ...layoutEntries.map(async ({ module: lMod }, idx) => {
        const layoutPattern = layoutPatterns[idx] ?? '/';
        const cachedHtml = await cache.getLayoutHtml(layoutPattern);
        if (cachedHtml) {
          const cachedJson = await cache.getLayoutJson(layoutPattern);
          layoutBaked[idx] = { html: materializeBakedShell(cachedHtml, cachedJson) ?? cachedHtml };
          layoutFromCache[idx] = true;
          // Propagate the cached layout's data into rawLayoutPropsArr/layoutPropsArr
          // too, so the page's own JSON snapshot and __kiln_seed (built below from
          // these arrays) still include this layout's fields even though load()
          // wasn't re-run this request.
          const cachedData = (cachedJson as { data?: Record<string, unknown> } | null)?.data ?? {};
          rawLayoutPropsArr[idx] = cachedData;
          layoutPropsArr[idx] = cachedData;
          return;
        }
        let loaded: any = {};
        if (typeof lMod.load === 'function') {
          loaded = await lMod.load(req);
          assertEmbeddedLiveLists(loaded, kilnConfig);
          loaded = await materializeLiveLists(loaded, store);
        }
        rawLayoutPropsArr[idx] = loaded;
        layoutPropsArr[idx] = unwrapLiveProps(loaded);
        const baked = await bakeSegment(lMod.default, layoutPropsArr[idx], true);
        // Markers must be baked in BEFORE this HTML is cached, so a later
        // cache-hit request (which skips load()/bake entirely) still has the
        // s-live slots materializeBakedShell needs to patch fresh values in.
        const marked = applyLivePropMarkers(
          applyLiveListMarkers(baked.html, loaded, layoutPattern),
          loaded,
        );
        layoutBaked[idx] = { html: marked };
        await cache.setLayoutHtml(layoutPattern, marked);
        await cache.setLayoutJson(layoutPattern, createBakedSnapshot(layoutPropsArr[idx]));
      })
    ]);

    if (aborted) return;

    // 6. Bake the page itself — always per-request/per-route, unlike layouts.
    const pageComponent = module.default;
    const pageBaked = await bakeSegment(pageComponent, pageProps, false);

    // 7. Assemble: layouts[0] is outermost, each contains OUTLET_TOKEN.
    // layoutBaked[i].html already has its markers applied (see step 5) —
    // either just now, or previously when it was written to the layout cache.
    const markedPageHtml = applyLivePropMarkers(
      applyLiveListMarkers(pageBaked.html, rawPageProps, req.path),
      rawPageProps,
    );
    const pageFragment = wrapPageSegment(pageMeta.pattern, markedPageHtml);
    let html = pageFragment;
    for (let index = layoutBaked.length - 1; index >= 0; index--) {
      const layoutRoute = layoutPatterns[index] ?? '/';
      html = materializeLayoutSegment(
        layoutRoute,
        layoutBaked[index].html,
        html,
      );
    }
    const rawSnapshotProps = Object.assign({}, ...rawLayoutPropsArr, rawPageProps);
    const snapshotProps = Object.assign({}, ...layoutPropsArr, pageProps);

    // 7b. Hoist React 19 metadata (<title>/<meta>/<link>) from body into <head>
    html = hoistHeadTags(html);

    // 8. Inject JSON seed before </body>
    html = injectJsonSeed(html, snapshotProps);

    // 9. Optionally inject Kiln client script
    const clientSrc = '/_silcrow/silcrow.js';
    if (!html.includes(`src="${clientSrc}"`)) {
      html = injectKilnScript(html, clientSrc);
    }

    // 10. Wrap with doctype if it looks like a full page
    const finalHtml = html.startsWith('<html') ? '<!DOCTYPE html>' + html : html;

    const pinInRedis = options.pinInRedis ?? false;

    // 11. Caching & Persistence
    let htmlPath: string | null = null;
    let jsonPath: string | null = null;

    // A. Save JSON from this render. A full bake only happens when load()
    // was just re-executed (see step 5 above), so snapshotProps is always
    // the current, authoritative data — it must be written every time, not
    // just the first time. Previously this only wrote JSON when none
    // existed yet; on any later full re-bake (e.g. a route flagged
    // `promoted` whose HTML cache was missing, forcing a fresh load()+bake)
    // the freshly rendered HTML would contain the new value, but the next
    // request would materialize the shell against the *old* cached JSON via
    // materializeBakedShell, silently reverting the value it had just baked.
    const layoutSignature =
      layoutPatterns.length > 0 ? await computeLayoutSignature(layoutPatterns, cache) : undefined;
    await cache.setJson(req.path, createBakedSnapshot(snapshotProps, undefined, layoutSignature));
    jsonPath = cache.diskJsonPath(req.path);
    if (store) {
      await store.setBakedPaths(req.path, null, jsonPath);
    }

    // B. Save Fully Baked HTML if promoted
    if (hitStatus === 'JustPromoted') {
      await cache.setHtml(req.path, finalHtml, pinInRedis);
      htmlPath = cache.diskHtmlPath(req.path);
      if (store) {
        await store.setBakedPaths(req.path, htmlPath, jsonPath);
      }
    }

    if (watcher) {
      await registerLiveLists({
        route: req.path,
        pageComponent,
        pageProps: rawPageProps,
        finalHtml,
        htmlPath,
        jsonPath,
        watcher,
        defaultDebounce: options.debounce ?? kilnConfig?.fsr?.patchDebounceSecs,
        defaultRevalidate: options.revalidate ?? kilnConfig?.fsr?.revalidateSeconds,
      });
      for (let index = 0; index < layoutEntries.length; index++) {
        const layoutRoute = layoutPatterns[index] ?? '/';
        const layoutOptions = extractPageOptions(layoutEntries[index].module);
        await registerLiveLists({
          route: layoutRoute,
          pageComponent: layoutEntries[index].module.default,
          pageProps: rawLayoutPropsArr[index],
          finalHtml,
          htmlPath: cache.diskLayoutHtmlPath(layoutRoute),
          jsonPath: cache.diskLayoutJsonPath(layoutRoute),
          watcher,
          isLayout: true,
          defaultDebounce: layoutOptions.debounce ?? kilnConfig?.fsr?.patchDebounceSecs,
          defaultRevalidate: layoutOptions.revalidate ?? kilnConfig?.fsr?.revalidateSeconds,
        });
      }
    }

    // 12. Extract live fields and persist on pageMeta
    const liveFields = extractLiveFields(rawPageProps);
    if (store && liveFields.length > 0) {
      for (const field of liveFields) {
        await store.upsertSlot(
          req.path,
          field.name,
          null,
          [],
          field.dependsOn ? [field.dependsOn] : [],
          field.debounce ?? options.debounce ?? kilnConfig?.fsr?.patchDebounceSecs,
        );
      }
      watcher?.registerLoader?.({
        route: req.path,
        load: async () => {
          const loaded = typeof module.load === 'function' ? await module.load(req) : {};
          return loaded as Record<string, unknown>;
        },
      });
    }
    pageMeta.liveFields = liveFields;
    pageMeta.promoteAfter = promoteAfter === false ? undefined : promoteAfter;

    // Debug/observability header: which layout patterns were reused from the
    // pattern-level cache this request (vs freshly loaded+baked). Not used by
    // any client logic — purely so this can be verified from the outside.
    const cacheHitPatterns = layoutPatterns.filter((_, i) => layoutFromCache[i]);
    if (cacheHitPatterns.length > 0) {
      res.headers['x-kiln-layout-cache-hit'] = cacheHitPatterns.join(',');
    }

    respondWithNavigationShape(res, req, layoutPatterns, pageMeta.pattern, finalHtml);
  };
}

function wrapPageSegment(pattern: string, html: string): string {
  return `<div data-ps-layout="${escapeAttribute(pattern)}" style="display:contents">${html}</div>`;
}

function materializeLayoutSegment(pattern: string, shell: string, child: string): string {
  const slot = `<div data-ps-slot="${escapeAttribute(pattern)}" style="display:contents">${child}</div>`;
  const rendered = shell.replace(OUTLET_TOKEN, slot);
  if (/^\s*(?:<!DOCTYPE html>)?<html\b/i.test(rendered)) {
    return rendered.replace(
      /<body\b/i,
      `<body data-ps-layout="${escapeAttribute(pattern)}"`,
    );
  }
  return `<div data-ps-layout="${escapeAttribute(pattern)}" style="display:contents">${rendered}</div>`;
}

function respondWithNavigationShape(
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
    res.headers['silcrow-full-reload'] = 'true';
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
  res.headers['content-type'] = 'text/html; x-ps-fragment=1';
  res.html(
    `<div data-ps-slot="${escapeAttribute(deepestPresent)}" style="display:contents">${fragmentBody}</div>`,
  );
}

function extractLayoutFragment(html: string, pattern: string): string | null {
  const marker = `data-ps-layout="${escapeAttribute(pattern)}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.lastIndexOf('<div', markerIndex);
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

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function unwrapLiveProps(input: Record<string, unknown>): Record<string, unknown> {
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
    result = result.replace(text, `<span s-live="${escapeAttribute(name)}">${text}</span>`);
  }
  return result;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

export function buildActionHandler(actions: Record<string, any>) {
  return async (req: KilnRequest, res: KilnResponse) => {
    let actionName = '';
    for (const key of Object.keys(req.query)) {
      if (key.startsWith('/')) {
        actionName = key.slice(1);
        break;
      }
    }

    if (!actionName || !actions[actionName]) {
      res.status = 404;
      res.json({ error: `Action "${actionName}" not found` });
      return;
    }

    try {
      const result = await actions[actionName](req);
      res.json(result || { success: true });
    } catch (err: any) {
      if (err.type === 'Redirect') {
        res.redirect(err.message, err.status);
        return;
      }
      res.status = err.status || 500;
      res.json({ error: err.message || 'Action failed' });
    }
  };
}

// ---------------------------------------------------------------------------
// startKiln
// ---------------------------------------------------------------------------

export async function startKiln(
  adapter: ServerAdapter,
  config: KilnConfig,
  pagesDir: string,
  options: StartKilnOptions = {}
) {
  const fsrEnabled = options.fsr === true || !!options.store || !!options.watcher;
  // 1. Discover routes
  const manifest = await discoverRoutes(pagesDir, {
    ignoreGlobs: options.ignoreGlobs ?? []
  });

  // 2. Build cache options from config
  const cacheOpts: CacheOptions = {
    redis: options.redis?.getClient?.() ?? null,
    cacheDir: config.cache?.provider === 'filesystem' ? (config.cache.dir ?? '.kiln-cache') : '.kiln-cache',
    ttlSecs: 0
  };

  // 3. Apply middleware
  adapter.applyMiddleware({
    csrf: true,
    timeoutMs: 30000,
    compression: true
  });

  // 4. Register /_image endpoint if images config is present
  if ((config as any).images?.enabled) {
    const { buildImageHandler } = await import('./image-handler.js');
    adapter.registerPage('/_image', [], buildImageHandler((config as any).images));
  }

  // 5. Register page routes
  for (const page of manifest.pages) {
    const absolutePagePath = path.resolve(page.filePath);
    const mod = await import(pathToFileURL(absolutePagePath).href);

    const pageHandler = buildPageHandler(
      mod,
      page,
      manifest.layouts,
      cacheOpts,
      config,
      options.store,
      options.watcher
    );
    adapter.registerPage(page.pattern, page.layouts, pageHandler);

    if (mod.actions) {
      adapter.registerAction(page.pattern, buildActionHandler(mod.actions));
    }

    // Prebake at startup for pages with hasEntries && promoteAfter === 0
    if (page.hasEntries && page.promoteAfter === 0 && typeof mod.entries === 'function') {
      Promise.resolve()
        .then(async () => {
          try {
            const entries: Record<string, string>[] = await mod.entries();
            const cache = new KilnCache(cacheOpts);
            for (const entry of entries) {
              // Entries provide path param mappings — build the concrete path
              const concretePath = Object.entries(entry).reduce((p, [k, v]) => p.replace(`:${k}`, v), page.pattern);
              // Skip if already cached
              const existing = await cache.getHtml(concretePath);
              if (!existing) {
                // Warm up: fire a synthetic prebake request
                // (Full bake requires a real req context; we just note intent here)
                await cache.setJson(concretePath, entry);
              }
            }
          } catch {
            // Non-fatal: startup prebake failure
          }
        })
        .catch(() => {});
    }
  }

  // 6. Serve Silcrow browser runtime from @kiln/client (always)
  try {
    const silcrowPath = fileURLToPath(import.meta.resolve('@kiln/client/silcrow.js'));
    adapter.registerAsset('/_silcrow/silcrow.js', silcrowPath);
  } catch {
    // @kiln/client not installed
  }

  // 7. Serve FSR live client script when FSR is active
  if (fsrEnabled) {
    adapter.registerPage('/_kiln/live.js', [], async (_req, res) => {
      res.headers['content-type'] = 'application/javascript; charset=utf-8';
      res.html(KILN_LIVE_CLIENT_SCRIPT);
    });
  }

  // 8. Register FSR SSE endpoints
  if (fsrEnabled) {
    adapter.registerSSE('/__kiln/fsr', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrHubStream } = await import('@kiln/engine' as any);
      const stream = fsrHubStream({
        route,
        slots,
        signal: req.signal,
        config: {
          maxConnections: config.fsr?.maxSseConnections ?? 1000,
          connectionTtlSecs: config.fsr?.connectionTtlSecs ?? 3600,
          keepaliveSecs: config.fsr?.keepaliveSecs ?? 30
        },
        watcher: options.watcher
      });
      res.sse(stream);
    });

    adapter.registerSSE('/__kiln/fsr/snapshot', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrSnapshotHandler } = await import('@kiln/engine' as any);
      const snapshot = await fsrSnapshotHandler(route, slots, options.store);
      res.json(snapshot);
    });
  } else {
    adapter.registerSSE('/__kiln/fsr', async (_req, res) => {
      res.sse({
        async *[Symbol.asyncIterator]() {
          yield { event: 'ping', data: 'hello' };
        }
      });
    });
  }

  adapter.registerSSE('/__kiln/live/*', async (_req, res) => {
    res.sse({
      async *[Symbol.asyncIterator]() {
        yield { event: 'ping', data: 'hello' };
      }
    });
  });

  // 10. Register inspect endpoint
  adapter.registerPage('/__kiln/inspect', [], async (_req, res) => {
    res.json({
      pages: manifest.pages.map((p) => ({
        pattern: p.pattern,
        layouts: p.layouts,
        hasEntries: p.hasEntries,
        liveFields: p.liveFields
      })),
      layouts: manifest.layouts.map((l) => ({
        pattern: l.pattern,
        hasLoad: l.hasLoad
      }))
    });
  });

  // 11. Register /sw.js service worker endpoint if enabled
  if ((config as any).serviceWorker?.enabled) {
    const { generateServiceWorker } = await import('./sw-template.js');
    const swContent = generateServiceWorker((config as any).serviceWorker);
    adapter.registerPage('/sw.js', [], async (_req, res) => {
      res.headers['content-type'] = 'application/javascript; charset=utf-8';
      res.headers['cache-control'] = 'no-cache';
      res.html(swContent);
    });
  }

  return manifest;
}

async function materializeLiveLists(loadResult: any, store?: FsrStore): Promise<any> {
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

function assertEmbeddedLiveLists(loadResult: any, kilnConfig?: KilnConfig): void {
  if (kilnConfig?.fsr?.watcher !== 'external' || !hasLiveLists(loadResult)) return;
  throw new Error(
    'Live.list requires config.fsr.watcher = "embedded"; external watcher callbacks are not serializable in v1'
  );
}

function hasLiveLists(loadResult: any): boolean {
  return Boolean(
    loadResult && typeof loadResult === 'object' && Object.values(loadResult).some((value) => isLiveList(value))
  );
}

async function registerLiveLists(input: {
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
