# Architecture Decision Record — FSR.js

## Project Overview

FSR.js is a TypeScript monorepo implementing **Field-Selective Rendering** for the JavaScript/Bun ecosystem. It is the JS port of Pilcrow's FSR paradigm — no other framework offers field-level rendering granularity at the HTML baking layer.

**Runtime:** Bun + Elysia  
**Language:** TypeScript (57 files)  
**Package manager:** pnpm workspaces  
**Graph:** 394 nodes, 2641 edges, 11 communities, 41 data flows

---

## Package Architecture

```
packages/
  core/           — Config (defineConfig, loadConfigFromEnv), errors (Result<T>), types, LiveProp primitives
  engine/         — FsrStore, RedisCache, watcher, baking, hub (SSE), db-notify, schema
  adapter-elysia/ — ElysiaAdapter, HTTP handlers (action, fsr-hub, fsr-snapshot, live-hub, page), middleware
  routekit/       — Route discovery, manifest, layout-chain, Vite plugin, live-client-script
  react/          — useSubmit, useLive hooks, client submission
  client/         — silcrow.js (auto-injected SSE hub + DOM patcher)
  cli/            — Dev server bootstrap
  create-fsr/     — Project scaffolding CLI
```

**Layer model:**
- `core` → pure primitives, no deps
- `engine` → stateful (Redis + DB), no HTTP
- `adapter-elysia` → HTTP surface, depends on engine + routekit
- `routekit` → build-time route graph, drives adapter-elysia
- `react` / `client` → frontend consumers

**Cross-package call boundaries (by frequency):**
- `routekit → adapter-elysia` (12 calls) — routes drive handler registration
- `adapter-elysia → api` (9 calls) — handler delegates to route API layer
- `engine ↔ cli` (4 calls each direction) — engine bootstrapped by CLI

---

## ADR-001: Redis is Required Infrastructure

**Status:** LOCKED  
**Decision:** Redis is not optional. No fallback-only mode. Pilcrow fails to start without a valid `REDIS_URL`.

**Rationale:** Multi-instance deployments require a shared cache layer. Redis provides:
- Atomic field-level updates (HASH + RedisJSON)
- Built-in pub/sub replacing all watcher polling
- Cache persistence surviving restarts (no thundering-herd cold starts)
- Single shared state across pods — no stale cross-instance reads

**Key class:** `packages/engine/src/cache.ts` → `RedisCache` (hotspot: `disconnect` fan-in=4)

**Redis key schema:**
```
pilcrow:html:<route>   STRING  full baked HTML
pilcrow:json:<route>   STRING  baked JSON (if FSR_JSON opted in)
pilcrow:slot:<route>   HASH    { slot_name: current_value }
pilcrow:meta:<route>   HASH    { version, baked_at, checksum, promoted }
```

**Pub/sub channels:**
```
pilcrow:invalidate  → watcher receives { route, slots, deps }
pilcrow:patch       → SSE hub receives { route, slot, value }
pilcrow:promote     → all instances receive { route, promoted: true }
```

---

## ADR-002: Three-Layer Storage Model

**Status:** LOCKED  
**Decision:** Redis (serve + bus) → Postgres (truth) → Disk (recovery, optional).

- **Redis:** hot path, source of truth for baked HTML/JSON on promoted routes
- **Postgres:** `pilcrow_fsr` metadata, real application data, durable record of what should be cached; managed via Drizzle (`packages/engine/src/schema.ts`)
- **Disk:** async write-behind from Redis, only used on cold start — never on hot path

**DB schema (single table):**
```sql
pilcrow_fsr (
  route           TEXT,
  slot            TEXT,          -- '' = route-level, 'field_name' = slot-level
  query           TEXT,          -- SQL to re-execute when stale
  query_params    JSONB,
  depends_on      TEXT[],
  stale           BOOLEAN,
  version         INT,
  hit_count       INT,
  promoted        BOOLEAN,
  promote_after   INT,           -- NULL treated as 0 (SSG)
  debounce_secs   INT,
  html_path       TEXT,
  json_path       TEXT,          -- NULL if JSON not opted in
  checksum        TEXT,
  last_hit        TIMESTAMPTZ,
  purge_after     INT,
  PRIMARY KEY (route, slot)
)
```

**Key store methods (hotspots):** `FsrStore.invalidateDepKey`, `FsrStore.upsertSlot`, `FsrStore.ensureRouteRow` — all fan-in=4 (`packages/engine/src/store.ts`)

---

## ADR-003: Unified Rendering Lifecycle via promote_after

**Status:** LOCKED  
**Decision:** One integer unifies SSG / ISR / FSR / SSR into a single continuum.

```
promote_after absent or 0  → SSG (bake at startup)
promote_after = 1          → ISR (bake after first request)
promote_after = N          → FSR (bake after N hits)
No live file               → pure SSR (existing behaviour, untouched)
```

All promoted modes receive surgical field-level patches on dependency change. The only difference is when the first bake occurs.

**Promotion mechanics:** declared per field via `promoteAfter(N)` option, with framework default in config `[fsr].promote_after_hits`. Debounce also declared per field via `patchDebounce(N)`, default in `[fsr].patch_debounce_secs`.

