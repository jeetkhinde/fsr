import { createRequire } from 'module';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';

const appRequire = createRequire(path.resolve(process.cwd(), 'package.json'));
const ReactDOMServer = appRequire('react-dom/server');

import { discoverRoutes } from './discover.js';
import { composeLayoutChain } from './layout-chain.js';
import { extractPageOptions, extractLiveFields } from './page-options.js';
import type { PageRoute, LayoutNode } from './manifest.js';
import type {
  KilnRequest,
  KilnResponse,
  KilnConfig,
  ServerAdapter,
} from '@kiln/core';
import {
  KilnCache,
  bakeSegment,
  assembleFragments,
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
  kilnConfig?: KilnConfig
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

    // 2. Content negotiation — JSON shortcut
    if (wantsJson(req, layoutPatterns)) {
      let data: any = {};
      if (typeof module.load === 'function') {
        try {
          data = await module.load(req);
        } catch (err: any) {
          if (err.type === 'Redirect') {
            res.redirect(err.message, err.status);
            return;
          }
          throw err;
        }
      }
      res.json(data);
      return;
    }

    // 3. HTML cache check
    const cachedHtml = await cache.getHtml(req.path);
    if (cachedHtml) {
      res.html(cachedHtml);
      return;
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
    let pageProps: any = {};
    const layoutPropsArr: any[] = new Array(layoutEntries.length).fill({});

    await Promise.all([
      // Page load
      (async () => {
        if (typeof module.load === 'function') {
          try {
            pageProps = await module.load(req);
          } catch (err: any) {
            if (err.type === 'Redirect') {
              res.redirect(err.message, err.status);
              return;
            }
            throw err;
          }
        }
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

    // 6. Bake all segments in parallel
    const pageComponent = module.default;
    const layoutComponents = layoutEntries.map(({ module: lMod }) => lMod.default);

    const [pageBaked, ...layoutBaked] = await Promise.all([
      bakeSegment(pageComponent, pageProps, false),
      ...layoutEntries.map(({ module: lMod }, idx) =>
        bakeSegment(lMod.default, layoutPropsArr[idx], true)
      ),
    ]);

    // 7. Assemble: layouts[0] is outermost, each contains OUTLET_TOKEN
    const layoutHtmls = layoutBaked.map(b => b.html);
    let html = assembleFragments(layoutHtmls, pageBaked.html);

    // 8. Inject JSON seed before </body>
    html = injectJsonSeed(html, pageProps as Record<string, unknown>);

    // 9. Optionally inject Kiln client script
    const clientSrc = '/_kiln/client.js';
    html = injectKilnScript(html, clientSrc);

    // 10. Wrap with doctype if it looks like a full page
    const finalHtml = html.startsWith('<html') ? '<!DOCTYPE html>' + html : html;

    // 11. Write to cache if promoteAfter is set (0 = immediate)
    const options = extractPageOptions(module);
    if (options.promoteAfter !== undefined) {
      // Fire-and-forget cache write
      Promise.resolve().then(() => cache.setHtml(req.path, finalHtml)).catch(() => {});
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
  // 1. Discover routes
  const manifest = await discoverRoutes(pagesDir, { ignoreGlobs: options.ignoreGlobs ?? [] });

  // 2. Build cache options from config
  const cacheOpts: CacheOptions = {
    redis: null,
    cacheDir: config.cache?.provider === 'disk' ? '.kiln-cache' : '.kiln-cache',
    ttlSecs: 0,
  };

  // 3. Apply middleware
  adapter.applyMiddleware({
    csrf: true,
    timeoutMs: 30000,
    compression: true,
  });

  // 4. Register page routes
  for (const page of manifest.pages) {
    const absolutePagePath = path.resolve(page.filePath);
    const mod = await import(pathToFileURL(absolutePagePath).href);

    const pageHandler = buildPageHandler(mod, page, manifest.layouts, cacheOpts, config);
    adapter.registerPage(page.pattern, page.layouts, pageHandler);

    if (mod.actions) {
      adapter.registerAction(page.pattern, buildActionHandler(mod.actions));
    }

    // Prebake at startup for pages with hasEntries && promoteAfter === 0
    if (page.hasEntries && options.promoteAfter === 0 && typeof mod.entries === 'function') {
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

  // 5. Register /_kiln/client.js asset
  try {
    const clientPath = fileURLToPath(import.meta.resolve('@kiln/client/client.js'));
    adapter.registerAsset('/_kiln/client.js', clientPath);
  } catch {
    // @kiln/client not installed
  }

  // 6. Serve Silcrow browser runtime from @kiln/client (always)
  try {
    const silcrowPath = fileURLToPath(import.meta.resolve('@kiln/client/silcrow.js'));
    adapter.registerAsset('/_silcrow/silcrow.js', silcrowPath);
  } catch {
    // @kiln/client not installed
  }

  // 7. Serve FSR live client script when FSR is active
  if (options.fsr) {
    adapter.registerPage('/_kiln/live.js', [], async (_req, res) => {
      res.headers['content-type'] = 'application/javascript; charset=utf-8';
      res.html(KILN_LIVE_CLIENT_SCRIPT);
    });
  }

  // 8. Register FSR SSE endpoints
  if (options.fsr) {
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
      });
      res.sse(stream);
    });

    adapter.registerSSE('/__kiln/fsr/snapshot', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrSnapshotHandler } = await import('@kiln/engine' as any);
      const snapshot = await fsrSnapshotHandler(route, slots, null);
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

  // 9. Register inspect endpoint
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

  return manifest;
}
