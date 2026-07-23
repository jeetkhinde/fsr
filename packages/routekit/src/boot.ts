import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
import { applyLiveListMarkers, extractLiveListRowHtml } from './live-list-render.js';

import { discoverRoutes } from './discover.js';
import { extractPageOptions, extractLiveFields } from './page-options.js';
import { createPurityTracker } from './purity.js';
import type { PageRoute, LayoutNode } from './manifest.js';
import type {
  KilnRequest,
  KilnResponse,
  KilnConfig,
  ServerAdapter,
} from '@kiln/core';
import {
  assertSeedSafe,
  cloneLiveListRows,
  getLiveListMeta,
  isLiveList,
  type LiveList,
  LiveProp,
  StartupError,
} from '@kiln/core';
import {
  KilnCache,
  RedisCache,
  type FsrStore,
  type FsrWatcher,
  bakeSegment,
  OUTLET_TOKEN,
  createBakedSnapshot,
  hoistHeadTags,
  injectJsonSeed,
  injectKilnScript,
  injectModuleScript,
  materializeBakedShell,
} from '@kiln/engine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CacheOptions {
  redis: any | null;
  cacheDir: string;
  ttlSecs: number;
  /** See CacheConfig.namespace — prefixes Redis keys/channels `kiln:<ns>:…`. */
  namespace?: string;
}

export interface StartKilnOptions {
  ignoreGlobs?: string[];
  fsr?: boolean;
  store?: FsrStore;
  watcher?: FsrWatcher;
  redis?: { getClient(): any };
  /** Dev only: upstream URL for the islands manifest (the Vite dev server's
   * /kiln-islands.json). Production reads dist/client/kiln-islands.json. */
  islandsManifestUrl?: string;
}

/** Files a page falls back to when its handler throws (nearest _error.tsx /
 * _not-found.tsx up the directory tree, resolved at boot). */
