# Kiln Project Roadmap

Last updated: 2026-07-27

---

## Completed Milestones

### V1 Baseline
- [x] **Field-Selective Rendering Engine**: Event-driven watcher, SSE hub, field-level cache invalidation
- [x] **Layout-Aware Route Swapping**: `X-PS-Present` headers, `silcrow-target`, layout fragment negotiation
- [x] **Live Lists (`Live.list`)**: Row-level diffs (replace-row, insert, move, remove) via embedded watcher
- [x] **Pattern-Level Layout Caching** (ADR-011): `_layout.tsx` baked once per URL pattern, `layoutSignature` staleness detection
- [x] ~~**Acceptance Testing App**: `examples/address-book`~~ — served its purpose and was **deleted 2026-07-30**; `apps/jags-list` is now the dogfood/acceptance app.

### Infrastructure & DX
- [x] **Git-Based Context Portability**: `.memory/` directory for version-controlled agent context
- [x] **Relative Config Paths**: All AI config files use relative paths, portable across checkouts
- [x] **Standardised Git Hooks**: `post-commit` + `post-merge` run `code-review-graph update`
- [x] **tsc clean across all packages**: `core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`

### Features Shipped in Main (2026-07-08)
- [x] **Image Optimization** (`/_image` endpoint, sharp, disk cache, webp/jpeg/png, domain allowlist)
- [x] **Internationalisation** (`KilnI18n`, `@fluent/bundle`, `.ftl` files, `Accept-Language` negotiation)
- [x] **Service Worker** (`generateServiceWorker()`, 3 strategies, precache, offline fallback — no Workbox)
- [x] **`json_first` page export** (ADR-012): Pages declare themselves JSON-only endpoints; eliminates `api/` directory need
- [x] **Built-in middleware**: CSRF, request timeout (30 s), layout intercept, tracing, server hooks
- [x] **`_error.tsx` / `_loading.tsx` / `_not-found.tsx`** per-directory UI conventions
- [x] **Collocated actions**: `export const actions = { name(req) }` — POST handlers on page files
- [x] **Typed error system**: `AppError`, `AppResult<T>`, `success()`, `failure()`
- [x] **Four cache providers**: `memory | filesystem | sqlite | redis`

---

## Phase 3: Feature Consolidation

1. **Make Redis fully optional** ✅ — Production guard now only requires `postgresUrl`. `startKiln()` auto-wires `KilnCache` Redis from `config.fsr.redisUrl`; `FsrWatcher` falls back to polling when Redis absent; SSE hub was always in-process only.
2. **`apiDir` removed** ✅ — Field deleted from `KilnConfig`, merge logic, `create-kiln` template, and `test-app/kiln.config.ts`. Use `json_first = true` on page files instead.
3. **`@kiln/client` asset resolution cleaned up** ✅ — Removed stale `resolveSilcrowJs()` from `cli.ts` (was searching for old `silcrow` package name). `boot.ts` already used `import.meta.resolve('@kiln/client/silcrow.js')` correctly; `@kiln/client` exports were already correct.

---

## Phase 4: Hardening & Scalability

1. **Cache Partitioning** ✅ — Pages export `cacheKey(req): string`; each variant gets its own disk (`_v/<variant>/`) and Redis (`kiln:html:<route>:v:<variant>`) cache entry. Variant routes skip watcher path registration (re-bake on invalidation). Implemented across `KilnCache`, `PageOptions`, and `buildPageHandler`.
2. **External Watcher Process** — STILL OPEN, and *not* "partially implemented" as previously
   recorded: investigated 2026-07-29 and there is **no** implementation. The only three references
   are the type union, a read-path branch that re-runs `load()` on every cache hit, and the
   `Live.list` guard. No watcher process, IPC channel or daemon. Net behaviour of setting it is
   "no watcher, re-load every time", which forfeits the caching live routes exist for — the config
   doc now says so.
   **Blocked on an architecture decision:** an out-of-process watcher must invoke a `Live.list`'s
   closures (`keyOf`, `query`, and a `renderRows` callback that SSRs the page component). Closures
   cannot cross a process boundary, and `renderRows` needs the component graph loaded. Options: RPC
   back into the app process, or restrict external mode to scalar `Live.value` fields only. Needs a
   human call before implementation.
3. **Fine-Grained Debounce Scheduling** ✅ — Already implemented; verified and covered 2026-07-29.
   `fetchStaleSlots` gates on `COALESCE(s.debounce_secs, <global>)`, so each slot's own window
   decides eligibility and the global is only a fallback (same for lists in `list-store.ts`). The
   sweep *timer* is coarse, but slot eligibility is not — which is what this item wanted. It was
   unasserted; `store.test.ts` now proves it, and the test was falsified (replacing the COALESCE
   with the bare global makes it fail).
