# Bake Classes (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hit-count promotion (`promote_after`) with observation-based bake classes: bake on the first *pure* render, never bake identity-reading renders, and remove all Postgres writes from the cached read path.

**Architecture:** A purity tracker (Proxy over `KilnRequest`) observes whether `load()` touched identity fields (`locals`/`headers`/`query`/`raw`/body). Pure renders of bake-eligible routes write HTML+JSON artifacts immediately; artifact presence *is* promotion (no `promoted` flag, no hit counter). A new `bake` page export (`'static' | 'shared' | false`, absent = auto-classified) hard-replaces `promote_after`. The `kiln_fsr` hit/promotion columns are dropped; the watcher derives "promoted" from `html_path IS NOT NULL`.

**Tech Stack:** Bun, TypeScript, Postgres (bun-sql in engine), bun:test. No new dependencies.

## Global Constraints

- **Hard removal** (user decision 2026-07-19): `promote_after`, `promoteAfter`, and `fsr.promoteAfterHits` are deleted, not deprecated. A page exporting them fails boot with `StartupError`. jags-list, test-app, and examples migrate inside this plan.
- Every task must end with `bunx tsc --noEmit` clean in each package it touched, and that package's `bun test` passing.
- No new npm dependencies.
- Execution happens on a branch/worktree named `bake-classes` (create via superpowers:using-git-worktrees at execution start; **cd into the worktree explicitly in every Bash call** — cwd resets between turns).
- Commit after every task. Message style: `feat(scope): ...` / `refactor(scope): ...`, ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Out of scope (later plans): per-user snapshots and `(route, user)` cache keys (Plan 2); serving cached JSON on `Accept: application/json` (deliberately deferred — the baked snapshot's `data` merges layout+page props while today's JSON path returns page props only; unify shapes in Plan 2); auto-derived `depends_on` and `sync-triggers` CLI (Plan 3).

**Existing behavior contract that must NOT change:** layout pattern-level caching (ADR-011, `layoutSignature`), `cache_key` variants, Live.list/LiveProp registration and SSE patching, tombstone semantics (a tombstoned route never re-creates artifacts), `wantsJson` returning freshly-loaded page props.

---

### Task 1: Purity tracker

**Files:**
- Create: `packages/routekit/src/purity.ts`
- Test: `packages/routekit/src/purity.test.ts`

**Interfaces:**
- Consumes: `KilnRequest` from `@kiln/core` (fields: `path`, `method`, `params`, `query`, `headers`, `locals`, `raw`, `formData()`, `json()`, …).
- Produces: `createPurityTracker(req: KilnRequest): PurityTracker` where `PurityTracker = { proxied: KilnRequest; identityAccessed(): boolean }`. Task 3 calls this around every page and layout `load()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/routekit/src/purity.test.ts
import { describe, expect, it } from 'bun:test';
import { createPurityTracker } from './purity.js';
import type { KilnRequest } from '@kiln/core';

function makeReq(): KilnRequest {
  return {
    path: '/projects/7',
    method: 'GET',
    params: { id: '7' },
    query: { tab: 'open' },
    headers: new Headers({ accept: 'text/html' }),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    prebakeNext: () => {},
    locals: { user: { id: 'u1' } },
  } as unknown as KilnRequest;
}

describe('createPurityTracker', () => {
  it('stays pure when load() only reads path/method/params', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.path;
    void t.proxied.method;
    void t.proxied.params.id;
    expect(t.identityAccessed()).toBe(false);
  });

  it('flips on locals access', () => {
    const t = createPurityTracker(makeReq());
    void (t.proxied.locals as any).user;
    expect(t.identityAccessed()).toBe(true);
  });

  it('flips on query access', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.query.tab;
    expect(t.identityAccessed()).toBe(true);
  });

  it('flips on headers access', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.headers.get('accept');
    expect(t.identityAccessed()).toBe(true);
  });

  it('flips on body access and keeps methods bound to the real request', async () => {
    const t = createPurityTracker(makeReq());
    await t.proxied.formData();               // must not throw "illegal invocation"
    expect(t.identityAccessed()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .worktrees/bake-classes && bun test packages/routekit/src/purity.test.ts`
