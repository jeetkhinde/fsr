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
} from '@kiln/core';
import {
  KilnCache,
  type FsrStore,
  type FsrWatcher,
  bakeSegment,
  assembleFragments,
  hoistHeadTags,
  injectJsonSeed,
  injectKilnScript,
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
}

// ---------------------------------------------------------------------------
// Content-negotiation helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the caller wants raw JSON (data-only) rather than HTML.
 * Two cases:
 *   1. Accept: application/json header (API consumers, fetch calls)
 *   2. Enhanced Silcrow navigation where all layouts are already present on the
 *      client (no wrapping HTML needed, just data hydration)
 */
function wantsJson(req: KilnRequest, layoutPatterns: string[]): boolean {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json')) return true;
  if (req.isEnhanced && layoutPatterns.every(p => req.layoutsPresent.includes(p))) return true;
  return false;
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
  watcher?: FsrWatcher,
) {
  const cache = new KilnCache(cacheOpts);

  return async (req: KilnRequest, res: KilnResponse) => {
    // Wire prebakeNext as fire-and-forget prefetch for subsequent routes
    if (typeof req.prebakeNext === 'function') {
      const originalPrebake = req.prebakeNext;
      req.prebakeNext = (nextPath: string) => {
        // Fire and forget — no await
        try { originalPrebake(nextPath); } catch { /* ignore */ }
      };
    }

    // 1. Resolve layout patterns for content negotiation
    const layoutPatterns = pageMeta.layouts.map(layoutPath => {
      const node = layoutNodes.find(l => l.filePath === layoutPath);
      return node ? node.pattern : '/';
    });

    let pageProps: any = {};
    let pagePropsLoaded = false;
    const loadPageProps = async () => {
      if (pagePropsLoaded) return pageProps;
      pagePropsLoaded = true;
      if (typeof module.load !== 'function') return pageProps;
      try {
        pageProps = await module.load(req);
        assertEmbeddedLiveLists(pageProps, kilnConfig);
        pageProps = await materializeLiveLists(pageProps, store);
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
    if (wantsJson(req, layoutPatterns)) {
      const data = await loadPageProps();
      if (data === null) return;
      res.json(data);
      return;
    }

    // 3. HTML cache check
    const cachedHtml = await cache.getHtml(req.path);
    if (cachedHtml) {
      if (kilnConfig?.fsr?.watcher === 'external') {
        const loaded = await loadPageProps();
        if (loaded === null) return;
      }
      if (!watcher || watcher.hasRegisteredRoute(req.path)) {
        res.html(cachedHtml);
        return;
      }
      const loaded = await loadPageProps();
      if (loaded === null) return;
      if (!hasLiveLists(loaded)) {
        res.html(cachedHtml);
        return;
      }
    }

    // 4. Resolve layout nodes with their modules
    const layoutEntries = await Promise.all(
      pageMeta.layouts.map(async layoutPath => {
        const node = layoutNodes.find(l => l.filePath === layoutPath);
        const absolutePath = path.resolve(layoutPath);
        const layoutModule = await import(pathToFileURL(absolutePath).href);
        return { node, module: layoutModule };
      })
    );

    // 5. Parallel load: all layout loads + page load
    const layoutPropsArr: any[] = new Array(layoutEntries.length).fill({});
    let aborted = false;

    await Promise.all([
      // Page load
      (async () => {
        const loaded = await loadPageProps();
        if (loaded === null) aborted = true;
      })(),
      // Layout loads
      ...layoutEntries.map(async ({ node, module: lMod }, idx) => {
        if (node?.hasLoad && typeof lMod.load === 'function') {
          try {
            layoutPropsArr[idx] = await lMod.load(req);
          } catch {
            layoutPropsArr[idx] = {};
          }
        }
      }),
    ]);

    if (aborted) return;

    // 6. Bake all segments in parallel
    const pageComponent = module.default;

    const [pageBaked, ...layoutBaked] = await Promise.all([
      bakeSegment(pageComponent, pageProps, false),
      ...layoutEntries.map(({ module: lMod }, idx) =>
        bakeSegment(lMod.default, layoutPropsArr[idx], true)
      ),
    ]);

    // 7. Assemble: layouts[0] is outermost, each contains OUTLET_TOKEN
    const layoutHtmls = layoutBaked.map(b => b.html);
    let html = assembleFragments(layoutHtmls, pageBaked.html);
    html = applyLiveListMarkers(html, pageProps as Record<string, unknown>, req.path);

    // 7b. Hoist React 19 metadata (<title>/<meta>/<link>) from body into <head>
    html = hoistHeadTags(html);

    // 8. Inject JSON seed before </body>
    html = injectJsonSeed(html, pageProps as Record<string, unknown>);

    // 9. Optionally inject Kiln client script
    const clientSrc = '/_kiln/client.js';
    html = injectKilnScript(html, clientSrc);

    // 10. Wrap with doctype if it looks like a full page
    const finalHtml = html.startsWith('<html') ? '<!DOCTYPE html>' + html : html;

    // 11. Write to cache if promoteAfter is set (0 = immediate)
    const options = extractPageOptions(module);
    let htmlPath: string | null = null;
    let jsonPath: string | null = null;
    if (options.promoteAfter !== undefined) {
      await cache.setHtml(req.path, finalHtml);
      await cache.setJson(req.path, pageProps);
      htmlPath = cache.diskHtmlPath(req.path);
      jsonPath = cache.diskJsonPath(req.path);
      if (store) {
        await store.ensureRouteRow(req.path, options.promoteAfter);
        await store.incrementHit(req.path);
        await store.setBakedPaths(req.path, htmlPath, jsonPath);
      }
    }

    if (watcher) {
      await registerLiveLists({
        route: req.path,
        pageComponent,
        pageProps,
        finalHtml,
        htmlPath,
        jsonPath,
        watcher,
      });
    }

    // 12. Extract live fields and persist on pageMeta
    const liveFields = extractLiveFields(pageProps);
    pageMeta.liveFields = liveFields;
    pageMeta.promoteAfter = options.promoteAfter;

    res.html(finalHtml);
  };
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
  const manifest = await discoverRoutes(pagesDir, { ignoreGlobs: options.ignoreGlobs ?? [] });

  // 2. Build cache options from config
  const cacheOpts: CacheOptions = {
    redis: null,
    cacheDir: config.cache?.provider === 'filesystem' ? (config.cache.dir ?? '.kiln-cache') : '.kiln-cache',
    ttlSecs: 0,
  };

  // 3. Apply middleware
  adapter.applyMiddleware({
    csrf: true,
    timeoutMs: 30000,
    compression: true,
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
      options.watcher,
    );
    adapter.registerPage(page.pattern, page.layouts, pageHandler);

    if (mod.actions) {
      adapter.registerAction(page.pattern, buildActionHandler(mod.actions));
    }

    // Prebake at startup for pages with hasEntries && promoteAfter === 0
    if (page.hasEntries && page.promoteAfter === 0 && typeof mod.entries === 'function') {
      Promise.resolve().then(async () => {
        try {
          const entries: Record<string, string>[] = await mod.entries();
          const cache = new KilnCache(cacheOpts);
          for (const entry of entries) {
            // Entries provide path param mappings — build the concrete path
            const concretePath = Object.entries(entry).reduce(
              (p, [k, v]) => p.replace(`:${k}`, v),
              page.pattern
            );
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
      }).catch(() => {});
    }
  }

  // 6. Register /_kiln/client.js asset
  try {
    const clientPath = fileURLToPath(import.meta.resolve('@kiln/client/client.js'));
    adapter.registerAsset('/_kiln/client.js', clientPath);
  } catch {
    // @kiln/client not installed
  }

  // 7. Serve Silcrow browser runtime from @kiln/client (always)
  try {
    const silcrowPath = fileURLToPath(import.meta.resolve('@kiln/client/silcrow.js'));
    adapter.registerAsset('/_silcrow/silcrow.js', silcrowPath);
  } catch {
    // @kiln/client not installed
  }

  // 8. Serve FSR live client script when FSR is active
  if (fsrEnabled) {
    adapter.registerPage('/_kiln/live.js', [], async (_req, res) => {
      res.headers['content-type'] = 'application/javascript; charset=utf-8';
      res.html(KILN_LIVE_CLIENT_SCRIPT);
    });
  }

  // 9. Register FSR SSE endpoints
  if (fsrEnabled) {
    adapter.registerSSE('/__kiln/fsr', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrHubStream } = await import('@kiln/engine' as any);
      const stream = fsrHubStream({
        route,
        slots,
        config: {
          maxConnections: config.fsr?.maxSseConnections ?? 1000,
          connectionTtlSecs: config.fsr?.connectionTtlSecs ?? 3600,
          keepaliveSecs: config.fsr?.keepaliveSecs ?? 30,
        },
        watcher: options.watcher,
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
        },
      });
    });
  }

  adapter.registerSSE('/__kiln/live/*', async (_req, res) => {
    res.sse({
      async *[Symbol.asyncIterator]() {
        yield { event: 'ping', data: 'hello' };
      },
    });
  });

  // 10. Register inspect endpoint
  adapter.registerPage('/__kiln/inspect', [], async (_req, res) => {
    res.json({
      pages: manifest.pages.map(p => ({
        pattern: p.pattern,
        layouts: p.layouts,
        hasEntries: p.hasEntries,
        liveFields: p.liveFields,
      })),
      layouts: manifest.layouts.map(l => ({
        pattern: l.pattern,
        hasLoad: l.hasLoad,
      })),
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
    'Live.list requires config.fsr.watcher = "embedded"; external watcher callbacks are not serializable in v1',
  );
}

function hasLiveLists(loadResult: any): boolean {
  return Boolean(
    loadResult &&
      typeof loadResult === 'object' &&
      Object.values(loadResult).some((value) => isLiveList(value)),
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
        keyOf: meta.keyOf,
        query: meta.query,
        renderRows: async (replacementRows) => {
          const replacementProps = {
            ...input.pageProps,
            [name]: cloneLiveListRows(value as LiveList<unknown>, replacementRows),
          };
          const baked = await bakeSegment(input.pageComponent, replacementProps, false);
          const marked = applyLiveListMarkers(baked.html, replacementProps, input.route);
          return extractLiveListRowHtml(marked, name);
        },
      },
      {
        route: input.route,
        name,
        dependsOn: meta.dependsOn,
        rows: snapshotRows,
        htmlPath: input.htmlPath,
        jsonPath: input.jsonPath,
      },
    );
  }
}