export interface PageErrorFiles {
  errorFile?: string;
  notFoundFile?: string;
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

// Caps process-lifetime dedup Sets (route-ensured markers, one-shot warning
// keys) so a long-running server with high route/key cardinality can't grow
// them without bound. Losing an entry just means the next occurrence does a
// redundant (idempotent) DB write or re-logs a warning — never incorrect.
const DEDUP_SET_MAX = 10_000;
function addBounded(set: Set<string>, key: string): void {
  if (set.size >= DEDUP_SET_MAX) set.clear();
  set.add(key);
}

export function buildPageHandler(
  module: any,
  pageMeta: PageRoute,
  layoutNodes: LayoutNode[],
  cacheOpts: CacheOptions,
  kilnConfig?: KilnConfig,
  store?: FsrStore,
  watcher?: FsrWatcher,
  errorFiles?: PageErrorFiles
) {
  const cache = new KilnCache(cacheOpts);
  // 'auto' routes latch impure for the life of the process the first time a
  // render touches identity; explicit bake modes never latch.
  let knownImpure = false;
  const impureLayouts = new Set<string>();
  // Page options are static per module, so the route row only needs to be
  // (re-)ensured once per process instead of one extra DB write per request.
  const ensuredRoutes = new Set<string>();
  // last_requested_at feeds idle purge only — a 60s resolution is plenty,
  // and it keeps Postgres entirely off the cached read path.
  const lastTouched = new Map<string, number>();
  const TOUCH_INTERVAL_MS = 60_000;
  const touchRoute = (route: string) => {
    if (!store || typeof store.touchRoute !== 'function') return;
    const now = Date.now();
    if (now - (lastTouched.get(route) ?? 0) < TOUCH_INTERVAL_MS) return;
    if (lastTouched.size >= DEDUP_SET_MAX) lastTouched.clear();
    lastTouched.set(route, now);
    void store.touchRoute(route).catch(() => {});
  };

  const handle = async (req: KilnRequest, res: KilnResponse) => {
    // 1. Resolve layout patterns for content negotiation
    const layoutPatterns = pageMeta.layouts.map((layoutPath) => {
      const node = layoutNodes.find((l) => l.filePath === layoutPath);
      return node ? node.pattern : '/';
    });
    const options = extractPageOptions(module);
    const variant = options.cacheKey ? options.cacheKey(req) : undefined;
    const bakeMode = options.bake; // undefined = 'auto'
    const revalidate = options.revalidate ?? kilnConfig?.fsr?.revalidateSeconds ?? 300;
    const purgeAfter = options.purgeAfter ?? kilnConfig?.fsr?.purgeAfterSeconds ?? 2_592_000;
    const bakeEligible = bakeMode !== false && !knownImpure;

    if (store && typeof store.ensureRouteRow === 'function' && !ensuredRoutes.has(req.path)) {
      await store.ensureRouteRow(
        req.path,
        revalidate === false ? 0 : revalidate,
        purgeAfter,
        options.patchMode
      );
      addBounded(ensuredRoutes, req.path);
    }
    // Every request path — cached AND rendered — must refresh recency, or an
    // actively-served pure-SSR route would look idle and get purged after
    // purge_after_secs (ensureRouteRow's ON CONFLICT deliberately does not
    // update last_requested_at, and it only runs once per process anyway).
    // The 60s throttle keeps this to at most one UPDATE per route per minute.
    touchRoute(req.path);

    let pageProps: any = {};
    let rawPageProps: any = {};
    let pagePropsLoaded = false;
    let renderPure = true;
    const loadPageProps = async () => {
      if (pagePropsLoaded) return pageProps;
      pagePropsLoaded = true;
      if (typeof module.load !== 'function') return pageProps;
      try {
        const tracker = createPurityTracker(req);
        rawPageProps = await module.load(tracker.proxied);
        if (tracker.identityAccessed()) renderPure = false;
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

    // 3. HTML cache check — artifact presence IS promotion.
    const cachedHtml = bakeEligible ? await cache.getHtml(req.path, variant) : null;
    const cachedSnapshot = cachedHtml ? await cache.getJson(req.path, variant) : null;
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
      // Corrupt or layout-stale artifact: drop it and fall through to a
      // fresh render, which re-bakes in step 11.
      await cache.delete(req.path, variant);
    }
    if (materialized) {
      if (kilnConfig?.fsr?.watcher === 'external') {
        const loaded = await loadPageProps();
        if (loaded === null) return;
      }
      if (!watcher || watcher.hasRegisteredRoute(req.path)) {
        respondWithNavigationShape(res, req, layoutPatterns, pageMeta.pattern, materialized);
        return;
      }
      const loaded = await loadPageProps();
      if (loaded === null) return;

      const liveFields = extractLiveFields(rawPageProps);
      if (store && watcher && liveFields.length > 0 && !variant) {
        const loaderReq = makeLoaderRequest(req);
        watcher.registerLoader({
          route: req.path,
          load: async () => {
            const l = typeof module.load === 'function' ? await module.load(loaderReq) : {};
            return l as Record<string, unknown>;
          },
        });
      }

      if (!hasLiveLists(rawPageProps) && liveFields.length === 0) {
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
    // An impure layout's HTML gets embedded in the page shell, so it must
    // block the PAGE's bake too, not just its own pattern-cache entry.
    let anyLayoutImpure = false;
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
        const cachedHtml = impureLayouts.has(layoutPattern)
          ? null
          : await cache.getLayoutHtml(layoutPattern);
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
        let layoutPure = true;
        if (typeof lMod.load === 'function') {
          const tracker = createPurityTracker(req);
          loaded = await lMod.load(tracker.proxied);
          layoutPure = !tracker.identityAccessed();
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
        if (layoutPure) {
          await cache.setLayoutHtml(layoutPattern, marked);
          await cache.setLayoutJson(layoutPattern, createBakedSnapshot(layoutPropsArr[idx]));
        } else {
          anyLayoutImpure = true;
          if (!impureLayouts.has(layoutPattern)) {
            impureLayouts.add(layoutPattern);
            // Self-heal: nuke any artifact a previously-pure version left behind.
            await cache.deleteLayout(layoutPattern);
          }
        }
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
    if (markedPageHtml.includes('data-kiln-island')) {
      warnDomLiveInsideIslands(markedPageHtml, req.path);
    }
    // Pages with live fields must tell the client to open the /__kiln/fsr
    // SSE subscription — silcrow only connects for [data-kiln-live]
    // containers. Store-target fields have no DOM slot to discover, so
    // their names ride along in data-kiln-live-store (the store bridge that
    // feeds useLiveValue inside islands). Baked into the shell, so cached
    // promoted pages subscribe too.
    const pageLiveFields = extractLiveFields(rawPageProps);
    const pageFragment = wrapPageSegment(
      pageMeta.pattern,
      markedPageHtml,
      pageLiveFields.length > 0 || hasLiveLists(rawPageProps)
        ? {
            route: req.path,
            storeFields: pageLiveFields
              .filter((f) => f.deliveryTarget === 'store' || f.deliveryTarget === 'dom-and-store')
              .map((f) => f.name),
          }
        : null,
    );
    let html = pageFragment;
    for (let index = layoutBaked.length - 1; index >= 0; index--) {
      const layoutRoute = layoutPatterns[index] ?? '/';
      html = materializeLayoutSegment(
        layoutRoute,
        layoutBaked[index].html,
        html,
      );
    }
    const snapshotProps = Object.assign({}, ...layoutPropsArr, pageProps);

    // 7b. Hoist React 19 metadata (<title>/<meta>/<link>) from body into <head>
    html = hoistHeadTags(html);

    // 8. Inject JSON seed before </body>. In dev, warn about values the JSON
    // codec silently corrupts (Date/Map/undefined/...) — islands and clients
    // would otherwise hydrate with different data than the server rendered.
    if (process.env.NODE_ENV !== 'production') {
      assertSeedSafe(snapshotProps, req.path);
    }
    html = injectJsonSeed(html, snapshotProps);

    // 9. Optionally inject Kiln client script
    const clientSrc = '/_silcrow/silcrow.js';
    if (!html.includes(`src="${clientSrc}"`)) {
      html = injectKilnScript(html, clientSrc);
    }

    // 9b. Pages containing island markers also get the islands bootstrap.
    // This lands in the cached promoted shell too — cache-hit requests need
    // it just as much as fresh bakes.
    if (html.includes('data-kiln-island')) {
      html = injectModuleScript(html, '/_silcrow/islands.js');
    }

    // 10. Wrap with doctype if it looks like a full page
    const finalHtml = html.startsWith('<html') ? '<!DOCTYPE html>' + html : html;

    const pinInRedis = options.pinInRedis ?? false;

    // 11. Caching & persistence. Only pure renders of bake-eligible routes
    // produce artifacts — HTML and JSON are written together so shell and
    // snapshot can never diverge (a full bake just re-ran load(), so its
    // output is always the current, authoritative data). An impure render
    // under 'auto' demotes the route for the life of the process and deletes
    // anything a previously pure render left behind. A tombstoned route's
    // data was deliberately deleted; it serves fresh but never re-creates
    // artifacts or live registrations. Tombstone is checked here (write
    // time, cache misses only) so the read path never queries Postgres.
    // cache_key pages are excluded from auto-demotion: declaring a key is an
    // explicit statement that the varying input load() reads is exactly what
    // the key partitions on, so identity access there is expected, not a leak.
    const autoMode = bakeMode === undefined && !options.cacheKey;
    if (!renderPure && autoMode && !knownImpure) {
      knownImpure = true;
      await cache.delete(req.path, variant);
    }
    if (!renderPure && (bakeMode === 'shared' || bakeMode === 'static') && process.env.NODE_ENV !== 'production') {
      warnOnce(
        `impure-bake:${req.path}`,
        `[kiln] route "${req.path}" declares bake='${bakeMode}' but its load() read identity ` +
          `fields (locals/headers/query); every caller will receive this cached copy.`
      );
    }
    const shouldBake =
      bakeMode !== false && !knownImpure && !anyLayoutImpure && (renderPure || !autoMode);
    const tombstoned =
      store && typeof store.isTombstoned === 'function' ? await store.isTombstoned(req.path) : false;

    let htmlPath: string | null = null;
    let jsonPath: string | null = null;
    if (shouldBake && !tombstoned) {
      const layoutSignature =
        layoutPatterns.length > 0 ? await computeLayoutSignature(layoutPatterns, cache) : undefined;
      await cache.setJson(req.path, createBakedSnapshot(snapshotProps, undefined, layoutSignature), variant);
      await cache.setHtml(req.path, finalHtml, pinInRedis, variant);
      jsonPath = variant ? null : cache.diskJsonPath(req.path);
      htmlPath = variant ? null : cache.diskHtmlPath(req.path);
      if (store && !variant) {
        await store.setBakedPaths(req.path, htmlPath, jsonPath);
      }
    }

    // Live registrations write to the route's BASE cache paths; a cacheKey
    // page's per-variant artifacts would be silently poisoned by them, so
    // live features are not registered for variant requests.
    if (variant && watcher && (hasLiveLists(rawPageProps) || extractLiveFields(rawPageProps).length > 0)) {
      warnOnce(
        `variant-live:${req.path}`,
        `[kiln] route "${req.path}" combines cacheKey with LiveProp/Live.list; ` +
          `live updates are not supported for cacheKey variants yet and were skipped.`,
      );
    }

    if (watcher && !tombstoned && !variant) {
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

    // 12. Persist live fields on pageMeta (extracted once at step 7)
    const liveFields = pageLiveFields;
    if (store && liveFields.length > 0 && !tombstoned && !variant) {
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
      const loaderReq = makeLoaderRequest(req);
      watcher?.registerLoader?.({
        route: req.path,
        load: async () => {
          const loaded = typeof module.load === 'function' ? await module.load(loaderReq) : {};
          return loaded as Record<string, unknown>;
        },
      });
    }
    pageMeta.liveFields = liveFields;
    pageMeta.bake = bakeMode;

    // Debug/observability header: which layout patterns were reused from the
    // pattern-level cache this request (vs freshly loaded+baked). Not used by
    // any client logic — purely so this can be verified from the outside.
    const cacheHitPatterns = layoutPatterns.filter((_, i) => layoutFromCache[i]);
    if (cacheHitPatterns.length > 0) {
      res.headers['x-kiln-layout-cache-hit'] = cacheHitPatterns.join(',');
    }

    respondWithNavigationShape(res, req, layoutPatterns, pageMeta.pattern, finalHtml);
  };

  return async (req: KilnRequest, res: KilnResponse) => {
    try {
      await handle(req, res);
    } catch (err: any) {
      // Redirects thrown outside loadPageProps (e.g. from a layout's load())
      // are control flow, not errors.
      if (err?.type === 'Redirect') {
        res.redirect(err.message, err.status);
        return;
      }
      await respondWithErrorPage(err, req, res, errorFiles);
    }
  };
}

const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  addBounded(warnedOnce, key);
  console.warn(message);
}

/**
 * A stripped request the watcher can safely re-run load() with long after the
 * original request ended. Only the route identity (path/params/query) is
 * kept — the first visitor's headers, cookies, and body must never leak into
 * a cache entry that is served to everyone.
 */
function makeLoaderRequest(req: KilnRequest): KilnRequest {
  return {
    path: req.path,
    method: 'GET',
    params: { ...req.params },
    query: { ...req.query },
    headers: new Headers(),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    // Intentionally empty, like the stripped headers above: a layout load can
    // be baked into a shared cache entry, so per-user locals (e.g. the auth
    // user) must not flow in here or one visitor's data leaks to everyone.
    locals: {},
    prebakeNext: () => {},
  };
}

/**
 * Map a thrown error to a response: AppError statuses are honored (404/401/
 * 422/500), and the nearest _error.tsx / _not-found.tsx renders the body when
 * one exists for the page's directory.
 */
async function respondWithErrorPage(
  err: any,
  req: KilnRequest,
  res: KilnResponse,
  errorFiles?: PageErrorFiles,
): Promise<void> {
  const isAppError = err?.name === 'AppError' && typeof err?.status === 'number';
  const status = isAppError ? err.status : 500;
  const message = isAppError ? (err.message || 'Error') : 'Internal Server Error';
  if (!isAppError) {
    console.error(`[kiln] unhandled error rendering ${req.path}:`, err);
  }

  res.status = status;
  const accept = req.headers.get('accept') ?? '';
  if (!accept.includes('text/html') && accept.includes('application/json')) {
    res.json({ error: message, status });
    return;
  }

  const file = status === 404 ? (errorFiles?.notFoundFile ?? errorFiles?.errorFile) : errorFiles?.errorFile;
  if (file) {
    try {
      const mod = await import(pathToFileURL(path.resolve(file)).href);
      if (typeof mod.default === 'function') {
        const baked = await bakeSegment(
          mod.default,
          { error: { status, message, type: isAppError ? err.type : 'Internal' }, path: req.path },
          false,
        );
        res.html(baked.html);
        return;
      }
    } catch (renderErr: any) {
      console.error(`[kiln] error page ${file} failed to render:`, renderErr?.message ?? renderErr);
    }
  }

  res.html(
    `<!DOCTYPE html><html><head><title>${status}</title></head><body><h1>${status}</h1><p>${escapeHtml(message)}</p></body></html>`,
  );
}

function wrapPageSegment(
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

function materializeLayoutSegment(pattern: string, shell: string, child: string): string {
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
  const marker = `data-kiln-layout="${escapeAttribute(pattern)}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  return extractBalancedDiv(html, markerIndex);
}

/** From an index inside a div's open tag, return that whole balanced
 * `<div>…</div>` region, or null when the markup never closes it. */
function extractBalancedDiv(html: string, fromIndex: number): string | null {
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
  await adapter.applyServerHooks?.(process.cwd());

  // 4. Register /_image endpoint if images config is present
  if ((config as any).images?.enabled) {
    const { buildImageHandler } = await import('./image-handler.js');
    adapter.registerPage('/_image', [], buildImageHandler((config as any).images));
  }

  // 5. Register page routes
  for (const page of manifest.pages) {
    const absolutePagePath = path.resolve(page.filePath);
    const mod = await import(pathToFileURL(absolutePagePath).href);

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
      errorFiles
    );
    adapter.registerPage(page.pattern, page.layouts, pageHandler);

    if (mod.actions) {
      adapter.registerAction(page.pattern, buildActionHandler(mod.actions));
    }

    // SSG: prebake at startup for pages exporting entries() + bake 'static'.
    // Runs the real page handler against a synthetic request so the entry is
    // fully loaded, baked, and cached — identical to what the first live
    // request would have produced.
    const pageOptions = extractPageOptions(mod);
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
        watcher: options.watcher,
        cache: hubCache
      });
      res.sse(stream);
    });

    // JSON endpoint, so it must go through registerPage — registerSSE only
    // forwards SSE bodies and would drop the JSON payload entirely.
    adapter.registerPage('/__kiln/fsr/snapshot', [], async (req, res) => {
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

function makePrebakeRequest(concretePath: string, params: Record<string, string>): KilnRequest {
  return {
    path: concretePath,
    method: 'GET',
    params: { ...params },
    query: {},
    headers: new Headers(),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    locals: {},
    prebakeNext: () => {},
  };
}

/** Response sink for startup prebakes — the handler's side effect (writing
 * the cache) is the point; the rendered body has no recipient. */
function makeNoopResponse(): KilnResponse {
  return {
    status: 200,
    headers: {},
    html: () => {},
    json: () => {},
    redirect: () => {},
    sse: () => {},
  };
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