Expected: FAIL — `Cannot find module './purity.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/routekit/src/purity.ts
import type { KilnRequest } from '@kiln/core';

/** Request fields whose values vary by caller identity or per-request input
 * that is NOT part of the route path. A load() that reads any of them
 * produces a personalized render whose output must never be cached under a
 * route-only key. `params` is deliberately absent: params derive from the
 * concrete path, which IS the cache key. */
const IDENTITY_FIELDS = new Set<PropertyKey>([
  'locals',
  'headers',
  'query',
  'raw',
  'formData',
  'json',
]);

export interface PurityTracker {
  proxied: KilnRequest;
  identityAccessed(): boolean;
}

export function createPurityTracker(req: KilnRequest): PurityTracker {
  let touched = false;
  const proxied = new Proxy(req, {
    get(target, prop, receiver) {
      if (IDENTITY_FIELDS.has(prop)) touched = true;
      const value = Reflect.get(target, prop, receiver);
      // Headers.get / formData / json must stay bound to the real object.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxied, identityAccessed: () => touched };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd .worktrees/bake-classes && bun test packages/routekit/src/purity.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd .worktrees/bake-classes/packages/routekit && bunx tsc --noEmit
cd ../.. && git add packages/routekit/src/purity.ts packages/routekit/src/purity.test.ts
git commit -m "feat(routekit): purity tracker observes identity access during load()

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `bake` page option; hard-remove `promote_after`

**Files:**
- Modify: `packages/core/src/errors.ts:52` (extend StartupError code union)
- Modify: `packages/routekit/src/page-options.ts:4-50`
- Modify: `packages/core/src/types.ts:124,136` (remove `promoteAfter?: number` from both interfaces; add `bake?: 'static' | 'shared' | false` in their place)
- Modify: `packages/routekit/src/manifest.ts:8` (replace `promoteAfter?: number;` with `bake?: 'static' | 'shared' | false;`)
- Test: `packages/routekit/src/page-options.test.ts` (create)

**Interfaces:**
- Produces: `PageOptions.bake?: 'static' | 'shared' | false` (undefined = auto). `extractPageOptions` **throws** `StartupError('RemovedOption', …)` when a module exports `promote_after`/`promoteAfter` or an invalid `bake` value. Tasks 3, 4, 7, 8 rely on exactly these semantics.

- [ ] **Step 1: Write the failing test**

```ts
// packages/routekit/src/page-options.test.ts
import { describe, expect, it } from 'bun:test';
import { extractPageOptions } from './page-options.js';

