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

    // 2. Content negotiation — JSON shortcut
    if (wantsJson(req)) {
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
    const materialized = cachedHtml ? materializeBakedShell(cachedHtml, cachedSnapshot) : null;
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

    // 5. Parallel load: all layout loads + page load
    const layoutPropsArr: any[] = new Array(layoutEntries.length).fill({});
    const rawLayoutPropsArr: any[] = new Array(layoutEntries.length).fill({});
    let aborted = false;

    await Promise.all([
      // Page load
      (async () => {
        const loaded = await loadPageProps();
        if (loaded === null) aborted = true;
      })(),
      // Layout loads
      ...layoutEntries.map(async ({ node, module: lMod }, idx) => {
        if (typeof lMod.load === 'function') {
          let loaded = await lMod.load(req);
          assertEmbeddedLiveLists(loaded, kilnConfig);
          loaded = await materializeLiveLists(loaded, store);
          rawLayoutPropsArr[idx] = loaded;
          layoutPropsArr[idx] = unwrapLiveProps(loaded);
        }
      })
    ]);

    if (aborted) return;

    // 6. Bake all segments in parallel
    const pageComponent = module.default;

    const [pageBaked, ...layoutBaked] = await Promise.all([
      bakeSegment(pageComponent, pageProps, false),
      ...layoutEntries.map(({ module: lMod }, idx) => bakeSegment(lMod.default, layoutPropsArr[idx], true))
    ]);

    // 7. Assemble: layouts[0] is outermost, each contains OUTLET_TOKEN
    const markedPageHtml = applyLivePropMarkers(
      applyLiveListMarkers(pageBaked.html, rawPageProps, req.path),
      rawPageProps,
    );
    const pageFragment = wrapPageSegment(pageMeta.pattern, markedPageHtml);
    let html = pageFragment;
    for (let index = layoutBaked.length - 1; index >= 0; index--) {
      const layoutRoute = layoutPatterns[index] ?? '/';
      const markedLayoutHtml = applyLivePropMarkers(
        applyLiveListMarkers(
          layoutBaked[index].html,
          rawLayoutPropsArr[index],
          layoutRoute,
        ),
        rawLayoutPropsArr[index],
      );
      html = materializeLayoutSegment(
        layoutRoute,
        markedLayoutHtml,
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

    // A. Eagerly save generic shell (once per pattern)
    await cache.saveGenericShell(pageMeta.pattern, finalHtml);

    // B. Eagerly save JSON (once per concrete route)
    const existingJson = await cache.getJson(req.path);
    if (!existingJson) {
      await cache.setJson(req.path, createBakedSnapshot(snapshotProps));
      jsonPath = cache.diskJsonPath(req.path);
      if (store) {
        await store.setBakedPaths(req.path, null, jsonPath);
      }
    } else {
      jsonPath = cache.diskJsonPath(req.path);
    }

    // C. Save Fully Baked HTML if promoted
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
          htmlPath: cache.diskHtmlPath(layoutRoute),
          jsonPath: cache.diskJsonPath(layoutRoute),
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

    respondWithNavigationShape(res, req, layoutPatterns, pageMeta.pattern, finalHtml, pageFragment);
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
  renderedPageFragment?: string,
): void {
  if (!req.isEnhanced) {
    res.html(html);
    return;
  }

  const deepestPresent = [...layoutPatterns]
    .reverse()
    .find((pattern) => req.layoutsPresent.includes(pattern));
  if (!deepestPresent) {
    res.headers['silcrow-full-reload'] = 'true';
    res.html(html);
    return;
  }

  const fragmentBody = renderedPageFragment ?? extractLayoutFragment(html, pagePattern) ?? html;
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

function applyLivePropMarkers(html: string, props: Record<string, unknown>): string {
  let result = html;
  for (const [name, raw] of Object.entries(props ?? {})) {
    if (!(raw instanceof LiveProp) && (raw as any)?.constructor?.name !== 'LiveProp') continue;
    const value = (raw as LiveProp<unknown>).value;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const text = escapeHtml(String(value));
    if (result.includes(`s-live="${escapeAttribute(name)}"`)) continue;
    result = result.replace(text, `<span s-live="${escapeAttribute(name)}">${text}</span>`);
  }
  return result;
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
