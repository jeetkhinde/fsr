import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
import { makeNoopResponse, makePrebakeRequest } from './loader-request.js';
import { buildPageHandler } from './page-render.js';
import type { CacheOptions, PageErrorFiles } from './handler-types.js';
import { applyLivePropMarkers, escapeAttribute, escapeHtml, extractLayoutFragment, materializeLayoutSegment, respondWithNavigationShape, unwrapLiveProps, warnDomLiveInsideIslands, wrapPageSegment } from './html-markers.js';

import { discoverRoutes } from './discover.js';
import { extractPageOptions, type BakeMode } from './page-options.js';
import type { PageRoute, LayoutNode } from './manifest.js';
import type {
  KilnRequest,
  KilnResponse,
  KilnConfig,
  KilnIdentity,
  ServerAdapter,
} from '@kiln/core';
import { StartupError } from '@kiln/core';
// Server-only subpath: the '@kiln/core' barrel must stay client-bundleable
// (islands import from it), and sql.ts pulls in node:async_hooks + bun.
import { KilnCache, RedisCache, type FsrStore, type FsrWatcher } from '@kiln/engine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StartKilnOptions {
  ignoreGlobs?: string[];
  fsr?: boolean;
  store?: FsrStore;
  watcher?: FsrWatcher;
  redis?: { getClient(): any };
  /** Stable per-user cache key for bake='user' pages. Overrides the app's
   * hooks.ts `identity` export when both are present. */
  identity?: KilnIdentity;
  /** Dev only: upstream URL for the islands manifest (the Vite dev server's
   * /kiln-islands.json). Production reads dist/client/kiln-islands.json. */
  islandsManifestUrl?: string;
}

// buildPageHandler and its helpers (wantsJson, isDormantStale,
// computeLayoutSignature, respondWithErrorPage) moved to ./page-render.js.
// CacheOptions and PageErrorFiles moved to ./handler-types.js.
//
// wrapPageSegment, materializeLayoutSegment, respondWithNavigationShape,
// extractLayoutFragment, extractBalancedDiv, warnDomLiveInsideIslands,
// unwrapLiveProps, applyLivePropMarkers, countOccurrences, escapeAttribute and
// escapeHtml all moved to ./html-markers.js. Re-exported below so `./boot.js`
// keeps the surface its consumers (and boot.test.ts) already import.
export { applyLivePropMarkers, warnDomLiveInsideIslands } from './html-markers.js';
export { buildPageHandler } from './page-render.js';
export type { CacheOptions, PageErrorFiles } from './handler-types.js';

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

