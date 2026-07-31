// The request path: buildPageHandler and its private helpers, extracted from
// boot.ts. This is the single largest unit of the framework — cache-tier
// resolution, JSON negotiation, layout assembly, purity classification, bake
// decisions, live-field upsert — and it is why boot.ts had grown past 1500
// lines. boot.ts now keeps only app-level wiring (startKiln) and the action
// handler.
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
import { applyLiveListMarkers, extractLiveListRowHtml } from './live-list-render.js';

import { discoverRoutes } from './discover.js';
import { extractPageOptions, extractLiveFields, type BakeMode } from './page-options.js';
import { createPurityTracker } from './purity.js';
import type { PageRoute, LayoutNode } from './manifest.js';
import type {
  KilnRequest,
  KilnResponse,
  KilnConfig,
  KilnIdentity,
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
// Server-only subpath: the '@kiln/core' barrel must stay client-bundleable
// (islands import from it), and sql.ts pulls in node:async_hooks + bun.
import { withDepCapture } from '@kiln/core/sql';
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
  layoutParamNames,
} from '@kiln/engine';

import { addBounded, warnOnce, DEDUP_SET_MAX } from './dedup.js';
import {
  applyLivePropMarkers,
  escapeAttribute,
  escapeHtml,
  extractLayoutFragment,
  materializeLayoutSegment,
  respondWithNavigationShape,
  unwrapLiveProps,
  warnDomLiveInsideIslands,
  wrapPageSegment,
} from './html-markers.js';
import { makeLoaderRequest } from './loader-request.js';
import {
  assertEmbeddedLiveLists,
  hasLiveLists,
  materializeLiveLists,
  registerLiveLists,
} from './live-registration.js';
import type { CacheOptions, PageErrorFiles } from './handler-types.js';

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

/**
 * True when a validated cache hit for (route, userKey) is dormant-stale and
 * must be rebuilt rather than served. Shared by both cached-read fast paths
 * (JSON, ~step 2, and HTML, ~step 3) so a route hit only through its JSON
 * endpoint gets the same never-serve-known-stale guarantee a promoted HTML
 * route already had (Plan 3 review Important #1).
 *
 * Gated on route activity FIRST (Important #2): a route this process just
 * confirmed active via SSE subscribe (FsrWatcher.markLocallyActive, called
 * on subscribe) is already being kept fresh by the watcher via pg_notify, so
 * the Postgres dormant-staleness query is skipped entirely for it — this
 * restores the "zero-Postgres cached read path for active snapshots"
 * guarantee. Only a route with no such local signal (genuinely dormant/cold,
 * or active only in another process) pays the query.
 */
async function isDormantStale(
  store: FsrStore | undefined,
  watcher: FsrWatcher | undefined,
  route: string,
  userKey: string,
  activeWindowSecs: number
): Promise<boolean> {
  if (!store || typeof store.fetchDormantStaleSlot !== 'function') return false;
  if (watcher && typeof watcher.isLocallyActive === 'function' &&
      watcher.isLocallyActive(route, userKey, activeWindowSecs)) {
    return false;
  }
  const dormant = await store.fetchDormantStaleSlot(route, userKey);
  return !!dormant;
}

// ---------------------------------------------------------------------------
// Layout signature — lets a promoted page's cached shell detect that one of
// its layouts has since been invalidated (see BakedSnapshot.layoutSignature
// for the full rationale). Reads the SAME cache entries `deleteLayout()`
// removes, so it's always consistent with the pattern-level layout cache.
// `params` must be this request's own path params: without them a dynamic
// layout's signature would read some other instance's entry, and the promoted
// page would either never invalidate or invalidate on every request.
// ---------------------------------------------------------------------------

async function computeLayoutSignature(
  patterns: string[],
  cache: KilnCache,
  params: Record<string, string>,
): Promise<string> {
  const htmls = await Promise.all(patterns.map((p) => cache.getLayoutHtml(p, params)));
  return htmls
    .map((html, i) => `${patterns[i]}:${html ? Bun.hash(html).toString(36) : 'MISSING'}`)
    .join('|');
}

// ---------------------------------------------------------------------------
// Page handler
// ---------------------------------------------------------------------------

