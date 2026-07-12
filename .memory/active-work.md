# Active Work Context

Last updated: 2026-07-12

## Current State

Branch `fix/gemini-audit-round2` (worktree off `main` @ `3f6e900`) — fixes for every item confirmed real out of an external (Gemini) 159-item audit, plus the 3 architectural items initially deferred (per-worker connection counter, unbounded list-chunk cache, schema backfill re-running every startup), awaiting merge/PR. See `.memory/bugs.md` §0 for the full list (2 commits: `1b9da8c`, `841f1c5`).

`tsc --noEmit` is clean across all packages: `core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`, `client`.
Unit suite: **149 pass, 0 fail**. Also directly re-verified against real Postgres in this environment: `store.test.ts`, `hub.test.ts`, `db-notify.test.ts`, `watcher.test.ts` (all excluded from `test:unit` but exercise files this pass touched) — all pass.

Correction to a previously-recorded belief: the line below (from the 2026-07-10 session) claiming the address-book route test needs live Postgres and fails without it was **wrong** — `examples/address-book/tests/routes.test.ts` was directly re-run in this session and passes cleanly with no DB. Left in `test:unit` as-is; don't re-exclude it without re-verifying first.

## Previous State (2026-07-10, superseded above)

Branch `fix/audit-fixes` (worktree off `main` @ `e7e599d`) — full-codebase audit fixes, awaiting merge/PR.

`tsc --noEmit` is clean across all packages: `core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`.
Unit suite: 110 pass; 1 pre-existing env-dependent failure (address-book route test needs live Postgres) — **see correction above, this was inaccurate.**

---

## Completed This Session (2026-07-10) — audit fixes, branch `fix/audit-fixes`

Bugs fixed (see `.memory/bugs.md` §"Fixed in the 2026-07-10 audit" for detail):
- [x] Server hooks (`hooks.ts`) wired via `adapter.applyServerHooks()` — was implemented but never called
- [x] Request timeout actually enforced (`withTimeout` wrap in adapter; old derive() was a no-op)
- [x] `AppError` statuses honored on page routes; `_error.tsx` / `_not-found.tsx` now render (nearest-dir)
- [x] `/__kiln/fsr/snapshot` returned empty body (was registered via registerSSE); now a page route, and reads the baked snapshot before re-querying
- [x] SSG prebake real: startup runs the page handler with a synthetic request (old code only wrote raw entry params; its condition was also always-false)
- [x] Watcher Redis JSON patches merged into `snapshot.data` (were top-level → Redis-served promoted pages never saw patches); `watcherTick`/`watcherTickRedis` unified
- [x] `cache.delete(route)` no longer wipes descendant routes' disk caches
- [x] `fsr.artifactTtlSecs` wired into KilnCache TTL (variant Redis keys were immortal)
- [x] XSS: JSON seed serialization escapes `<` (`toScriptJson`)
- [x] Watcher loaders use a sanitized request (no first-visitor headers/cookies); live features skipped + warned for `cache_key` variants
- [x] Tombstoned routes no longer resurrect cache artifacts
- [x] `loadConfigFromEnv` deep-copies (was mutating DEFAULT_CONFIG); providers honest (`memory`/`sqlite` → StartupError, default now `filesystem`)
- [x] CLI: new `kiln start` production command; FSR optional (redisUrl without postgresUrl is a config error); host binding honored
- [x] `cache_key` snake_case export (camelCase `cacheKey` deprecated), route-row ensure once per process + `Missing` hit-status retry, atomic watcher file writes, db-notify cursor ordering, image handler NaN→400 + no upscaling, `hoistHeadTags` leaves `<svg><title>` alone, CSRF `x-forwarded-host` behind `web.trustProxy`
- [x] Dead code removed: adapter `handlers/` stubs, `layout-intercept`, `smoke.ts`, `injectFsrScriptTag`, `assembleFragments`, `injectStylesheet`, `findSLiveSlots`, `extractLiveLists`, `rawSnapshotProps`, `prebakeNext` wrapper, `StartKilnOptions.promoteAfter`, `/__kiln/live/*` stub, `test-app/api/health.ts`

## Completed Previously (2026-07-09)

- [x] **Redis fully optional** — Production guard in `cli.ts` now only requires `postgresUrl` (not `redisUrl`). `startKiln()` in `routekit/boot.ts` auto-creates `KilnCache` Redis client from `config.fsr.redisUrl` when `options.redis` is not passed. `FsrWatcher` already handled `redis: null` gracefully (polling fallback). SSE hub never used Redis. (`packages/cli/src/cli.ts`, `packages/routekit/src/boot.ts`)

## Completed Previously (2026-07-08)

- [x] **`json_first` page export** — Pages exporting `json_first = true` now always respond with JSON regardless of `Accept` header. Eliminates the need for a separate `api/` directory. (`packages/core/src/types.ts`, `packages/routekit/src/page-options.ts`, `packages/routekit/src/boot.ts`)
- [x] **`.memory/features.md` created** — Source-verified feature inventory covering all Kiln features. Linked from `Agents.md`. Read this before scanning code.
- [x] **ADR-001 corrected** — Redis is only required for FSR/LiveProp SSE, not for all deployments. SQLite/memory/filesystem cache providers work without Redis.

---

## Workspace Checkpoints

### Version Control
- Active branch: `main`
- Remote: `https://github.com/jeetkhinde/fsr.git`
- Status: clean — no uncommitted changes (except `.claude/settings.local.json` which is local-only)

### Validation
- Unit tests: `bun run test:unit` — 102 pass, 1 skip (Postgres-dependent integration test)
- Type check: `bun run --cwd packages/<name> tsc --noEmit` — clean in all packages
- Build: `bun run build` in each package before testing cross-package consumption (dist/ must be current)

### Infrastructure required for full test suite
- PostgreSQL: needed for `test:integration` and the address-book example
- Redis: needed for FSR/LiveProp SSE features and related tests

---

## Next Priorities (from roadmap)

1. **Phase 3 — Feature Consolidation**
   - ~~`apiDir`~~ removed entirely from `KilnConfig`; `json_first` is the replacement
   - ~~`@kiln/client` asset resolution~~ cleaned up; stale `resolveSilcrowJs()` removed from `cli.ts`

2. **Phase 4 — Hardening**
   - ~~Cache partitioning~~ done — `cacheKey(req)` export; per-variant disk+Redis storage
   - External watcher process (`fsr.watcher: 'external'` typed, implementation partial)
   - Fine-grained debounce scheduling per-field

3. **React Islands (ADR-014)** — ALL PHASES COMPLETE 2026-07-11 (branch `feat/adr-014-islands`).
   Spec: `docs/design/adr-014-react-islands.md`; feature docs: `.memory/features.md` §"React Islands".
   - ~~Phase 0: seed codec~~ (`@kiln/core/seed-codec`)
   - ~~Phase 1: `island()` wrapper + bake-time guards + `BAKED_RENDER_VERSION` 2~~
   - ~~Phase 2: build pipeline (virtual hydration wrappers, manifest) + serving~~
   - ~~Phase 3: client bootstrap (`islands.js`) + silcrow patch exclusion~~
   - ~~Phase 4: `useLiveValue` store bridge + test-app demo + docs~~
   Remaining (not blocking): live E2E against Postgres/Redis (SSE → store →
   island re-render) needs local infra; TanStack Query adapter deferred by design.
