# Architecture Decision Record — Kiln

## Project Overview

Kiln is a TypeScript monorepo implementing **Field-Selective Rendering (FSR)** for the JavaScript/Bun ecosystem — a file-based React framework with field-level rendering granularity at the HTML baking layer. (Formerly named FSR.js; renamed to Kiln.)

**Runtime:** Bun + Elysia
**Language:** TypeScript (138 files) + JS/YAML/SQL/Bash/CSS/TOML
**Package manager:** pnpm workspaces
**Graph:** 1844 nodes, 3835 edges (via codebase-memory-mcp, current as of commit `52f6efe0`)

---

## Package Architecture

```
packages/
  core/           — Config (defineConfig, loadConfigFromEnv), errors (Result<T>), types, LiveProp/list/i18n/seed-codec primitives
  engine/         — KilnCache, FsrStore, watcher, baking, hub (SSE), db-notify, schema, list-store/list-watcher/list-broadcast
  adapter-elysia/ — ServerAdapter impl (registerPage/registerAction/registerSSE/registerAsset/applyMiddleware/listen)
  routekit/       — Route discovery, manifest, layout-chain, page-options, Vite plugin, live-client-script, typed-routes, image-handler
  react/          — useLive, useSubmit hooks, island() wrapper
  client/         — silcrow.js (auto-injected SSE hub + DOM patcher + islands bootstrap)
  live/           — Live patch contract: html.ts/json.ts/patch.ts/scalar.ts/list.ts (shared patch format between engine and client)
  cli/            — Dev server bootstrap
  create-kiln/    — Project scaffolding CLI (formerly create-fsr)
```

**Layer model:**
- `core` → pure primitives, no deps (high fan-in: 17 in, 0 out)
- `engine` → stateful (Redis/SQLite/filesystem cache + Postgres), no HTTP (high fan-in: 25 in, 16 out)
- `live` → shared patch contract, high fan-in, 0 out
- `adapter-elysia` → HTTP surface, depends on engine + routekit
- `routekit` → build-time route graph, drives adapter-elysia (fan-in=4, fan-out=27 — highest fan-out in the graph)
- `react` / `client` → frontend consumers

**Cross-package call boundaries (by frequency):** `routekit → engine` (14), `routekit → core` (13), `engine → live` (12), `cli → engine` (4), `cli → routekit` (4), `address-book(example) → engine` (4), `address-book → core` (4), `engine → cli` (4).

---

## ADR-001: Redis is Required for FSR/Live Features Only

**Status:** REVISED 2026-07-08 (original wording was incorrect)
**Decision:** `CacheConfig.provider` accepts `'memory' | 'filesystem' | 'sqlite' | 'redis'`. Redis is **not** a blanket boot requirement — it's required only when FSR/LiveProp SSE features are active (promoted routes, `Live.value()`, `Live.list()`). A pure SSG/SSR/ISR Kiln app runs fine on SQLite or in-memory cache.
**Rationale:** Multi-instance deployments with live fields need Redis as a shared cache + pub/sub bus. Single-instance or cache-only deployments don't. `startKiln()` accepts `redis: null` and falls through to disk/SQLite gracefully — the original "Redis is a hard requirement" ADR predated what the code actually enforces.

**Key class:** `packages/engine/src/cache.ts` → `KilnCache`

---

## ADR-002: Three-Layer Storage Model

**Status:** LOCKED (disk-tier wording revised 2026-07-07 to match implementation)
**Decision:** Redis (hot serve + bus) → Postgres (durable source of truth) → Disk (recovery backup). Disk writes are synchronous (part of `setHtml`/`setJson`, not fire-and-forget). Disk reads are the fallback on *any* Redis miss — key absent OR Redis unreachable — not restricted to cold-start boot; the same path covers a mid-process Redis outage.

**DB schema (single table):**
```sql
kiln_fsr (
  route, slot,                    -- '' slot = route-level, else field-level
  query, query_params,            -- SQL to re-execute when stale
  depends_on TEXT[],
  stale BOOLEAN, version INT, debounce_secs INT,
  html_path TEXT, json_path TEXT, checksum TEXT,   -- html_path IS NOT NULL == promoted (ADR-016)
  last_requested_at TIMESTAMPTZ, purge_after_secs INT,
  PRIMARY KEY (route, slot)
)
```

**Redis keys:** `kiln:html:<route>`, `kiln:json:<route>`, `kiln:slot:<route>` (HASH), `kiln:meta:<route>` (HASH), plus pattern-scoped `kiln:layout:html:<pattern>` / `kiln:layout:json:<pattern>` (see ADR-011).

---

## ADR-003: Unified Rendering Lifecycle via promote_after

**Status:** SUPERSEDED by ADR-016 (2026-07-19)
**Decision (historical):** One integer unified SSG/ISR/FSR/SSR via hit counting.

---

## ADR-016: Bake Classes Replace Hit-Count Promotion

**Status:** ACCEPTED 2026-07-19
**Decision:** Rendering mode is observed, not declared. A Proxy purity tracker
(`packages/routekit/src/purity.ts`) watches each `load()` for access to
`req.locals`/`headers`/`query`/`raw`/body:

```
absent (auto)   → first identity-free render bakes; identity access ⇒ pure SSR (latched, artifacts deleted)
bake = 'static' → prebake entries() at startup, else first-hit bake
bake = 'shared' → always bake first render (dev warning if identity accessed)
bake = false    → pure SSR, never cached
```

Artifact presence IS promotion — `hit_count`/`promoted`/`promote_after`/
`promoted_at`/`last_hit` columns dropped; queries derive promoted-ness from
`html_path IS NOT NULL`. Zero Postgres on the cached read path (throttled
fire-and-forget `touchRoute`; tombstone checked only at bake time).
`cache_key` pages are exempt from auto-demotion and bake per variant. Impure
layouts are never pattern-cached and block their page's bake. Exporting
`promote_after` fails boot with `StartupError('RemovedOption')`.
**Migration:** flush Redis + `.kiln-cache` when deploying across this change —
pre-ADR-016 artifacts are trusted as-is. Supersedes ADR-003; amends ADR-015
(the `promote_after = false` workaround for auth pages is obsolete).

---

## ADR-004: Field-Level Granularity — LiveProp vs Static

**Status:** LOCKED
**Decision:** Static fields baked directly into HTML. `LiveProp<T>` fields get an `s-live="slot_name"` HTML slot and are updated via data-only JSON patches pushed over SSE — never a full re-bake.

**Key primitive:** `packages/core/src/live-prop.ts`

---

## ADR-005: Event-Driven Watcher (No Polling)

**Status:** LOCKED
**Decision:** Watchers subscribe to the `kiln:invalidate` Redis channel. Postgres `LISTEN/NOTIFY` triggers watcher reconciliation instantly — no polling loop in normal operation.

**Key files:** `packages/engine/src/watcher.ts`, `packages/engine/src/hub.ts`, `packages/engine/src/db-notify.ts`

---

## ADR-006: s-live HTML Attribute Convention

**Status:** LOCKED
**Decision:** `s-live="slot_name"` — same name end-to-end (code field = attr = DB slot = SSE payload key = Redis HASH field). List rows: `list_name__row_id__field_name` (e.g. `contacts__42__favorite`).

---

## ADR-007: HTTP Adapter — Elysia (Bun)

**Status:** LOCKED (wording revised 2026-07-10)
**Decision:** `adapter-elysia` implements the framework-agnostic `ServerAdapter` interface: `registerPage` / `registerAction` / `registerSSE` / `registerAsset` / `applyMiddleware` / `applyServerHooks` / `listen`. Route handlers are closures built by `startKiln()`. Internal endpoints: `/__kiln/fsr` (SSE), `/__kiln/fsr/snapshot` (JSON).
**Revision note:** earlier standalone `handlePage`/`handleFsrHub`/`handleFsrSnapshot`/`handleAction` functions were unwired placeholder stubs, deleted in the 2026-07-10 audit — don't look for them.

---

## ADR-008: Route Discovery — Routekit + Vite Plugin

**Status:** LOCKED
**Decision:** `routekit` compiles the route manifest at build time from the `pages/` directory and constructs layout inheritance chains.

**Key files:** `discover.ts`, `manifest.ts`, `layout-chain.ts`, `vite-plugin.ts`, `boot.ts`, `page-options.ts`, `typed-routes.ts`, `image-handler.ts`

---

## ADR-009: React Integration Surface

**Status:** ACTIVE
**Decision:** React wrapper libraries strictly supply hooks (`useLive`, `useSubmit`) plus the `island()` wrapper (see ADR-014). No custom React server-rendering engine.

**Lives in:** `packages/react/src/hooks.ts`, `packages/react/src/island.tsx`

---

## ADR-010: Explicit Dependency Key Model

**Status:** LOCKED
**Decision:** Typed, explicit dependency keys — `dependsOn` arrays map to table structures (e.g. `contacts:id=123`), no magic ORM wrapping. Query dedup: identical SQL + params across multiple `LiveProp` fields executes once.

---

## ADR-011: Layout-Level (Pattern-Scoped) Caching

**Status:** ACTIVE (scoped to `test-app` only; `examples/address-book` intentionally not migrated)
**Decision:** Layouts (`_layout.tsx`) cache once per URL *pattern* (`kiln:layout:html:<pattern>`), shared across every route nested under it, instead of being baked into each route's own cache entry. `cache.deleteLayout(pattern)` invalidates the shared layout in one write.
**Rule:** A layout's `load()` may only read `req.params` for segments its own pattern owns — never `req.query`, never a descendant page's params. Time-varying-but-universal data (e.g. a header counter) must use `LiveProp`/`Live.list`, not plain `load()`. Enforced by convention, not a runtime check.
**Consistency mechanism:** promoted pages embed a `layoutSignature` (hash fingerprint of the layout cache entries used to assemble them, via `computeLayoutSignature()` in `boot.ts`). A mismatch on cache-hit forces full re-bake — this is what makes `deleteLayout()` alone sufficient to propagate a layout change to every route beneath it, including already-promoted ones.
**Not migrated:** `examples/address-book`'s `ContactsLayout` reads `req.query.q`/`req.params.id`, violating the rule — intentionally left on the old per-route full-page bake path.