---

## ADR-004: Field-Level Granularity — LiveProp vs Static

**Status:** LOCKED  
**Decision:** Static fields baked directly into HTML (never stored). Watched fields (`LiveProp<T>`) get:
1. A shell slot in HTML with `s-live="slot_name"` attribute
2. A row in `pilcrow_fsr` (slot-level)
3. Live SSE updates via `pilcrow:patch` channel

**Key primitive:** `packages/core/src/live-prop.ts` → `LiveProp`, `depToString`

**No value column in DB** — source of truth stays in real application tables. `query` + `query_params` stored for re-execution when `stale = TRUE`.

**JSON opt-in:** route-level `FSR_JSON = true` → only `LiveProp` fields baked into JSON; static fields never appear.

---

## ADR-005: Event-Driven Watcher (No Polling)

**Status:** LOCKED  
**Decision:** Watcher subscribes to `pilcrow:invalidate` Redis pub/sub. No polling loop in normal operation.

**Flow on dep change:**
```
invalidate(dep) 
  → UPDATE pilcrow_fsr SET stale=TRUE WHERE depends_on @> ARRAY[dep]
  → PUBLISH pilcrow:invalidate { route, slots, deps }
  → Watcher receives instantly
  → Re-executes stored query
  → Patches Redis slot HASH + re-renders HTML
  → PUBLISH pilcrow:patch { route, slot, value }
  → SSE hub fans out to connected clients
  → silcrow.js patches DOM via querySelectorAll('[s-live="..."]')
  → Async disk write (fire and forget)
```

Polling fallback only if Redis pub/sub connection drops.

**Key files:** `packages/engine/src/watcher.ts`, `packages/engine/src/hub.ts`, `packages/engine/src/db-notify.ts`

---

## ADR-006: s-live HTML Attribute Convention

**Status:** LOCKED  
**Decision:** `s-live="slot_name"` — consistent with Silcrow's `s-` prefix convention.

Same name end-to-end: field name in code = `s-live` attr = `pilcrow_fsr` slot = SSE payload key = Redis HASH field.

**List row naming:** `list_field__row_id__field_name` e.g. `ticket_list__42__status`. Same patcher handles it — no special case needed.

---

## ADR-007: HTTP Adapter — Elysia (Bun)

**Status:** LOCKED  
**Decision:** `adapter-elysia` is the HTTP adapter. `ElysiaAdapter` is the central hotspot (fan-in=3 for `listen`, `applyMiddleware`, `registerAction`).

**Handler surface:**
- `handlePage` — SSR/FSR page rendering
- `handleFsrHub` — SSE connection for live updates
- `handleFsrSnapshot` — snapshot endpoint for cold clients
- `handleLiveHub` — live hub management
- `handleAction` — form action handler

**Routes registered:**
```
/__pilcrow/fsr           → FSR hub SSE stream
/__pilcrow/fsr/snapshot  → slot snapshot
/_silcrow/silcrow.js     → auto-injected client script
/_pilcrow/live.js        → live client script
```

**Middleware:** `bodyLimit`, `csrf`, `layoutIntercept`, `timeout`

---

## ADR-008: Route Discovery — Routekit + Vite Plugin

**Status:** LOCKED  
**Decision:** `routekit` handles build-time route graph construction via file-system discovery + Vite plugin integration.

**Key files:** `discover.ts` (FS scan), `manifest.ts` (route manifest), `layout-chain.ts` (layout inheritance), `vite-plugin.ts` (Vite integration), `boot.ts` (runtime bootstrap)

`routekit → adapter-elysia` is the highest-frequency cross-package boundary (12 calls).

---

## ADR-009: React Integration Surface

**Status:** ACTIVE  
**Decision:** React package provides hooks only — no React-specific rendering engine.

- `useSubmit` — form/action submission
- `useLive` — subscribe to LiveProp updates via SSE

Lives in `packages/react/src/hooks.ts`. Thin layer over the SSE client.

---

## ADR-010: Dependency Key Model

**Status:** LOCKED  
**Decision:** Typed dependency keys, not raw strings. `depToString(dep)` serialises to `"table:column=value"` e.g. `"tickets:id=123"`.

Developer declares `dependsOn` explicitly on each `LiveProp` field. Framework does not wrap the ORM — Drizzle is used directly. No magic dep tracking.

**Query deduplication:** same SQL + same params across multiple `LiveProp` fields → executes once, all fields populated from single result.

---

## What is NOT in Scope

- Wrapping Drizzle/ORM — developer uses it directly, declares deps explicitly
- Value storage in `pilcrow_fsr` — source of truth stays in real DB tables
- Per-route config files — all config co-located on field declaration
- Optional Redis mode — Redis is required
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
| Redis cache | `packages/engine/src/cache.ts` |
| FSR store | `packages/engine/src/store.ts` |
| SSE hub | `packages/engine/src/hub.ts` |
| React hooks | `packages/react/src/hooks.ts` |
| Dev CLI | `packages/cli/src/cli.ts` |