# Per-User Artifacts (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give session-gated pages the baked-artifact fast path: `bake = 'user'` caches full HTML+JSON per `(route, user)`, keeps them fresh via per-user watcher loaders and live patches, guarantees read-your-own-writes after actions, and adds build-id deploy invalidation.

**Architecture:** A new app-level `identity(req)` hook (sibling of ADR-015's `handle`) resolves a stable user key per request. `bake = 'user'` routes reuse the existing variant plumbing with a framework-computed variant `u:<id>` — full per-user artifacts in this plan; the shared-shell/per-user-snapshot split is **deferred to Plan 3** because it requires every user-varying field to be live-marked. The `kiln_fsr` tables gain a `user_key` dimension so slots, loaders, and SSE patches are scoped per `(route, user)`; the hub authorizes subscriptions with `identity(req)` server-side. Actions delete the acting user's artifacts before responding (simplest correct read-your-own-writes; eager re-materialization is a later optimization). `fsr.buildId` folds into the snapshot signature so deploys invalidate without the manual flush ADR-016 requires.

**Tech Stack:** Bun, TypeScript, Postgres (bun-sql), Redis, bun:test. No new dependencies.

## Global Constraints

- Follows ADR-016 (merged as PR #12): artifact presence is promotion; purity classifier stays authoritative for `auto` routes. `'user'` is an explicit opt-in like `'shared'` — the purity tracker does not demote it (identity access is the point), but a dev-mode warn fires if `identity()` returns null on every render (misconfigured hook).
- `bake = 'user'` combined with `cache_key` is a boot error (`StartupError('RemovedOption')` reused with a distinct message) — two conflicting cache keyings.
- Every task ends `bunx tsc --noEmit`-clean in touched packages with that package's tests passing. Commit per task, messages ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Execution on a fresh worktree (superpowers:using-git-worktrees at execution start); **cd into the worktree explicitly in every Bash call**; rebuild `@kiln/*` dists before any app-level verification (apps run against dist — Plan 1 lesson).
- Known accepted staleness: a per-user loader captures the user's `locals` at registration; role changes propagate on that user's next real request, not instantly. Documented in ADR-017.
- Out of scope (Plan 3): shared-shell dedup (one shell + per-user JSON), auto-derived `depends_on` from observed SQL, `kiln sync-triggers`, active/dormant freshness tiers, eager actor re-materialization.

**Existing behavior that must NOT change:** `auto`/`'shared'`/`'static'`/`false` semantics, `cache_key` variants (still no live registration — the `warnOnce` stays for them), layout pattern caching, tombstones, the zero-Postgres cached read path (per-user reads are still Redis/disk-only; the throttled `touchRoute` covers recency).

---

### Task 1: `identity` hook type + config + `bake: 'user'` option

**Files:**
- Modify: `packages/core/src/types.ts` (next to `KilnHandle`, ~line 61) — add `KilnIdentity`
- Modify: `packages/core/src/config.ts` — `FsrConfig` gains `buildId?: string`
- Modify: `packages/routekit/src/page-options.ts` — `BakeMode` gains `'user'`
- Test: `packages/routekit/src/page-options.test.ts`

**Interfaces:**
- Produces: `type KilnIdentity = (req: KilnRequest) => string | null` (exported from `@kiln/core`); `PageOptions.bake` now `'static' | 'shared' | 'user' | false`; `extractPageOptions` throws when a module has both `bake === 'user'` and a `cache_key`/`cacheKey` export. Tasks 3–9 consume exactly these.

- [ ] **Step 1: Write the failing tests** (append to `page-options.test.ts`):

```ts
describe('bake user mode', () => {
  it("accepts bake='user'", () => {
    expect(extractPageOptions({ bake: 'user' }).bake).toBe('user');
  });

  it("rejects bake='user' combined with cache_key", () => {
    expect(() => extractPageOptions({ bake: 'user', cache_key: () => 'x' }))
      .toThrow(/user.*cache_key|cache_key.*user/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/routekit/src/page-options.test.ts` → FAIL (`'user'` hits the invalid-bake throw).

- [ ] **Step 3: Implement.** In `page-options.ts`: `export type BakeMode = 'static' | 'shared' | 'user' | false;`, accept `'user'` in the parse branch, and after the `cacheKey` resolution add:

```ts
  if (bake === 'user' && typeof cacheKey === 'function') {
    throw new StartupError(
      'RemovedOption',
      "[kiln] bake='user' and cache_key are mutually exclusive — 'user' IS a cache key (the identity hook's user id)."
    );
  }
```

In `core/src/types.ts`, directly under the `KilnHandle` type:

```ts
/** Resolves the stable user key for per-user caching (bake = 'user').
 * Runs after `handle`, so req.locals is populated. Return null for
 * anonymous requests — 'user' pages then fall back to pure SSR.
 * MUST return a stable id (user id), never a session token. */
export type KilnIdentity = (req: KilnRequest) => string | null;
```

Update both `bake?:` fields in `types.ts` (PageDefinition/LayoutDefinition) and `manifest.ts`'s `PageRoute.bake` to include `'user'`. In `config.ts` `FsrConfig` add: `/** Deploy fingerprint (e.g. git SHA). When set, baked snapshots record it and a mismatch on read forces a re-bake — replaces the manual cache flush across deploys. */ buildId?: string;`

- [ ] **Step 4: Verify** — page-options tests PASS; `bunx tsc --noEmit` clean in `core` (rebuild `core` dist: `cd packages/core && bun run build`) and `routekit`.
- [ ] **Step 5: Commit** — `feat(core,routekit): KilnIdentity hook type, fsr.buildId, bake='user' option`

---

### Task 2: `user_key` dimension in schema + store

**Files:**
- Modify: `packages/engine/src/schema.ts` — `kiln_fsr` and `kiln_fsr_lists` PKs gain `user_key TEXT NOT NULL DEFAULT ''`
- Modify: `packages/engine/src/store.ts` — `ensureRouteRow`, `upsertSlot`, `setBakedPaths`, `getPromotedPaths`, `touchRoute`, `fetchStaleSlots`, `fetchSlotsForSnapshot`, `markFresh`, `tombstone` gain a trailing `userKey = ''` param threaded into WHERE/INSERT
- Test: `packages/engine/src/store.test.ts`

**Interfaces:**
- Produces: every store method keeps its current call signature valid (new param defaulted to `''` = the route-level/shared row — zero churn for existing callers) and accepts a `userKey` to scope per-user rows. `StaleSlot` gains `userKey: string`.

- [ ] **Step 1: Failing test** (append to `store.test.ts` before the tombstone section):

```ts
    // user-scoped rows coexist with the shared row
    console.log('Testing user_key scoping...');
    await store.ensureRouteRow('/u-route', 300, 3600, 'json');
    await store.ensureRouteRow('/u-route', 300, 3600, 'json', 'u1');
    await store.setBakedPaths('/u-route', '/tmp/u1.html', '/tmp/u1.json', 'u1');
    assert.equal((await store.getPromotedPaths('/u-route'))?.htmlPath ?? null, null); // shared row unbaked
    assert.equal((await store.getPromotedPaths('/u-route', 'u1'))?.htmlPath, '/tmp/u1.html');
    await store.upsertSlot('/u-route', 'tasks', null, [], ['tasks_dep'], 0, null, 'u1');
    const uSlots = await store.fetchSlotsForSnapshot('/u-route', [], 'u1');
    assert.equal(uSlots.length, 1);
    assert.equal(uSlots[0].userKey, 'u1');
    assert.equal((await store.fetchSlotsForSnapshot('/u-route', [])).length, 0); // shared scope empty
```

Run with `bun --env-file=test-app/.env packages/engine/src/store.test.ts` → FAIL.

- [ ] **Step 2: Schema.** In the CREATE TABLEs add `user_key TEXT NOT NULL DEFAULT '',` after `slot`, and change PKs to `PRIMARY KEY (route, user_key, slot)`. Append migration statements (same idempotent style as the ADR-016 drops):

```sql
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS user_key TEXT NOT NULL DEFAULT '';
ALTER TABLE kiln_fsr DROP CONSTRAINT IF EXISTS kiln_fsr_pkey;
ALTER TABLE kiln_fsr ADD CONSTRAINT kiln_fsr_pkey PRIMARY KEY (route, user_key, slot);
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS user_key TEXT NOT NULL DEFAULT '';
ALTER TABLE kiln_fsr_lists DROP CONSTRAINT IF EXISTS kiln_fsr_lists_pkey;
ALTER TABLE kiln_fsr_lists ADD CONSTRAINT kiln_fsr_lists_pkey PRIMARY KEY (route, user_key, name);
```

- [ ] **Step 3: Store.** Add the trailing `userKey = ''` param to each listed method; every `WHERE route = ${route} AND slot = ...` gains `AND user_key = ${userKey}`; `ensureRouteRow`'s INSERT adds the column; `fetchStaleSlots`' claim query RETURNING adds `s.user_key as "userKey"` (and the JOIN matches `r.user_key = s.user_key`); `fetchSlotsForSnapshot` filters `AND s.user_key = ${userKey}`; map `userKey` into `StaleSlot`. `tombstone(route)` stays route-wide (no userKey filter — a tombstone kills all users' rows deliberately).

- [ ] **Step 4: Verify** — store integration test PASSES; `bun run test:integration` fully green; engine tsc clean; rebuild engine dist.
- [ ] **Step 5: Commit** — `feat(engine): user_key dimension on kiln_fsr/_lists; store methods accept userKey`

---

### Task 3: Thread `identity` from the app to the framework

**Files:**
- Modify: `packages/routekit/src/boot.ts` — `StartKilnOptions` gains `identity?: KilnIdentity`; `startKiln` passes it to every `buildPageHandler`/`buildActionHandler` call; `buildPageHandler` gains an `identity` param
- Modify: the hooks-loading path — find where `handle` reaches the adapter (`grep -n "handle" packages/adapter-elysia/src/*.ts packages/routekit/src/boot.ts` — ADR-015 wired it via the adapter's `applyServerHooks`/hook registration; mirror EXACTLY that mechanism so `hooks.ts` can `export const identity: KilnIdentity = ...` and it arrives at `startKiln` the same way `handle` arrives at the adapter)
- Test: `packages/routekit/src/boot.test.ts` — handler-construction helpers accept an optional identity fn

**Interfaces:**
- Produces: inside `handle()` (and the action handler), `identity` is available as `(req) => string | null`, already running AFTER the app's `handle` hook (the adapter invokes the hook before the route handler, so `req.locals` is populated when the page handler runs — same guarantee ADR-015 gives `load()`).

- [ ] **Step 1:** Locate the ADR-015 `handle` wiring; add `identity` beside it end-to-end (app `hooks.ts` export → adapter/startKiln option → `buildPageHandler(…, identity)` / `buildActionHandler(…, identity)`).
- [ ] **Step 2:** boot.test.ts: add an `identity` argument to the test helper that builds handlers (default `undefined`), no behavior assertions yet (Task 4 tests behavior).
- [ ] **Step 3:** tsc clean in routekit + adapter-elysia; `bun test packages/routekit` green.
- [ ] **Step 4: Commit** — `feat(routekit,adapter-elysia): thread app identity hook into page/action handlers`

---

### Task 4: `bake='user'` request lifecycle in `handle()`

**Files:**
- Modify: `packages/routekit/src/boot.ts` (`buildPageHandler.handle`, the preamble around the `variant`/`bakeMode` block)
- Test: `packages/routekit/src/boot.test.ts`

**Interfaces:**
- Consumes: `identity` (Task 3), store `userKey` params (Task 2). Produces: per-user artifacts via the existing variant plumbing with `variant = 'u:' + uid` and `userKey = uid` on store writes.

- [ ] **Step 1: Failing tests** (append to the promotion describe block; follow the file's existing handler-helper pattern):

```ts
  it("bake='user' serves each user their own cached artifact and SSRs anonymous", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-user-'));
    const { createElement } = await import('react');
    let loads = 0;
    const mod = {
      bake: 'user',
      load: async (req: any) => { loads++; return { who: (req.locals as any).user ?? 'anon' }; },
      default: ({ who }: any) => createElement('div', null, `hello ${who}`),
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    const handler = buildHandlerForTest(mod, tmpDir, identity); // helper extended in Task 3
    // tom: hit 1 bakes his variant, hit 2 serves it (no load)
    await handler(makeReq({ path: '/mine', locals: { user: 'tom' } }) as any, makeRes());
    const tom2 = makeRes();
    await handler(makeReq({ path: '/mine', locals: { user: 'tom' } }) as any, tom2);
    expect(tom2.captured.body).toContain('hello tom');
    expect(loads).toBe(1);
    // adam: his own variant, never tom's
    const adam = makeRes();
    await handler(makeReq({ path: '/mine', locals: { user: 'adam' } }) as any, adam);
    expect(adam.captured.body).toContain('hello adam');
    expect(adam.captured.body).not.toContain('tom');
    expect(loads).toBe(2);
    // anonymous: pure SSR every hit, no artifacts
    await handler(makeReq({ path: '/mine', locals: {} }) as any, makeRes());
    await handler(makeReq({ path: '/mine', locals: {} }) as any, makeRes());
    expect(loads).toBe(4);
    await fs.rm(tmpDir, { recursive: true });
  });
```

- [ ] **Step 2: Run → FAIL** (`'user'` currently rejected by page-options only if Task 1 skipped; with Task 1 in, cache misses per variant undefined → loads=4 too early).

- [ ] **Step 3: Implement.** In `handle()`'s preamble, replace the `variant` line with:

```ts
    let uid: string | null = null;
    let variant = options.cacheKey ? options.cacheKey(req) : undefined;
    if (bakeMode === 'user') {
      uid = identity ? identity(req) : null;
      if (uid === null) {
        // Anonymous (or no identity hook): a per-user page has no cache key
        // for this request — serve pure SSR, write nothing.
        if (!identity) warnOnce(`user-no-identity:${pageMeta.pattern}`,
          `[kiln] route "${pageMeta.pattern}" declares bake='user' but no identity hook is configured; serving pure SSR.`);
      } else {
        variant = `u:${uid}`;
      }
    }
    const userKey = uid ?? '';
```

`bakeEligible` becomes `bakeMode !== false && !knownImpure && !(bakeMode === 'user' && uid === null)`. In step 11, `autoMode` stays as-is (`'user'` is explicit → no purity demotion; drop the dev impure-warn for `'user'` since identity access is expected), and `shouldBake` needs no change beyond `bakeEligible`. `setBakedPaths`/`ensureRouteRow` calls pass `userKey`; the `if (store && !variant)` guards around `setBakedPaths` become `if (store && (!variant || bakeMode === 'user'))` so user variants DO record baked paths (under their `user_key` row) while `cache_key` variants keep today's behavior.

- [ ] **Step 4: Verify** — new test PASSES, full `bun test packages/routekit` green, tsc clean.
- [ ] **Step 5: Commit** — `feat(routekit): bake='user' — per-user artifacts keyed by the identity hook`

---

### Task 5: Snapshot `pageData`, `buildId` signature, cached-JSON serving

**Files:**
- Modify: `packages/engine/src/baking.ts` — `BakedSnapshot` gains `pageData?: Record<string, unknown>` and `buildId?: string`; `createBakedSnapshot(data, lists?, layoutSignature?, extras?: { pageData?; buildId? })`
- Modify: `packages/routekit/src/boot.ts` — step 11 passes `{ pageData: pageProps, buildId: kilnConfig?.fsr?.buildId }`; step 3's cache-hit validation treats a `buildId` mismatch exactly like a layout-signature mismatch (delete + fall through to re-bake); step 2 (`wantsJson`) serves the cached snapshot's `pageData` when `bakeEligible` and the artifact validates (signature + buildId), else falls through to today's fresh `load()`
- Test: `packages/routekit/src/boot.test.ts`

**Interfaces:**
- Produces: `snapshot.pageData` = page-only props (what today's JSON path returns), distinct from `snapshot.data` = layout-merged seed. JSON responses are byte-shape-compatible with today's.

- [ ] **Step 1: Failing tests:** (a) baked route + `Accept: application/json` second hit returns the same JSON as the first without re-running `load()` (spy on loads); (b) changing the handler's configured `fsr.buildId` between two requests forces a fresh render on the next hit. Write both in boot.test.ts with the existing helpers, run → FAIL.
- [ ] **Step 2: Implement** per the file list above. The JSON cache read is `await cache.getJson(req.path, variant)` — already variant-aware, so `'user'` pages get per-user JSON for free (this is the "button click → one file read" payoff).
- [ ] **Step 3: Verify + commit** — `feat(engine,routekit): snapshot pageData + buildId; cached JSON serving; deploy invalidation`

---

### Task 6: Per-`(route, user)` watcher loaders + live registration for user pages

**Files:**
- Modify: `packages/routekit/src/boot.ts` — `makeLoaderRequest(req, opts?: { includeLocals?: boolean })`: when `includeLocals`, carry `locals: structuredClone(req.locals)` (the identity snapshot; header comment documents the role-staleness caveat). Both `registerLoader` call sites and `registerLiveLists` pass `route: userKey ? \`${req.path}::u:${userKey}\` : req.path`... **no** — keep `route` pure and extend the loader registry key instead: `watcher.registerLoader({ route, userKey, load })`.
- Modify: `packages/engine/src/watcher.ts` — loader registry keyed `route + ' ' + userKey`; refresh loop passes `slotRow.userKey` when selecting the loader and when calling `markFresh`/`fetchSlotsForSnapshot`; patches carry `userKey`.
- Modify: `packages/routekit/src/boot.ts` — the variant-live `warnOnce` at the step-11 area now fires only for `cache_key` variants (`variant && bakeMode !== 'user'`); `'user'` pages register slots (`store.upsertSlot(..., userKey)`) and loaders normally.
- Test: `packages/engine/src/watcher.test.ts` — a user-scoped slot (`upsertSlot(route, slot, …, 'u1')`) goes stale via `invalidateDepKey`, the watcher re-runs the `(route,'u1')` loader, and the patch lands in that user's artifact paths (setBakedPaths under `'u1'`), never the shared row's.

**Interfaces:**
- Produces: `SlotPatch`/loader plumbing carries `userKey: string` end-to-end. Task 7 consumes it for SSE scoping.

- [ ] Steps: failing watcher test → implement → `bun run test:integration` green → commit `feat(engine,routekit): per-(route,user) loaders; live updates for bake='user' pages`.

---

### Task 7: Hub — per-user SSE authorization and delivery

**Files:**
- Modify: `packages/engine/src/hub.ts` — the subscription options gain `userKey?: string`; the patch filter `if (patch.route !== route) continue;` also requires `((patch as any).userKey ?? '') === (userKey ?? '')`; snapshot endpoints scope `fetchSlotsForSnapshot(route, slots, userKey)`.
- Modify: the `/__kiln/fsr` registration in `boot.ts`/adapter — compute `userKey = identity?.(req) ?? ''` **server-side from the request's own session** (never from a query param), and pass it into the hub subscription. A user thus physically cannot subscribe to another user's patch stream — there is nothing to spoof.
- Test: `packages/engine/src/hub.test.ts` — two subscriptions to the same route with different `userKey`s; a patch published with `userKey:'u1'` reaches only the first.

- [ ] Steps: failing hub test → implement → integration suite green → commit `feat(engine): SSE patches scoped and authorized per user via the identity hook`.

---

### Task 8: Read-your-own-writes — actions invalidate the actor's artifacts

**Files:**
- Modify: `packages/routekit/src/boot.ts` — `buildActionHandler(actions, opts?: { cache?: KilnCache; identity?: KilnIdentity; bake?: BakeMode })`; `startKiln`'s `adapter.registerAction(page.pattern, buildActionHandler(mod.actions, { cache: new KilnCache(cacheOpts), identity: options.identity, bake: extractPageOptions(mod).bake }))`
- Test: `packages/routekit/src/boot.test.ts`

- [ ] **Step 1: Failing test:** a `bake='user'` page is baked for tom (cache hit confirmed), then tom POSTs an action that mutates the module's backing value; the very next GET as tom renders fresh (loads incremented), while adam's cached artifact is untouched.
- [ ] **Step 2: Implement.** In `buildActionHandler`, after a successful action (both the `res.json(result)` path and the Redirect catch), before responding:

```ts
      if (opts?.bake === 'user' && opts.cache && opts.identity) {
        const uid = opts.identity(req);
        // The actor must see their own write on the redirect GET — racing the
        // watcher's async re-materialization here reads as "my click didn't
        // work". Deleting forces a fresh render for exactly one user.
        if (uid) await opts.cache.delete(req.path, `u:${uid}`);
      }
```

- [ ] **Step 3: Verify + commit** — `feat(routekit): actions delete the actor's per-user artifacts (read-your-own-writes)`

---

### Task 9: jags-list dogfood — identity hook, `bake='user'` pages, tests

**Files:**
- Modify: `apps/jags-list/hooks.ts` — add:

```ts
import type { KilnIdentity } from '@kiln/core';
import type { SessionUser } from './lib/session.js';

/** Stable per-user cache key for bake='user' pages (ADR-017). User id, never
 * the session token — sessions rotate and multiply per device. */
export const identity: KilnIdentity = (req) =>
  (req.locals.user as SessionUser | undefined)?.id ?? null;
```

- Modify: `apps/jags-list/src/main.ts` — pass `identity` wherever `handle` is passed (Task 3 wiring); set `fsr: { buildId: process.env.GIT_SHA }` in `kiln.config.ts` (optional env).
- Modify: `apps/jags-list/pages/index.tsx` and `pages/team.tsx` — `export const bake = 'user';` (comments updated: cached per user, fresh after own actions).
- Modify: `apps/jags-list/tests/purity.integration.test.ts` — the isolation loop stays (now proving per-user *caching* isolation, not just SSR isolation); add a read-your-own-writes test: admin cookie POSTs `?/createInvite` on `/team`, the redirect-followed GET contains the new invite row.
- Test additions run under the existing `test:purity` script.

- [ ] Steps: write failing RYW test → migrate pages/hook → rebuild `@kiln/*` dists → `bun run build` + unit + `RUN_APP_TESTS=1` app/crud/purity suites (separate invocations — shared sql client, Plan 1 lesson) all green → commit `feat(jags-list): per-user cached home/team via bake='user' + identity hook; RYW test`.

---

### Task 10: Docs, ADR-017, verification, PR

- [ ] `docs/agents/rendering-and-caching.md` + `.claude/skills/kiln/SKILL.md`: add the `'user'` row to the bake table ("cached per `(route, user id)` via the `identity` hook; actions invalidate the actor's copy; live patches are per-user and SSE-authorized server-side"); document `fsr.buildId` (replaces the manual deploy flush); `docs/agents/auth.md` gains the `identity` export recipe step.
- [ ] ADR-017 in `.memory/decisions.md` + `.codebase-memory/adr.md`: per-user artifacts on the variant mechanism; identity hook contract (stable id, never session token); RYW-by-deletion; per-user SSE authorization; accepted role-staleness caveat; shared-shell dedup deferred to Plan 3 with rationale (requires live-marking of all user-varying fields).
- [ ] Straggler grep (`promoteAfterHits` is gone; check no `bake === 'user'` path leaks `uid` into logs), full battery: tsc × all packages/apps, `test:unit`, `test:integration`, jags-list suites, `prove-baking.ts`.
- [ ] Push branch, `gh pr create` (body: what/why, the SSE-authorization security note, the role-staleness caveat, verification evidence), ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-Review (at authoring time)

- **Spec coverage:** per-user fast path ✓ (T4,T5) · identity contract ✓ (T1,T3) · live-on-user-pages incl. the Plan-1 `warnOnce` carve-out ✓ (T6,T7) · RYW ✓ (T8) · deploy invalidation ✓ (T5) · dogfood + regression ✓ (T9) · docs/ADR ✓ (T10).
- **Type consistency:** `KilnIdentity` (T1) consumed by T3/T4/T7/T8/T9; store `userKey` trailing-param shape (T2) used in T4/T6/T7; `variant = 'u:'+uid` string agreed across T4/T5/T8.
- **Sequencing compiles at every boundary:** T2 defaults keep old callers valid; T3 threads identity before T4 uses it; T6's watcher changes land before T7 consumes `userKey` on patches.
- **Deliberate scope cuts** (stated in Global Constraints): shared shells, auto-deps, eager re-materialization → Plan 3.