4. ~~**`address-book` Layout Migration**~~ — MOOT 2026-07-30: `examples/address-book` was deleted,
   so `ContactsLayout` no longer exists. **The framework hazard it exposed is still open**, and is
   the part worth keeping: the purity tracker deliberately does not track `params` ("params derive
   from the concrete path, which IS the cache key"). Since PR #27 that holds for a layout reading its
   OWN pattern's params, but NOT for one reading a DESCENDANT's — and `req.path` is untracked too.
   Such a layout is pattern-cached and serves one instance's chrome for all of them, the same class
   of bug PR #27 fixed, one level up. `ContactsLayout` was exactly that shape and was safe only
   because it also read `req.query`, which trips the tracker. Fix: warn (or demote) when a layout's
   `load()` reads a param outside `layoutParamNames(pattern)`, or reads `req.path`.

---

## Phase 5: DX & Maintainability Backlog

Raised by the 2026-07-27 source audit at `758eb44`. The correctness defects from the same audit are
**not** here — all six were fixed on `fix/emit-event-non-bigint-id` and archived in
[bugs-resolved.md](bugs-resolved.md) §1.

**All nine items below were completed on 2026-07-29** by the framework-backlog run
(`docs/superpowers/plans/2026-07-29-kiln-framework-backlog.md`). Kept, struck through, so the
audit's findings and their resolutions stay traceable.

1. ~~**Warn at sync time when a table has no `id` column**~~ — DONE. `sync-triggers` probes
   `information_schema.columns` and warns once per table, naming it and stating that only the
   table-level dep key will be emitted. Tested both directions (composite-PK table warns; a table
   with an `id` does not).

2. ~~**Cache bound methods in the `createKilnSql` Proxy**~~ — DONE. The `get` trap memoizes bound
   functions per property, so `sql.unsafe === sql.unsafe`. Test needs no database.

3. ~~**Break up `boot.ts`**~~ — DONE. 1592 → **470** lines, split into `page-render.ts` (820),
   `html-markers.ts` (202), `live-registration.ts` (106), `loader-request.ts` (64), plus
   `dedup.ts` (26) and `handler-types.ts` (18) to break dependency cycles. `./boot.js` keeps its
   full export surface via re-exports, so consumers and the barrel were untouched. Pure move,
   verified module-by-module.

4. ~~**Narrow `CacheProvider` to what ships**~~ — DONE. Now `'filesystem' | 'redis'`. The runtime
   guard stays for JS-authored configs and gained its first test.

5. ~~**Env-var overrides for deployment-critical config**~~ — DONE. `KILN_FSR_POSTGRES_URL`,
   `KILN_FSR_REDIS_URL`, `KILN_FSR_BUILD_ID`, `KILN_CACHE_URL`. `fsr`/`cache` are now copied into
   fresh objects so overrides cannot bleed into `DEFAULT_CONFIG`.

6. ~~**Runtime config validation**~~ — DONE. `defineConfig` validates ports, `images.quality`,
   `images.formats` and the second-based `fsr` knobs, naming the offending key and received value.
   Verified no in-repo config trips it.

7. ~~**Retire the deprecated config surface**~~ — DONE. `config.live`, `LiveConfig`,
   `fsr.idleEvictSecs` and `fsr.idleThresholdSecs` removed — including copies in `FsrWatcher` and
   four engine test suites. Behaviour-preserving: `idleThresholdSecs` was already dead in every
   test (the canonical `purgeAfterSeconds` was set alongside it and won).

8. ~~**Exercise auto-deps end-to-end in an app**~~ — CLOSED EARLIER by PR #24 (Jag's List Plan 3a),
   not by this run. See the [bugs-active.md](bugs-active.md) carry-forward entry.

9. ~~**A fresh clone/worktree cannot build in one pass**~~ — DONE, and the original diagnosis was
   incomplete. Invoking the CLI by path (rather than via the `kiln` bin symlink) only turned
   `command not found` into `Module not found`: the real cause is that `bun run --filter '*' build`
   does not order by dependency topology, so `@kiln/cli` was built AFTER the app that shells out to
   it. Declaring `@kiln/cli` as a workspace devDependency (already the case) has no effect. The root
   build is now two phases — `packages/*` then the consumers. Verified against successive fresh
   `git clone`s until one passed in a single pass.
