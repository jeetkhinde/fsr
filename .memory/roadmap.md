# Kiln Project Roadmap

Last updated: 2026-07-27

---

## Completed Milestones

### V1 Baseline
- [x] **Field-Selective Rendering Engine**: Event-driven watcher, SSE hub, field-level cache invalidation
- [x] **Layout-Aware Route Swapping**: `X-PS-Present` headers, `silcrow-target`, layout fragment negotiation
- [x] **Live Lists (`Live.list`)**: Row-level diffs (replace-row, insert, move, remove) via embedded watcher
- [x] **Pattern-Level Layout Caching** (ADR-011): `_layout.tsx` baked once per URL pattern, `layoutSignature` staleness detection
- [x] **Acceptance Testing App**: `examples/address-book` with persistent DB mutations and transactional events

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
2. **External Watcher Process** — `fsr.watcher: 'embedded' | 'external'` is typed but external mode is partially implemented. Decouple watcher from the application thread for high-mutation workloads.
3. **Fine-Grained Debounce Scheduling** — Per-field invalidation windows instead of coarse sweep intervals.
4. **`address-book` Layout Migration** — Migrate `ContactsLayout` to pattern-level caching (currently violates ADR-011 load()-scoping rule by reading `req.query.q` / `req.params.id`).

---

## Phase 5: DX & Maintainability Backlog

Raised by the 2026-07-27 source audit at `758eb44`. The correctness defects from the same audit are
**not** here — all six were fixed on `fix/emit-event-non-bigint-id` and archived in
[bugs-resolved.md](bugs-resolved.md) §1.

1. **Warn at sync time when a table has no `id` column** — the remaining slice of the original
   §1.1/§1.5 DX item. The write-breaking defect is fixed ([bugs-resolved.md](bugs-resolved.md) §1),
   so a hard install-time failure is no longer warranted — but an `id`-less table now silently gets
   only table-level invalidation, never the row-level `depKey:id` form. `sync-triggers` should say
   so once, at install time, instead of leaving it to be discovered. Needs its own test.

2. **Cache bound methods in the `createKilnSql` Proxy** — `packages/core/src/sql.ts:61-66` rebinds on
   every property access, so `sql.unsafe !== sql.unsafe` (a fresh bound function per `get`). Breaks
   identity comparison/memoization and allocates on every access. Memoize per property.

3. **Break up `boot.ts`** — 1527 lines, ~1.7× the next-largest file (`watcher.ts`, 883). Request
   path, JSON negotiation, cache tiers, live-field upsert, SSE registration, and `startKiln` wiring
   all live in one file. Extract cohesive units; it is the main obstacle to reviewing changes here.

4. **Narrow `CacheProvider` to what ships** — the type offers `memory | filesystem | sqlite | redis`;
   `startKiln` throws a clear boot error for `memory`/`sqlite` (`boot.ts:1097-1100`). Failing loudly
   is right, but the type shouldn't advertise them at all.

5. **Env-var overrides for deployment-critical config** — `loadConfigFromEnv`
   (`packages/core/src/config.ts:258-295`) covers only 6 web/backend vars. No override exists for
   `fsr.postgresUrl`, `fsr.redisUrl`, `cache.url`, or `fsr.buildId`. `buildId` is meant to be a
   per-deploy git SHA (ADR-018), which is exactly the thing you want from the environment.

6. **Runtime config validation** — `defineConfig` merges without validating values. TS catches typo'd
   keys, but nothing catches out-of-range values (`images.quality`, ports, unsupported `formats`);
   they surface as obscure runtime failures. A validation pass with actionable messages would also
   cover JS-authored configs, where the TS safety net is absent.

7. **Retire the deprecated config surface** — `fsr.idleEvictSecs`, `fsr.idleThresholdSecs`, and the
   whole `live` block warn on use (`config.ts:228,244-251`) but are still typed and merged. Pick a
   removal release.

8. **Exercise auto-deps end-to-end in an app** — see [bugs-active.md](bugs-active.md) carry-forward.
   `jags-list` has no `Live.value`/`Live.list` usage, and two of the six defects fixed on 2026-07-27
   (the BIGINT id cast and the depKey folding mismatch) would have surfaced immediately from one real
   live-field page. This is the highest-value *test* gap.

9. **A fresh clone/worktree cannot build in one pass** (found 2026-07-27) — `test-app`'s build shells
   out to the `kiln` binary, but `bun install` only creates that bin symlink once
   `packages/cli/dist/cli.js` exists. So the first `bun run build` in a clean tree fails with
   `kiln: command not found` and the sequence has to be install → build → install → build. An
   existing workspace has the symlink from an earlier cycle, which hides this from everyone who
   already has one. Either bootstrap `@kiln/cli` before the workspace build or invoke it by path.