export function buildActionHandler(
  actions: Record<string, any>,
  opts?: { cache?: KilnCache; identity?: KilnIdentity; bake?: BakeMode }
) {
  // Read-your-own-writes for bake='user' pages: the actor must see their own
  // write on the redirect GET — racing the watcher's async re-materialization
  // reads as "my click didn't work". Deleting the actor's artifacts forces a
  // fresh render for exactly one user; everyone else updates via the watcher.
  const invalidateActor = async (req: KilnRequest) => {
    if (opts?.bake !== 'user' || !opts.cache || !opts.identity) return;
    const uid = opts.identity(req);
    if (uid) await opts.cache.delete(req.path, `u:${uid}`).catch(() => {});
  };
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
      await invalidateActor(req);
      res.json(result || { success: true });
    } catch (err: any) {
      if (err.type === 'Redirect') {
        await invalidateActor(req);
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

  // Implemented cache storage: disk ('filesystem'), optionally fronted by a
  // Redis hot tier ('redis' provider or fsr.redisUrl). Fail loudly on the
  // providers the config type advertises but the runtime doesn't back,
  // instead of silently writing to disk anyway.
  const provider = config.cache?.provider ?? 'filesystem';
  if (provider === 'memory' || provider === 'sqlite') {
    throw new StartupError(
      'UnsupportedProvider',
      `cache.provider "${provider}" is not implemented; use "filesystem" or "redis"`,
    );
  }

  // 1. Discover routes
  const manifest = await discoverRoutes(pagesDir, {
    ignoreGlobs: options.ignoreGlobs ?? []
  });

  // 2. Build cache options from config
  const cacheRedisUrl = provider === 'redis' ? (config.cache?.url ?? config.fsr?.redisUrl) : config.fsr?.redisUrl;
  const cacheNamespace = config.cache?.namespace;
  const redisClient =
    options.redis?.getClient?.() ??
    (cacheRedisUrl ? new RedisCache(cacheRedisUrl, cacheNamespace).getClient() : null);
  const cacheOpts: CacheOptions = {
    redis: redisClient,
    cacheDir: config.cache?.dir ?? '.kiln-cache',
    // Governs Redis expiry of non-pinned entries — without it, variant keys
    // created by cacheKey pages would accumulate in Redis forever.
    ttlSecs: config.fsr?.artifactTtlSecs ?? 0,
    namespace: cacheNamespace
  };
  const hubCache = new KilnCache(cacheOpts);

  if (options.store && config.fsr?.patchDebounceSecs !== undefined) {
    options.store.withGlobalDebounce(config.fsr.patchDebounceSecs);
  }

  // 3. Apply middleware, then the project's hooks.ts (the per-request `handle`
  // hook plus onError/onStart/onStop) so both cover every route registered
  // below — handle runs inside each route via the adapter's request path.
  adapter.applyMiddleware({
    csrf: true,
    timeoutMs: config.web?.requestTimeoutMs ?? 30000,
    compression: true,
    tracing: config.web?.tracing === true,
    trustProxy: config.web?.trustProxy === true
  });
  const appHooks = await adapter.applyServerHooks?.(process.cwd());
  const identity: KilnIdentity | undefined =
    options.identity ?? (appHooks && typeof appHooks === 'object' ? appHooks.identity : undefined);

  // 4. Register /_image endpoint if images config is present
  if ((config as any).images?.enabled) {
    const { buildImageHandler } = await import('./image-handler.js');
    adapter.registerPage('/_image', [], buildImageHandler((config as any).images));
  }

  // 5. Register page routes
  // Populated below with each page's declared bake mode so the /__kiln/fsr
  // SSE + snapshot handlers can gate identity-scoping on it (Task 8): only
  // bake='user' routes should ever narrow sseUserKey via identity(req) — a
  // shared route (bake 'shared'/'static'/false/default 'auto') must always
  // resolve userKey='' even when an identity hook is configured for other
  // routes in the app, or its shared (userKey='') patches never reach a
  // subscriber whose identity narrowed the key.
  const bakeByPattern = new Map<string, BakeMode | undefined>();
  for (const page of manifest.pages) {
    const absolutePagePath = path.resolve(page.filePath);
    const mod = await import(pathToFileURL(absolutePagePath).href);
    const pageOptions = extractPageOptions(mod);
    bakeByPattern.set(page.pattern, pageOptions.bake);

    const errorFiles: PageErrorFiles = {
      errorFile: nearestSpecialFile(page.relativePath, manifest.errorPages),
      notFoundFile: nearestSpecialFile(page.relativePath, manifest.notFoundPages),
    };

    const pageHandler = buildPageHandler(
      mod,
      page,
      manifest.layouts,
      cacheOpts,
      config,
      options.store,
      options.watcher,
      errorFiles,
      identity
    );
    adapter.registerPage(page.pattern, page.layouts, pageHandler);

    if (mod.actions) {
      adapter.registerAction(
        page.pattern,
        buildActionHandler(mod.actions, {
          cache: new KilnCache(cacheOpts),
          identity,
          bake: pageOptions.bake,
        })
      );
    }

    // SSG: prebake at startup for pages exporting entries() + bake 'static'.
    // Runs the real page handler against a synthetic request so the entry is
    // fully loaded, baked, and cached — identical to what the first live
    // request would have produced.
    if (page.hasEntries && pageOptions.bake === 'static' && typeof mod.entries === 'function') {
      Promise.resolve()
        .then(async () => {
          const entries: Record<string, string>[] = await mod.entries();
          const cache = new KilnCache(cacheOpts);
          for (const entry of entries) {
            // Entries provide path param mappings — build the concrete path
            const concretePath = Object.entries(entry).reduce((p, [k, v]) => p.replace(`:${k}`, v), page.pattern);
            const existing = await cache.getHtml(concretePath);
            if (existing) continue;
            await pageHandler(makePrebakeRequest(concretePath, entry), makeNoopResponse());
          }
        })
        .catch((err) => {
          console.warn(`[kiln] startup prebake failed for ${page.pattern}:`, err?.message ?? err);
        });
    }
  }

  // 6. Serve Silcrow browser runtime from @kiln/client (always)
  try {
    const silcrowPath = fileURLToPath(import.meta.resolve('@kiln/client/silcrow.js'));
    adapter.registerAsset('/_silcrow/silcrow.js', silcrowPath);
  } catch {
    // @kiln/client not installed
  }

  // 6b. Islands bootstrap + manifest (ADR-014). The manifest is served
  // no-store and maps island NAMES to current chunk URLs — cached HTML never
  // embeds URLs, so week-old promoted shells hydrate against today's build.
  try {
    const islandsPath = fileURLToPath(import.meta.resolve('@kiln/client/islands.js'));
    adapter.registerAsset('/_silcrow/islands.js', islandsPath);
  } catch {
    // @kiln/client not installed
  }
  adapter.registerPage('/_kiln/islands.json', [], async (_req, res) => {
    res.headers['cache-control'] = 'no-store';
    // Dev: the CLI points this at the Vite dev server's manifest.
    if (options.islandsManifestUrl) {
      try {
        const upstream = await fetch(options.islandsManifestUrl);
        if (upstream.ok) {
          res.json(await upstream.json());
          return;
        }
      } catch {
        // fall through to dist/empty
      }
    }
    const manifestFile = Bun.file(path.resolve('dist/client/kiln-islands.json'));
    if (await manifestFile.exists()) {
      try {
        res.json(JSON.parse(await manifestFile.text()));
        return;
      } catch {
        // corrupt manifest — treat as absent
      }
    }
    res.json({ version: 'none', islands: {} });
  });

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
      // Resolved from the request's own session — a client cannot subscribe
      // to another user's patch stream because there is nothing to spoof.
      // Gated on the SUBSCRIBED route's own bake mode, not merely whether an
      // identity hook is configured for the app: a shared route must always
      // get userKey='' (the shared row) even when other routes declare
      // bake='user', or its shared patches never reach this subscriber.
      const routeBake = bakeByPattern.get(route);
      const sseUserKey = routeBake === 'user' && identity ? identity(req) ?? '' : '';
      // A subscriber watching this (route, user) snapshot counts as activity
      // — a page someone has open gets eager patches even though nobody is
      // re-requesting it (which is what would otherwise bump last_active_at).
      //
      // This has to REPEAT for as long as the connection lives, not fire once
      // on subscribe: last_active_at only counts as active for
      // activeWindowSecs (default 30s), while a connection lives up to
      // connectionTtlSecs (default 3600s). A single ping would let an open,
      // healthy subscription fall into the dormant tier 30s in, at which
      // point fetchStaleSlots stops claiming its slots and the client simply
      // stops receiving live patches. fsrHubStream owns the repeat (and
      // clears it in its finally), so the timer can't outlive the stream.
      const activeWindowSecs = config.fsr?.activeWindowSecs ?? 30;
      const pingActive = async () => {
        let markedActive = true;
        if (options.store) {
          markedActive = await options.store.markActive(route, sseUserKey)
            .then(() => true)
            .catch((err: any) => {
              console.warn(`FSR SSE: markActive failed for ${route}:`, err?.message ?? err);
              return false;
            });
        }
        // Same-process activity signal (Important #2 review fix): lets the
        // read path's dormant-staleness check (isDormantStale) skip its own
        // Postgres query for a route this process already knows is SSE-active.
        // Only when markActive actually landed — otherwise the watcher's
        // last_active_at gate won't revalidate this route either, and the
        // local mark would suppress the one check that would have caught it.
        if (markedActive) options.watcher?.markLocallyActive?.(route, sseUserKey);
      };
      // The first ping happens here, before handing off: fsrHubStream is an
      // async generator, so nothing inside it runs until the adapter starts
      // iterating the stream. The hub owns only the repeat.
      await pingActive();
      const { fsrHubStream } = await import('@kiln/engine' as any);
      const stream = fsrHubStream({
        route,
        slots,
        userKey: sseUserKey,
        signal: req.signal,
        config: {
          maxConnections: config.fsr?.maxSseConnections ?? 1000,
          connectionTtlSecs: config.fsr?.connectionTtlSecs ?? 3600,
          keepaliveSecs: config.fsr?.keepaliveSecs ?? 30
        },
        watcher: options.watcher,
        cache: hubCache,
        onActivity: () => { void pingActive(); },
        // Refresh at half the window so a ping is never the thing that
        // expires: the mark is at most activeWindowSecs/2 old when read.
        activityPingSecs: Math.max(1, Math.floor(activeWindowSecs / 2)),
      });
      res.sse(stream);
    });

    // JSON endpoint, so it must go through registerPage — registerSSE only
    // forwards SSE bodies and would drop the JSON payload entirely.
    adapter.registerPage('/__kiln/fsr/snapshot', [], async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      // Same bake='user' gate as the SSE handler above — a shared route's
      // snapshot must not be narrowed to the caller's identity.
      const routeBake = bakeByPattern.get(route);
      const snapshotUserKey = routeBake === 'user' && identity ? identity(req) ?? '' : '';
      const { fsrSnapshotHandler } = await import('@kiln/engine' as any);
      const snapshot = await fsrSnapshotHandler(route, slots, options.store, snapshotUserKey);
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

  // 10. Register inspect endpoint — dev/debug only. Exposes the full route
  // manifest (patterns, layouts, live fields), which is reconnaissance data
  // an unauthenticated production endpoint shouldn't hand out.
  adapter.registerPage('/__kiln/inspect', [], async (_req, res) => {
    if (process.env.NODE_ENV === 'production') {
      res.status = 404;
      res.json({ error: 'Not Found' });
      return;
    }
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

/** Walk up from the page's directory to the pages root, returning the first
 * matching special file (_error.tsx / _not-found.tsx) from the manifest. */
function nearestSpecialFile(pageRelPath: string, table: Record<string, string>): string | undefined {
  let dir = path.dirname(pageRelPath);
  while (true) {
    const key = dir === '.' ? '' : dir;
    if (table[key]) return table[key];
    if (key === '') return undefined;
    dir = path.dirname(dir);
  }
}