describe('extractPageOptions bake parsing', () => {
  it('returns undefined bake (auto) when nothing is exported', () => {
    expect(extractPageOptions({}).bake).toBeUndefined();
  });

  it.each([['static'], ['shared'], [false]])('accepts bake=%p', (v) => {
    expect(extractPageOptions({ bake: v }).bake).toBe(v as any);
  });

  it('throws StartupError on promote_after', () => {
    expect(() => extractPageOptions({ promote_after: 2 })).toThrow(/promote_after has been removed/);
    expect(() => extractPageOptions({ promote_after: false })).toThrow(/promote_after has been removed/);
  });

  it('throws StartupError on legacy promoteAfter', () => {
    expect(() => extractPageOptions({ promoteAfter: 2 })).toThrow(/promote_after has been removed/);
  });

  it('throws StartupError on an invalid bake value', () => {
    expect(() => extractPageOptions({ bake: 2 })).toThrow(/invalid bake/);
    expect(() => extractPageOptions({ bake: 'always' })).toThrow(/invalid bake/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .worktrees/bake-classes && bun test packages/routekit/src/page-options.test.ts`
Expected: FAIL — `bake` is not a property; no throw on `promote_after`

- [ ] **Step 3: Implement**

In `packages/core/src/errors.ts:52` extend the code union:

```ts
    public readonly code: 'ConfigLoad' | 'UnsupportedProvider' | 'RemovedOption',
```

Replace `packages/routekit/src/page-options.ts:4-50` (interface + extract; keep `extractLiveFields` untouched):

```ts
export type BakeMode = 'static' | 'shared' | false;

export interface PageOptions {
  /** undefined = 'auto': bake on the first render whose load() touched no
   * identity fields; a single identity-touching render demotes the route
   * for the life of the process. 'shared'/'static' bake unconditionally
   * (dev-mode warning if identity is accessed). false = pure SSR. */
  bake?: BakeMode;
  revalidate?: number | false;
  debounce?: number;
  purgeAfter?: number;
  pinInRedis?: boolean;
  patchMode?: 'json' | 'both';
  jsonFirst?: boolean;
  cacheKey?: (req: KilnRequest) => string;
}

export function extractPageOptions(module: any): PageOptions {
  if (module.promote_after !== undefined || module.promoteAfter !== undefined) {
    throw new StartupError(
      'RemovedOption',
      '[kiln] promote_after has been removed. Delete the export: absent = auto ' +
        "(bake on first identity-free render). Use `export const bake = 'static' | 'shared' | false` " +
        'to override. See docs/agents/rendering-and-caching.md.'
    );
  }
  let bake: BakeMode | undefined;
  if (module.bake !== undefined) {
    if (module.bake === 'static' || module.bake === 'shared' || module.bake === false) {
      bake = module.bake;
    } else {
      throw new StartupError(
        'RemovedOption',
        `[kiln] invalid bake value ${JSON.stringify(module.bake)}; expected 'static', 'shared', or false.`
      );
    }
  }

  let patchMode = module.patch_mode;
  if (patchMode === undefined && module.patchMode) {
    console.warn('[kiln] patchMode is deprecated; export patch_mode instead');
    patchMode = module.patchMode;
  }

  let cacheKey = module.cache_key;
  if (cacheKey === undefined && typeof module.cacheKey === 'function') {
    console.warn('[kiln] cacheKey is deprecated; export cache_key instead');
    cacheKey = module.cacheKey;
  }

  return {
    bake,
    revalidate:
      typeof module.revalidate === 'number' || module.revalidate === false
        ? module.revalidate
        : undefined,
    debounce: typeof module.debounce === 'number' ? module.debounce : undefined,
    purgeAfter: typeof module.purge_after === 'number' ? module.purge_after : undefined,
    pinInRedis: typeof module.pinInRedis === 'boolean' ? module.pinInRedis : undefined,
    patchMode: patchMode === 'both' ? 'both' : (patchMode === 'json' ? 'json' : undefined),
    jsonFirst: typeof module.json_first === 'boolean' ? module.json_first : undefined,
    cacheKey: typeof cacheKey === 'function' ? cacheKey : undefined,
  };
}
```

Add to the imports at the top of `page-options.ts`: `import { LiveProp, StartupError } from '@kiln/core';` (replacing the existing `import { LiveProp } from '@kiln/core';`).

In `packages/core/src/types.ts` replace **both** `promoteAfter?: number;` lines (124 and 136, in the page and layout definition interfaces — line 135's `/** @deprecated Use promote_after. */` comment goes too) with:

```ts
  bake?: 'static' | 'shared' | false;
```

In `packages/routekit/src/manifest.ts:8` replace `promoteAfter?: number;` with `bake?: 'static' | 'shared' | false;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd .worktrees/bake-classes && bun test packages/routekit/src/page-options.test.ts`
Expected: PASS. (`boot.ts` still compiles — `options.promoteAfter` reads now fail typecheck; that is expected and fixed in Task 3, so run tsc for core only here: `cd packages/core && bunx tsc --noEmit`.)

- [ ] **Step 5: Commit**

```bash
cd .worktrees/bake-classes
git add packages/core/src/errors.ts packages/core/src/types.ts packages/routekit/src/page-options.ts packages/routekit/src/page-options.test.ts packages/routekit/src/manifest.ts
git commit -m "feat(routekit)!: bake export replaces promote_after (hard removal)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `handle()` — artifact-presence promotion, purity-gated writes, zero-Postgres reads

**Files:**
- Modify: `packages/routekit/src/boot.ts` (buildPageHandler closure `:112-175`, cache-hit touch sites `:~248,~257`, layout bake branch in step 5, step 11 `:~424-445`, `pageMeta.promoteAfter` assignment `:~510`)
- Test: `packages/routekit/src/boot.test.ts`

**Interfaces:**
- Consumes: `createPurityTracker` (Task 1), `PageOptions.bake` (Task 2), existing `store.isTombstoned(route)`, `store.touchRoute(route)`, `store.setBakedPaths(route, htmlPath, jsonPath)`, `cache.getHtml/setHtml/getJson/setJson/delete/deleteLayout`.
- Produces: the new request lifecycle every later task tests against. **In this task boot still calls the OLD 5-arg `ensureRouteRow`, passing `null` for promoteAfter** — the signature changes in Task 5 to keep every commit compiling.

- [ ] **Step 1: Rewrite the promotion preamble (boot.ts:112-175)**

Replace the closure state and the beginning of `handle` (everything from `let localHitCount = 0;` through the end of the store/local promotion branch, i.e. old lines 123-175) with:

```ts
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
      // NOTE(Task 5): drops the null promoteAfter arg when the store signature changes.
      await store.ensureRouteRow(
        req.path,
        null,
        revalidate === false ? 0 : revalidate,
        purgeAfter,
        options.patchMode
      );
      addBounded(ensuredRoutes, req.path);
    }
```

Delete the old `hitStatus`/`promoted`/`incrementHit`/`isPromoted`/`localHitCount`/`locallyPromoted` logic entirely. The old `const tombstoned = hitStatus === 'Tombstoned';` line is removed; `tombstoned` is now computed in step 11 (below).

- [ ] **Step 2: Purity-wrap the page load**

Inside `loadPageProps`, add a `renderPure` flag (declared next to `pagePropsLoaded`) and wrap the request:

```ts
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
```

Add `import { createPurityTracker } from './purity.js';` to boot.ts imports.

- [ ] **Step 3: Cache check becomes eligibility-gated; touches become throttled**

Old step 3 (`:~210`) read `const cachedHtml = promoted ? await cache.getHtml(req.path, variant) : null;` followed by a `promoted && !cachedHtml` → `hitStatus = 'JustPromoted'` recovery. Replace with:

```ts
    // 3. HTML cache check — artifact presence IS promotion.
    const cachedHtml = bakeEligible ? await cache.getHtml(req.path, variant) : null;
```

Delete the recovery block and the `if (cachedHtml && !materialized) { … hitStatus = 'JustPromoted'; promoted = false; }` reassignment — keep only `await cache.delete(req.path, variant);` there (a corrupt/stale-signature artifact just falls through to a fresh render, which re-bakes in step 11). Replace both `await store?.touchRoute?.(req.path);` call sites in the cache-hit paths with `touchRoute(req.path);`.

- [ ] **Step 4: Purity-wrap layout loads; impure layouts never enter the pattern cache**

In step 5's layout branch, the cache read gains a guard and the load gains a tracker:

```ts
        const layoutPattern = layoutPatterns[idx] ?? '/';
        const cachedHtml = impureLayouts.has(layoutPattern)
          ? null
          : await cache.getLayoutHtml(layoutPattern);
```

and where the layout module's `load` runs:

```ts
        let loaded: any = {};
        let layoutPure = true;
        if (typeof lMod.load === 'function') {
          const tracker = createPurityTracker(req);
          loaded = await lMod.load(tracker.proxied);
          layoutPure = !tracker.identityAccessed();
          assertEmbeddedLiveLists(loaded, kilnConfig);
          loaded = await materializeLiveLists(loaded, store);
        }
```

and the cache write at the end of that branch becomes conditional:

```ts
        if (layoutPure) {
          await cache.setLayoutHtml(layoutPattern, marked);
          await cache.setLayoutJson(layoutPattern, createBakedSnapshot(layoutPropsArr[idx]));
        } else if (!impureLayouts.has(layoutPattern)) {
          impureLayouts.add(layoutPattern);
          // Self-heal: nuke any artifact a previously-pure version left behind.
          await cache.deleteLayout(layoutPattern);
        }
```

- [ ] **Step 5: Rewrite step 11 (artifact writes) as purity-gated, tombstone-checked**

Replace old steps 11A/11B (`:~424-445` — the `if (!tombstoned) { …setJson… }` block and the `if (hitStatus === 'JustPromoted') { …setHtml… }` block) with:

```ts
    // 11. Caching & persistence. Only pure renders of bake-eligible routes
    // produce artifacts — HTML and JSON are written together so shell and
    // snapshot can never diverge. An impure render under 'auto' demotes the
    // route for the life of the process and deletes anything a previously
    // pure render left behind. Tombstone is checked here (write time, cache
    // misses only) so the read path never queries Postgres.
    const autoMode = bakeMode === undefined;
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
    const shouldBake = bakeMode !== false && !knownImpure && (renderPure || !autoMode);
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
```

The later blocks that referenced `tombstoned` (`registerLiveLists` gate `if (watcher && !tombstoned && !variant)` and step 12's `if (store && liveFields.length > 0 && !tombstoned && !variant)`) keep working — `tombstoned` is still in scope. Delete the `pageMeta.promoteAfter = promoteAfter === false ? undefined : promoteAfter;` line (`:~510`); replace with `pageMeta.bake = bakeMode;`.

- [ ] **Step 6: Update boot.test.ts**

Every mock store in the file: delete `incrementHit`/`isPromoted` members, keep/add `isTombstoned: async () => false`, and keep `ensureRouteRow` at its current 5-arg shape (Task 5 adjusts arity). Then:

- Rename `boot.test.ts:41` `'promotes on the second successful render and serves later requests without loaders or React'` → `'bakes on the first successful render and serves later requests without loaders or React'`. Change its body from hit-twice-then-assert to: request once (expect fresh render + artifacts written), request again (expect the load spy NOT called again, response served from cache).
- `boot.test.ts:547` `'bypasses a promoted cache on the first request after watcher restart'`: the setup that promoted via two hits now promotes via one; adjust request counts only.
- Add two new tests at the end of the promotion describe block:

```ts
  it('never bakes a route whose load() reads req.locals, no matter how many hits', async () => {
    let loads = 0;
    const mod = {
      load: async (req: any) => {
        loads++;
        return { who: (req.locals as any)?.user ?? 'anon' };
      },
      default: ({ who }: any) => React.createElement('div', null, `hello ${who}`),
    };
    const handler = buildHandlerForTest(mod); // reuse the file's existing handler-construction helper
    for (let i = 0; i < 4; i++) await handler(makeTestRequest('/private'), makeTestResponse());
    expect(loads).toBe(4); // every hit re-rendered; nothing was served from cache
  });

  it("bake=false never writes artifacts even for a pure load()", async () => {
    const mod = {
      bake: false,
      load: async () => ({ n: 1 }),
      default: ({ n }: any) => React.createElement('div', null, String(n)),
    };
    const handler = buildHandlerForTest(mod);
    await handler(makeTestRequest('/ssr-only'), makeTestResponse());
    await handler(makeTestRequest('/ssr-only'), makeTestResponse());
    // second response must have re-rendered (no cache hit)
  });
```

Adapt `buildHandlerForTest`/`makeTestRequest`/`makeTestResponse` to whatever helper names the file actually uses (it constructs handlers via `buildPageHandler` with a temp cache dir — follow the pattern of the test at line 41). The assertions above are the contract; the harness plumbing follows the file's existing style.

- [ ] **Step 7: Run the suite**

Run: `cd .worktrees/bake-classes && bun test packages/routekit/src/boot.test.ts && cd packages/routekit && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
cd .worktrees/bake-classes
git add packages/routekit/src/boot.ts packages/routekit/src/boot.test.ts
git commit -m "feat(routekit)!: bake on first pure render; artifact presence is promotion; zero-Postgres read path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Static prebake keys off `bake: 'static'`

**Files:**
- Modify: `packages/routekit/src/boot.ts:939-944` (startKiln prebake condition)

**Interfaces:**
- Consumes: `PageOptions.bake` (Task 2). Produces: startup prebake for `bake='static'` + `entries()` pages; a static page *without* `entries()` simply bakes on its first request (same code path as 'shared').

- [ ] **Step 1: Change the condition**

At `boot.ts:944` replace:

```ts
    if (page.hasEntries && pageOptions.promoteAfter === 0 && typeof mod.entries === 'function') {
```

with:

```ts
    if (page.hasEntries && pageOptions.bake === 'static' && typeof mod.entries === 'function') {
```

Update the comment above it (`promote_after 0` → `bake 'static'`).

- [ ] **Step 2: Verify via the existing suite**

Run: `cd .worktrees/bake-classes && bun test packages/routekit/ && cd packages/routekit && bunx tsc --noEmit`
Expected: PASS (any prebake test fixture exporting `promote_after = 0` fails loudly via the Task 2 StartupError — change those fixtures to `bake = 'static'` in this task).

- [ ] **Step 3: Commit**

```bash
cd .worktrees/bake-classes && git add -A packages/routekit
git commit -m "feat(routekit): SSG prebake gates on bake='static'

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Store & schema surgery — drop the counter columns

**Files:**
- Modify: `packages/engine/src/schema.ts:1-26` (CREATE TABLE) + append migration
- Modify: `packages/engine/src/store.ts` (`ensureRouteRow:78-95`, delete `incrementHit:127-173`, delete `isPromoted:175-181`, `tombstone:190`, `tombstoneDependentRoutes:~259`, claim query `:~330-345`, `purgeInactiveRoutes:~370-380`, `fetchSlotsForSnapshot:~410-430`, delete the `HitStatus` type)
- Modify: `packages/routekit/src/boot.ts` (single `ensureRouteRow` call site from Task 3 — drop the `null` arg)
- Test: `packages/engine/src/store.test.ts`

**Interfaces:**
- Produces: `ensureRouteRow(route: string, revalidateSecs = 300, purgeAfterSecs = 2_592_000, patchMode: 'json' | 'both' | null = 'json'): Promise<void>`. Slot queries keep returning a `promoted` field, now computed as `(r.html_path IS NOT NULL)` — the watcher (Task 6) needs no semantic change.

- [ ] **Step 1: Update store.test.ts first (failing)**

In `packages/engine/src/store.test.ts` (integration; needs `DATABASE_URL`): delete the `incrementHit` assertions (the block around lines 50-56 asserting `'Normal'`/`'JustPromoted'`), update every `ensureRouteRow` call to the 4-arg form, delete `isPromoted` assertions, and add:

```ts
    // "promoted" is now artifact presence: setBakedPaths flips it.
    await store.ensureRouteRow('/bake-view', 300, 3600, 'json');
    await store.upsertSlot('/bake-view', 'count', null, [], ['tasks'], undefined);
    let slots = await store.fetchSlotsForSnapshot('/bake-view', []);
    assert.equal(slots[0].promoted, false);
    await store.setBakedPaths('/bake-view', '/tmp/bake-view.html', '/tmp/bake-view.json');
    slots = await store.fetchSlotsForSnapshot('/bake-view', []);
    assert.equal(slots[0].promoted, true);
```

Run: `cd .worktrees/bake-classes && bun --env-file=test-app/.env test packages/engine/src/store.test.ts`
Expected: FAIL (old signatures still in place).

- [ ] **Step 2: Schema**

In `packages/engine/src/schema.ts` delete these lines from the CREATE TABLE: `hit_count INTEGER NOT NULL DEFAULT 0,`, `promoted BOOLEAN NOT NULL DEFAULT false,`, `promote_after INTEGER,`, `last_hit TIMESTAMP,`, `promoted_at TIMESTAMP,`. Append to `KILN_FSR_SCHEMA_SQL` (after the existing statements, so `initialize()` migrates live databases):

```sql
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS hit_count;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS promoted;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS promote_after;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS promoted_at;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS last_hit;
```

(Check how `initialize()` executes the schema string — if it splits on `;`, these ride along; if it uses one `unsafe` call, they also ride along.)

- [ ] **Step 3: Store methods**

`ensureRouteRow` becomes:

```ts
  async ensureRouteRow(
    route: string,
    revalidateSecs = 300,
    purgeAfterSecs = 2_592_000,
    patchMode: 'json' | 'both' | null = 'json',
  ): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr
        (route, slot, revalidate_secs, purge_after_secs, patch_mode, last_requested_at)
      VALUES (${route}, '', ${revalidateSecs}, ${purgeAfterSecs}, ${patchMode}, NOW())
      ON CONFLICT (route, slot) DO UPDATE SET
        revalidate_secs  = EXCLUDED.revalidate_secs,
        purge_after_secs = EXCLUDED.purge_after_secs,
        patch_mode       = EXCLUDED.patch_mode
    `;
  }
```

Delete `incrementHit` and `isPromoted` wholesale, and the `HitStatus` type they returned. In `tombstone()` and `tombstoneDependentRoutes()` change `SET tombstoned = TRUE, promoted = FALSE, stale = FALSE` → `SET tombstoned = TRUE, stale = FALSE`. In the claim query (`:~342`) and both `fetchSlotsForSnapshot` queries (`:~415,~425`) change `r.promoted,` → `(r.html_path IS NOT NULL) as "promoted",`. In `purgeInactiveRoutes` change `COALESCE(last_requested_at, last_hit, NOW())` → `COALESCE(last_requested_at, NOW())`.

- [ ] **Step 4: Update the boot call site**

In `boot.ts` (Task 3's ensure block) drop the `null` argument and the `NOTE(Task 5)` comment:

```ts
      await store.ensureRouteRow(
        req.path,
        revalidate === false ? 0 : revalidate,
        purgeAfter,
        options.patchMode
      );
```

- [ ] **Step 5: Run tests**

Run: `cd .worktrees/bake-classes && bun --env-file=test-app/.env test packages/engine/src/store.test.ts && bun test packages/routekit/src/boot.test.ts && cd packages/engine && bunx tsc --noEmit && cd ../routekit && bunx tsc --noEmit`
Expected: PASS, both tsc clean.

- [ ] **Step 6: Commit**

```bash
cd .worktrees/bake-classes && git add packages/engine/src/schema.ts packages/engine/src/store.ts packages/engine/src/store.test.ts packages/routekit/src/boot.ts
git commit -m "refactor(engine)!: drop hit_count/promoted/promote_after columns; promoted = artifact presence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Purge `promoteAfterHits` from watcher, config, CLI, templates

**Files:**
- Modify: `packages/engine/src/watcher.ts:26` (WatcherConfig — delete `promoteAfterHits: number;`)
- Modify: `packages/core/src/config.ts:21,29,169,176,219-221` (LiveConfig + FsrConfig fields, both DEFAULT_CONFIG entries, the live→fsr bridge `if (config.live && config.fsr?.promoteAfterHits === undefined) { … }` block)
- Modify: `packages/cli/src/cli.ts:52` (delete the `promoteAfterHits: config.fsr.promoteAfterHits,` line)
- Modify: `packages/create-kiln/src/templates.ts:57` (delete `promoteAfterHits: 2,`)
- Modify: `packages/engine/src/watcher.test.ts:54`, `packages/engine/src/db-notify.test.ts:53`, `packages/engine/src/hub.test.ts:27` (delete the `promoteAfterHits: 1,` line from each WatcherConfig literal)

**Interfaces:**
- Produces: `WatcherConfig` without `promoteAfterHits`; `FsrConfig`/`LiveConfig` without `promoteAfterHits`. App `main.ts` files that still pass it become type errors — fixed in Tasks 7-8.

- [ ] **Step 1: Make the edits above** (pure deletions — the watcher never used the value outside its config type; verify with `grep -n promoteAfterHits packages/engine/src/watcher.ts` returning nothing after the edit).

- [ ] **Step 2: Verify engine + core + cli**

Run: `cd .worktrees/bake-classes && bun test packages/engine/ ; for p in core engine cli create-kiln routekit; do (cd packages/$p && bunx tsc --noEmit) || echo "FAIL $p"; done`
Expected: engine unit tests PASS (integration tests need `DATABASE_URL` — run `bun --env-file=test-app/.env test packages/engine/` where required); tsc clean in all five packages.

- [ ] **Step 3: Commit**

```bash
cd .worktrees/bake-classes && git add -A packages
git commit -m "refactor(core,engine,cli)!: remove promoteAfterHits from config and WatcherConfig

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Migrate test-app and examples/address-book

**Files:**
- Modify: `test-app/pages/baking-demo.tsx:3`, `test-app/pages/baking-demo-2.tsx:3`, `test-app/pages/dashboard/_layout.tsx:6`, `test-app/pages/dashboard/overview.tsx:3`, `test-app/pages/dashboard/reports/_layout.tsx:5`, `test-app/pages/dashboard/reports/details.tsx:3`, `test-app/pages/dashboard/reports/summary.tsx:3` — each `export const promote_after = 2;` → `export const bake = 'shared';`
- Modify: `test-app/pages/todos.tsx:11`, `test-app/pages/scalar-patch.tsx:5` — `export const promote_after = 0;` → `export const bake = 'static';`
- Modify: `test-app/kiln.config.ts:7`, `test-app/src/main.ts:20`, `test-app/scripts/prove-baking.ts:48` — delete the `promoteAfterHits` lines
- Modify: `examples/address-book/kiln.config.ts:8`, `examples/address-book/src/main.ts:29` — delete the `promoteAfterHits` lines; `examples/address-book/pages/contacts/_layout.tsx:6` — delete the `export const promote_after = 2;` line entirely (auto)

- [ ] **Step 1: Make the edits.** Also update any stale comments on those lines (`// Bake/cache after 2 hits` → `// Cache the baked shell for every visitor`).

- [ ] **Step 2: Verify with the baking proof script**

Run: `cd .worktrees/bake-classes/test-app && bunx tsc --noEmit && bun scripts/prove-baking.ts`
Expected: tsc clean. The script's expectations shift from "second hit bakes" to "first hit bakes" — update its assertions accordingly (any check that request #1 is *uncached* must now assert request #1 *renders and writes artifacts* and request #2 is cache-served). If the script needs Redis/Postgres, follow the env notes in `test-app/.env`.

- [ ] **Step 3: Commit**

```bash
cd .worktrees/bake-classes && git add test-app examples/address-book
git commit -m "chore(test-app,examples): migrate promote_after to bake classes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Migrate jags-list + cross-user purity regression test

**Files:**
- Modify (delete the `export const promote_after = false;` line and its adjacent explanatory comment lines in each): `apps/jags-list/pages/index.tsx:6-8`, `pages/login.tsx:5`, `pages/team.tsx:10`, `pages/projects/index.tsx:8`, `pages/projects/[id]/board.tsx:10`, `pages/projects/[id]/_layout.tsx:7`, `pages/projects/[id]/activity.tsx:7`, `pages/tasks/[id].tsx:10`, `pages/invite/[token].tsx:9`
- Modify: `apps/jags-list/kiln.config.ts:8`, `apps/jags-list/src/main.ts:71` — delete `promoteAfterHits` lines
- Create: `apps/jags-list/tests/purity.integration.test.ts`
- Modify: `apps/jags-list/package.json` scripts — add `"test:purity": "RUN_APP_TESTS=1 bun --env-file=.env test tests/purity.integration.test.ts"`

**Interfaces:**
- Consumes: the auto classifier (Task 3) — every jags-list page reads `req.locals` in `load()` or redirects via the handle hook, so with the exports deleted, all of them classify impure and stay pure SSR with **zero** configuration. This is the whole point of the plan.

- [ ] **Step 1: Write the failing-by-construction regression test**

Model the harness on `tests/app.integration.test.ts` (Bun.spawn of `src/main.ts` on a private port, `createAppUser` seeding, `RUN_APP_TESTS=1` skip guard):

```ts
// apps/jags-list/tests/purity.integration.test.ts
// Guards the bake classifier: a session-reading page must never serve one
// user's render to another, no matter how many hits the route takes.
// (Regression for framework bug "absent promote_after is not pure SSR".)
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

const PORT = 3298;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'itest-password-1';
const TOM = 'purity-tom@example.com';
const ADAM = 'purity-adam@example.com';
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function login(email: string): Promise<string> {
  // Mirror the sign-in call used by tests/app.integration.test.ts; if that
  // file logs in via a different endpoint/shape, copy it exactly.
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

describe.skipIf(!run)('cross-user render isolation', () => {
  beforeAll(async () => {
    await sql`DELETE FROM "user" WHERE email IN (${TOM}, ${ADAM})`;
    await createAppUser({ email: TOM, password: PASSWORD, name: 'Purity Tom', role: 'user', handle: 'puritytom' });
    await createAppUser({ email: ADAM, password: PASSWORD, name: 'Purity Adam', role: 'user', handle: 'purityadam' });
    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try {
        const r = await fetch(`${BASE}/login`);
        if (r.status === 200) return;
      } catch {}
      await Bun.sleep(200);
    }
    throw new Error('app did not start on ' + BASE);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM "user" WHERE email IN (${TOM}, ${ADAM})`;
    await sql.close();
  });

  it('never serves one user\'s home render to the other, on any hit', async () => {
    const tomCookie = await login(TOM);
    const adamCookie = await login(ADAM);
    // 4 alternating hits > the old promote-after-2 threshold: under the old
    // behavior hit 3+ served whoever-baked-it to everyone.
    for (let hit = 0; hit < 4; hit++) {
      const tomHtml = await (await fetch(BASE + '/', { headers: { cookie: tomCookie } })).text();
      const adamHtml = await (await fetch(BASE + '/', { headers: { cookie: adamCookie } })).text();
      expect(tomHtml).toContain('Purity Tom');
      expect(tomHtml).not.toContain('Purity Adam');
      expect(adamHtml).toContain('Purity Adam');
      expect(adamHtml).not.toContain('Purity Tom');
    }
  });
});
```

(If the home page doesn't render the display name, target a page that does — `pages/team.tsx` renders member names; keep the alternating-hits structure.)

- [ ] **Step 2: Delete the workaround exports and config lines** (files listed above). In `index.tsx`, the comment at lines 6-7 referencing `bugs-active.md "absent promote_after"` goes too.

- [ ] **Step 3: Run everything**

Run: `cd .worktrees/bake-classes/apps/jags-list && bun run build && bun test && RUN_APP_TESTS=1 bun --env-file=.env test tests/app.integration.test.ts tests/crud.integration.test.ts tests/purity.integration.test.ts`
Expected: build (tsc) clean; all suites PASS, including the new isolation test.

- [ ] **Step 4: Commit**

```bash
cd .worktrees/bake-classes && git add apps/jags-list
git commit -m "feat(jags-list): drop promote_after workarounds; add cross-user render isolation test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, ADR, and framework memory

**Files:**
- Modify: `docs/agents/rendering-and-caching.md` (replace the promote_after section with the bake table below)
- Modify: `.claude/skills/kiln/SKILL.md` (same replacement wherever promote_after appears — `grep -n promote_after .claude/skills/kiln/SKILL.md`)
- Modify: `docs/baked-shell-architecture.md` (update promote_after references)
- Modify: `.memory/features.md` (promotion semantics section), `.memory/architecture.md` (if it mentions hit counts — grep), `.codebase-memory/adr.md` + `.memory/decisions.md` (add ADR-016)
- Modify: `.memory/bugs-active.md` (delete bug #1) and `.memory/bugs-resolved.md` (add its resolution entry)

- [ ] **Step 1: Author the canonical bake table** (used verbatim in each doc):

```markdown
| `export const bake` | Behavior |
|---|---|
| *(absent)* | **Auto.** Bakes on the first render whose `load()` never touched `req.locals`/`headers`/`query`/`raw`/body. One identity-touching render demotes the route to pure SSR for the process lifetime and deletes stale artifacts. Session pages need **no** declaration. |
| `'static'` | Prebaked at startup when `entries()` exists; otherwise bakes on first request. |
| `'shared'` | Always bakes on first render, even if identity was accessed (dev-mode warning). |
| `false` | Pure SSR. Never cached. Escape hatch for impurity the tracker can't see (e.g. `load()` reading per-user rows directly). |

`promote_after` / `fsr.promoteAfterHits` no longer exist; exporting them fails boot.
```

- [ ] **Step 2: Write ADR-016** in `.memory/decisions.md` (and mirror into `.codebase-memory/adr.md`):

```markdown
## ADR-016: Bake classes replace hit-count promotion (2026-07-19)

**Decision.** Routes are classified by observing `load()` (purity tracker
Proxy), not by counting hits. Artifact presence is promotion; the first pure
render bakes; eviction (purge_after / last_requested_at) — not admission —
controls cache population. `kiln_fsr` columns hit_count / promoted /
promote_after / promoted_at / last_hit are dropped; the watcher derives
promoted-ness from `html_path IS NOT NULL`. The read path performs zero
Postgres queries (touchRoute is throttled to 60s, fire-and-forget;
tombstone is checked only at bake time).

**Why.** promote-after-N measured popularity when the correct gate is
cacheability; it cached per-user pages after N hits (bug: "absent
promote_after is not pure SSR"), added a per-request UPDATE, and kept a
dual-mode route lifecycle where most FSR bugs lived.

**Supersedes** ADR-003's promotion semantics. **Amends** ADR-015: the
`promote_after = false` requirement for session pages is obsolete — the
classifier handles them with no declaration; `bake = false` remains as an
explicit escape hatch. Follow-ups: Plan 2 (per-user snapshots), Plan 3
(auto-deps + sync-triggers).
```

- [ ] **Step 3: Move the bug.** Delete section 1 from `.memory/bugs-active.md`; append to `.memory/bugs-resolved.md`:

```markdown
*   **Absent `promote_after` was not pure SSR (2026-07-14 → resolved 2026-07-19)** — routes omitting the export fell through to `fsr.promoteAfterHits` (2) and got cached cross-user. Resolved by ADR-016 bake classes: identity-reading renders can never bake; `promote_after` removed entirely. Regression-guarded by `apps/jags-list/tests/purity.integration.test.ts`.
```

- [ ] **Step 4: Commit**

```bash
cd .worktrees/bake-classes && git add docs .claude/skills/kiln .memory .codebase-memory
git commit -m "docs: bake classes (ADR-016); resolve absent-promote_after bug

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full-repo verification & PR

- [ ] **Step 1: Sweep for stragglers**

Run: `cd .worktrees/bake-classes && grep -rn "promote_after\|promoteAfter" packages test-app apps examples docs/agents .claude/skills --include="*.ts" --include="*.tsx" --include="*.md" | grep -v node_modules | grep -v dist | grep -v "has been removed" | grep -v bugs-resolved`
Expected: no hits (dist/ regenerates on build; archived docs under `docs/archive/` are historical and exempt).

- [ ] **Step 2: Typecheck every package + run every suite**

```bash
cd .worktrees/bake-classes
for p in packages/*/; do (cd "$p" && bunx tsc --noEmit) || echo "TSC FAIL $p"; done
bun test packages/routekit packages/core
bun --env-file=test-app/.env test packages/engine
cd apps/jags-list && bun run build && bun test && RUN_APP_TESTS=1 bun --env-file=.env test tests/
```

Expected: all clean/PASS. Fix anything that fails before proceeding — evidence before assertions.

- [ ] **Step 3: Open the PR**

```bash
cd .worktrees/bake-classes && git push -u origin bake-classes
gh pr create --title "Bake classes: promote_after removed, first-pure-render baking (ADR-016)" --body "$(cat <<'EOF'
Plan 1 of the FSR redesign (docs/superpowers/plans/2026-07-19-bake-classes.md).

- Purity tracker observes load(); identity-reading renders never bake (fixes: absent promote_after was not pure SSR)
- Artifact presence is promotion — hit_count/promoted/promote_after columns dropped, incrementHit deleted
- Zero Postgres on the cached read path (throttled touchRoute; tombstone checked at bake time only)
- bake export: 'static' | 'shared' | false | absent=auto; promote_after fails boot (hard removal per user decision)
- jags-list workaround exports deleted; new cross-user isolation regression test
- ADR-016; supersedes ADR-003 promotion semantics, obsoletes ADR-015 workaround

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed at authoring time)

- **Spec coverage:** classifier ✓ (T1,T3) · bake API + hard removal ✓ (T2) · first-render baking + demotion ✓ (T3) · layout purity ✓ (T3 step 4) · zero-DB reads ✓ (T3 steps 1,3; T5) · static prebake ✓ (T4) · schema/watcher ✓ (T5,T6) · app migrations ✓ (T7,T8) · cross-user regression ✓ (T8) · docs/ADR/bug closure ✓ (T9).
- **Compile-clean ordering:** T3 calls the old 5-arg `ensureRouteRow` with `null`; T5 changes both ends in one commit. `promoteAfterHits` stays typed in config until T6, after boot stops reading it in T3.
- **Known limitation (accepted, documented in ADR-016):** purity is observed per-render and latched per-process; a route whose `load()` only *conditionally* accesses identity could bake a pure-looking render first. jags-list has no such route (every page reads `locals` unconditionally); `bake = false` remains the escape hatch. Revisit in Plan 2 when identity becomes part of the cache key.