// addBounded/warnOnce moved to ./dedup.js — both are needed by the request
// path and by the HTML marker pass, which are now separate modules.

export function buildPageHandler(
  module: any,
  pageMeta: PageRoute,
  layoutNodes: LayoutNode[],
  cacheOpts: CacheOptions,
  kilnConfig?: KilnConfig,
  store?: FsrStore,
  watcher?: FsrWatcher,
  errorFiles?: PageErrorFiles,
  identity?: KilnIdentity
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
  const touchRoute = (route: string, userKey = '') => {
    if (!store || typeof store.touchRoute !== 'function') return;
    const key = `${route}\u0000${userKey}`;
    const now = Date.now();
    if (now - (lastTouched.get(key) ?? 0) < TOUCH_INTERVAL_MS) return;
    if (lastTouched.size >= DEDUP_SET_MAX) lastTouched.clear();
    lastTouched.set(key, now);
    void store.touchRoute(route, userKey).catch(() => {});
  };
  // Highest live-field count this route has ever produced in this process.
  // null = never rendered yet, so we can't rule live fields out. Gates the
  // pre-load version snapshot below so a page that demonstrably has no live
  // fields (the common static case) doesn't pay a query it can't use.
  // Monotonic on purpose: a page whose live fields are conditional must keep
  // snapshotting once it has shown any.
  let maxLiveFieldsSeen: number | null = null;

  const handle = async (req: KilnRequest, res: KilnResponse) => {
    // 1. Resolve layout patterns for content negotiation
    const layoutPatterns = pageMeta.layouts.map((layoutPath) => {
      const node = layoutNodes.find((l) => l.filePath === layoutPath);
      return node ? node.pattern : '/';
    });
    const options = extractPageOptions(module);
    const bakeMode = options.bake; // undefined = 'auto'
    let uid: string | null = null;
    let variant = options.cacheKey ? options.cacheKey(req) : undefined;
    if (bakeMode === 'user') {
      uid = identity ? identity(req) : null;
      if (uid === null) {
        // Anonymous (or no identity hook configured): a per-user page has no
        // cache key for this request — serve pure SSR, write nothing.
        if (!identity) {
          warnOnce(
            `user-no-identity:${pageMeta.pattern}`,
            `[kiln] route "${pageMeta.pattern}" declares bake='user' but no identity hook is configured; serving pure SSR.`
          );
        }
      } else {
        variant = `u:${uid}`;
      }
    }
    const userKey = uid ?? '';
    const isUserVariant = bakeMode === 'user' && uid !== null;
    const revalidate = options.revalidate ?? kilnConfig?.fsr?.revalidateSeconds ?? 300;
    const purgeAfter = options.purgeAfter ?? kilnConfig?.fsr?.purgeAfterSeconds ?? 2_592_000;
    // Matches the default the CLI wires into FsrWatcherConfig.activeWindowSecs
    // (packages/cli/src/cli.ts) — keeps the read path's "is this route
    // locally active" gate consistent with the watcher's own eager-tick window.
    const activeWindowSecs = kilnConfig?.fsr?.activeWindowSecs ?? 30;
    const bakeEligible =
      bakeMode !== false && !knownImpure && !(bakeMode === 'user' && uid === null);

    const ensureKey = `${req.path}\u0000${userKey}`;
    if (store && typeof store.ensureRouteRow === 'function' && !ensuredRoutes.has(ensureKey)) {
      await store.ensureRouteRow(
        req.path,
        revalidate === false ? 0 : revalidate,
        purgeAfter,
        options.patchMode,
        userKey
      );
      addBounded(ensuredRoutes, ensureKey);
    }
    // Every request path — cached AND rendered — must refresh recency, or an
    // actively-served pure-SSR route would look idle and get purged after
    // purge_after_secs (ensureRouteRow's ON CONFLICT deliberately does not
    // update last_requested_at, and it only runs once per process anyway).
    // The 60s throttle keeps this to at most one UPDATE per route per minute.
    touchRoute(req.path, userKey);

    let pageProps: any = {};
    let rawPageProps: any = {};
    let pagePropsLoaded = false;
    let renderPure = true;
    // Tables observed via a createKilnSql-wrapped query run inside load() —
    // unioned into each live field's depends_on below (step 12) so
    // Live.value(x) with no explicit dep list still revalidates on writes to
    // the tables it actually reads. Populated once, by the real per-request
    // load() call (not the watcher's later background loader re-runs).
    let observedTables: string[] = [];
    // Each live slot's `version` as of BEFORE load() ran. Handed back to
    // upsertSlot (step 12) so it can tell whether a dependency write landed
    // *during* this render — if it did, the slot must stay stale rather than
    // have its flag reset over data that predates the write. Must be awaited
    // before load(), not raced with it: a snapshot that lands after load()'s
    // own read would already reflect the invalidation it exists to catch.
    let slotVersionsAtLoad: Record<string, number> = {};
    const loadPageProps = async () => {
      if (pagePropsLoaded) return pageProps;
      pagePropsLoaded = true;
      if (typeof module.load !== 'function') return pageProps;
      try {
        if (
          store &&
          typeof store.fetchSlotVersions === 'function' &&
          (maxLiveFieldsSeen === null || maxLiveFieldsSeen > 0)
        ) {
          slotVersionsAtLoad = await store
            .fetchSlotVersions(req.path, userKey)
            .catch(() => ({}));
        }
        const tracker = createPurityTracker(req);
        const { result, tables } = await withDepCapture(async () => module.load(tracker.proxied));
        observedTables = [...tables];
        rawPageProps = result;
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

    // 2. Content negotiation — JSON shortcut (explicit header OR page declared
    // json_first). Baked routes serve the snapshot's page-only props straight
    // from cache — one read, no load(): the "button click just picks the
    // JSON" path. Any doubt about validity (no pageData, build mismatch)
    // falls through to a fresh load().
    if (wantsJson(req) || options.jsonFirst) {
      if (bakeEligible) {
        const snap = (await cache.getJson(req.path, variant)) as
          | { pageData?: Record<string, unknown>; buildId?: string }
          | null;
        const buildOk = !kilnConfig?.fsr?.buildId || snap?.buildId === kilnConfig.fsr.buildId;
        if (snap?.pageData && buildOk) {
          // A route hit only via this JSON endpoint never touches the HTML
          // dormant check below — without this it could serve known-stale
          // pageData forever once its dependency changes (Important #1).
          // Mirrors the HTML path's own dormant-stale handling exactly.
          if (await isDormantStale(store, watcher, req.path, userKey, activeWindowSecs)) {
            await cache.delete(req.path, variant);
          } else {
            touchRoute(req.path, userKey);
            res.json(snap.pageData);
            return;
          }
        }
      }
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
      const currentSignature = await computeLayoutSignature(layoutPatterns, cache, req.params);
      const cachedSignature = (cachedSnapshot as { layoutSignature?: string } | null)?.layoutSignature;
      if (currentSignature !== cachedSignature) {
        materialized = null;
      }
    }
    // Deploy fingerprint: an artifact baked by a different build is stale by
    // definition (component code may have changed) — same treatment as a
    // layout-signature mismatch. Only enforced when the app sets fsr.buildId.
    if (materialized && kilnConfig?.fsr?.buildId) {
      const cachedBuild = (cachedSnapshot as { buildId?: string } | null)?.buildId;
      if (cachedBuild !== kilnConfig.fsr.buildId) {
        materialized = null;
      }
    }

    if (cachedHtml && !materialized) {
      // Corrupt or layout-stale artifact: drop it and fall through to a
      // fresh render, which re-bakes in step 11.
      await cache.delete(req.path, variant);
    }
    // A validated artifact can still be sitting on stale data: if the route
    // is dormant (no recent last_active_at), the watcher's eager loop never
    // revalidated it (Task 5's activeWindowSecs gate). Rebuild on this read
    // rather than serve known-stale content — the fresh render below re-bakes
    // and upsertSlot clears the stale flag. isDormantStale gates the
    // Postgres check itself on local activity (Important #2).
    if (materialized && await isDormantStale(store, watcher, req.path, userKey, activeWindowSecs)) {
      await cache.delete(req.path, variant);
      materialized = null;
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
      if (store && watcher && liveFields.length > 0 && (!variant || isUserVariant)) {
        const loaderReq = makeLoaderRequest(req, isUserVariant);
        watcher.registerLoader({
          route: req.path,
          userKey,
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
    // parallel. Layouts are cached PER PATTERN (e.g. "/dashboard") plus the
    // concrete values of the params that pattern owns, not per concrete
    // route: a layout's load() may only depend on params owned by its own
    // pattern (never req.query, never a descendant page's params — ADR-011),
    // which makes it safe to bake once per distinct value of those params and
    // share across every route underneath it. This is what lets a change to
    // shared chrome (header/footer/sidebar) invalidate with a single cache
    // entry instead of requiring every route to re-bake — and, for
    // "/projects/:id", still shares one bake between that project's /board
    // and /activity pages without leaking it to a different project.
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
          : await cache.getLayoutHtml(layoutPattern, req.params);
        if (cachedHtml) {
          const cachedJson = await cache.getLayoutJson(layoutPattern, req.params);
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
          // Layout mode (ADR-011): reading this layout's OWN params is fine —
          // they are in its cache key — but a descendant page's param, or
          // req.path, is not, and would make one instance's chrome serve for
          // all of them. A violation counts as impure, so the existing branch
          // below deletes any artifact and stops caching it: correct output,
          // just uncached, rather than a silent cross-instance leak.
          const tracker = createPurityTracker(req, {
            layoutPattern,
            layoutParamNames: layoutParamNames(layoutPattern),
          });
          loaded = await lMod.load(tracker.proxied);
          layoutPure = !tracker.identityAccessed();
          const violation = tracker.scopeViolation();
          if (violation) {
            warnOnce(
              `layout-scope:${layoutPattern}`,
              `[kiln] ADR-011: ${violation}. That value is not part of the layout's cache key, so ` +
                `this layout is being served uncached to stay correct. Move the read into the page ` +
                `that needs it, or resolve it client-side.`,
            );
          }
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
          await cache.setLayoutHtml(layoutPattern, marked, req.params);
          await cache.setLayoutJson(layoutPattern, createBakedSnapshot(layoutPropsArr[idx]), req.params);
        } else {
          anyLayoutImpure = true;
          if (!impureLayouts.has(layoutPattern)) {
            impureLayouts.add(layoutPattern);
            // Self-heal: nuke any artifact a previously-pure version left
            // behind — every instance of it, since impurity is a property of
            // the layout's code, not of the id in the URL that first hit it.
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
    // bake='user' deliberately reads identity — no demotion, no warning.
    if (!renderPure && (bakeMode === 'shared' || bakeMode === 'static') && process.env.NODE_ENV !== 'production') {
      warnOnce(
        `impure-bake:${req.path}`,
        `[kiln] route "${req.path}" declares bake='${bakeMode}' but its load() read identity ` +
          `fields (locals/headers/query); every caller will receive this cached copy.`
      );
    }
    const shouldBake = bakeEligible && !anyLayoutImpure && (renderPure || !autoMode);
    const tombstoned =
      store && typeof store.isTombstoned === 'function' ? await store.isTombstoned(req.path) : false;

    let htmlPath: string | null = null;
    let jsonPath: string | null = null;
    if (shouldBake && !tombstoned) {
      const layoutSignature =
        layoutPatterns.length > 0
          ? await computeLayoutSignature(layoutPatterns, cache, req.params)
          : undefined;
      await cache.setJson(
        req.path,
        createBakedSnapshot(snapshotProps, undefined, layoutSignature, {
          pageData: pageProps,
          buildId: kilnConfig?.fsr?.buildId,
        }),
        variant
      );
      await cache.setHtml(req.path, finalHtml, pinInRedis, variant);
      // 'user' variants record their baked paths under their user_key row so
      // the watcher can patch them; cache_key variants keep today's behavior
      // (no row — live features are unsupported for them).
      jsonPath = variant && !isUserVariant ? null : cache.diskJsonPath(req.path, variant);
      htmlPath = variant && !isUserVariant ? null : cache.diskHtmlPath(req.path, variant);
      if (store && (!variant || isUserVariant)) {
        await store.setBakedPaths(req.path, htmlPath, jsonPath, userKey);
      }
    }

    // Live registrations write to the route's BASE cache paths; a cacheKey
    // page's per-variant artifacts would be silently poisoned by them, so
    // live features are not registered for variant requests.
    if (variant && !isUserVariant && watcher && (hasLiveLists(rawPageProps) || extractLiveFields(rawPageProps).length > 0)) {
      warnOnce(
        `variant-live:${req.path}`,
        `[kiln] route "${req.path}" combines cacheKey with LiveProp/Live.list; ` +
          `live updates are not supported for cacheKey variants yet and were skipped.`,
      );
    }
    if (isUserVariant && watcher && hasLiveLists(rawPageProps)) {
      warnOnce(
        `user-live-list:${req.path}`,
        `[kiln] route "${req.path}" combines bake='user' with Live.list; per-user list ` +
          `updates are not supported yet (scalar LiveProp fields are) and were skipped.`,
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
        // The layout's baked HTML is now cached per concrete param value, but
        // a Live.list inside it is still identified to the store/hub by the
        // PATTERN alone (the marker route and the registration route below) —
        // so two concrete instances of "/projects/:id" would share one list
        // channel and patch each other's rows. Scalar LiveProp fields are
        // unaffected (they ride the page's own route). Warn once per pattern
        // rather than let it fail silently.
        if ((layoutRoute.includes(':') || layoutRoute.includes('*')) && hasLiveLists(rawLayoutPropsArr[index])) {
          warnOnce(
            `dynamic-layout-live-list:${layoutRoute}`,
            `[kiln] layout "${layoutRoute}" has a dynamic path segment and uses Live.list; ` +
              `list updates are identified by pattern, so every concrete instance of this ` +
              `layout shares one list channel. Move the Live.list into the page for now.`,
          );
        }
        await registerLiveLists({
          route: layoutRoute,
          pageComponent: layoutEntries[index].module.default,
          pageProps: rawLayoutPropsArr[index],
          finalHtml,
          htmlPath: cache.diskLayoutHtmlPath(layoutRoute, req.params),
          jsonPath: cache.diskLayoutJsonPath(layoutRoute, req.params),
          watcher,
          isLayout: true,
          defaultDebounce: layoutOptions.debounce ?? kilnConfig?.fsr?.patchDebounceSecs,
          defaultRevalidate: layoutOptions.revalidate ?? kilnConfig?.fsr?.revalidateSeconds,
        });
      }
    }

    // 12. Persist live fields on pageMeta (extracted once at step 7)
    const liveFields = pageLiveFields;
    // Feeds the pre-load version-snapshot gate above. Recorded even when the
    // upsert branch below is skipped (tombstoned, wrong variant) — what it
    // answers is "can this route produce live fields at all", not "did we
    // write them this time".
    maxLiveFieldsSeen = Math.max(maxLiveFieldsSeen ?? 0, liveFields.length);
    if (store && liveFields.length > 0 && !tombstoned && (!variant || isUserVariant)) {
      // Auto-deps (default on): union tables observed during this request's
      // load() into every live field's explicit deps, so a field declared
      // with no dependsOn still gets one derived from what it actually
      // queried. Explicit deps are preserved, never replaced — apps can opt
      // out entirely via fsr.autoDeps: false.
      const autoDepsEnabled = kilnConfig?.fsr?.autoDeps !== false;
      for (const field of liveFields) {
        const dependsOn = Array.from(
          new Set([
            ...(field.dependsOn ?? []),
            ...(autoDepsEnabled ? observedTables : []),
          ]),
        );
        await store.upsertSlot(
          req.path,
          field.name,
          null,
          [],
          dependsOn,
          field.debounce ?? options.debounce ?? kilnConfig?.fsr?.patchDebounceSecs,
          null,
          userKey,
          // Undefined for a slot that didn't exist pre-load (INSERT path, or
          // the gate above skipped the snapshot) — upsertSlot then leaves
          // `stale` alone instead of clearing it blind.
          slotVersionsAtLoad[field.name],
        );
      }
      const loaderReq = makeLoaderRequest(req, isUserVariant);
      watcher?.registerLoader?.({
        route: req.path,
        userKey,
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