---

## ADR-012: json_first Page Export for JSON-Default Routes

**Status:** ACTIVE (shipped 2026-07-08, commit `7276441`)
**Decision:** Any page may export `json_first = true` to unconditionally return `load()` data as JSON regardless of `Accept` header, layered on top of existing content negotiation.
**Rationale:** Replaces the never-wired `apiDir` config — pages in `pages/api/` with `json_first = true` get full routing, typed deps, actions, and FSR support without a separate API directory.
**Implementation:** `PageDefinition.json_first` (`core/src/types.ts`), `PageOptions.jsonFirst` (`routekit/src/page-options.ts`), guard widened to `wantsJson(req) || options.jsonFirst` (`routekit/src/boot.ts`).

---

## ADR-013: Streaming SSR is Not Needed

**Status:** DECISION (2026-07-08)
**Decision:** No Streaming SSR, no React Suspense boundaries.
**Rationale:** Streaming SSR solves "slow `load()` → blank screen." Kiln already solves this at a higher level: promoted routes serve pre-baked HTML instantly; un-promoted routes keep `load()` fast and return a shell + `LiveProp` placeholders that SSE fills after render — handling both initial load and ongoing updates, which streaming alone doesn't.

---

## ADR-014: React Islands over Baked HTML (Store-Bridge Hydration)

**Status:** ACCEPTED 2026-07-10 · Implementation spec: `docs/design/adr-014-react-islands.md`
**Decision:** Client-side React only through **islands**. Baked HTML stays canonical; interactive components live in `islands/` (sibling of `pages/`), wrapped with `island(Component, name, { hydrate })` from `@kiln/react`, SSR'd into the baked shell inside a `data-kiln-island` marker, hydrated individually by a React-free bootstrap (`/_silcrow/islands.js`). Full-page hydration is prohibited.
**Invariants (each has a test):**
1. JS disabled → page still renders fully from baked HTML.
2. `hydrateRoot` only ever called on island markers, never `document`/`body`/layouts.
3. Silcrow's DOM patchers never touch inside `[data-kiln-island]`.
4. Live data inside an island uses `target: 'store'` + `useLiveValue()`; a dom-target `LiveProp` inside an island is a bake-time warning, not auto-tagged.
5. Hydration props come from the marker (`data-kiln-props`, seed-codec encoded); freshness after that comes only from Silcrow store subscriptions — islands never self-fetch initial data.
6. Markers embed island *names*, never chunk URLs — bootstrap resolves through a `no-store` manifest (`/_kiln/islands.json`), the deploy-skew defense. A failed chunk gets one guarded reload, then fails static.
7. Any hydration failure leaves baked HTML intact, emits `kiln:island-error`.
8. Everything embedded in HTML goes through `encodeSeed`/`decodeSeed` (`@kiln/core/seed-codec`), never bare `JSON.stringify`.
**Rationale:** Full hydration would hand the DOM to React, overwriting silcrow's surgical patches and re-running the whole tree client-side — rebuilding Next.js on top of FSR while destroying its cost model. Islands keep the store as the single seam between renderers.
**Consequences:** `BAKED_RENDER_VERSION` bumped to 2 when markers shipped (forced clean re-bake of all cached routes); nested islands, client routers, and Server Components are explicitly out of scope.

---

## What is NOT in Scope

- Wrapping Drizzle/ORM — developer uses it directly, declares deps explicitly
- Value storage in `kiln_fsr` — source of truth stays in real DB tables
- Streaming SSR / Suspense boundaries (ADR-013)
- Full-page React hydration (ADR-014)
- Shared DTOs between frontend and backend — independent type definitions

---

## Key Entry Points for Onboarding

| Task | File |
|------|------|
| Config setup | `packages/core/src/config.ts` |
| Engine bootstrap | `packages/engine/src/index.ts` |
| HTTP adapter | `packages/adapter-elysia/src/adapter.ts` |
| Route discovery | `packages/routekit/src/discover.ts` |
| LiveProp primitive | `packages/core/src/live-prop.ts` |
| Cache (Redis/SQLite/filesystem/memory) | `packages/engine/src/cache.ts` |
| FSR store | `packages/engine/src/store.ts` |
| SSE hub | `packages/engine/src/hub.ts` |
| React hooks + islands | `packages/react/src/hooks.ts`, `packages/react/src/island.tsx` |
| Live patch contract | `packages/live/src/{html,json,patch,scalar,list}.ts` |
| Dev CLI | `packages/cli/src/cli.ts` |
| Scaffolding CLI | `packages/create-kiln/src/cli.ts` |

For the fuller day-to-day source of truth, see `.memory/decisions.md`, `.memory/architecture.md`, and `.memory/features.md` in the repo root — this file is the codebase-memory-mcp-scoped summary of the same decisions.
