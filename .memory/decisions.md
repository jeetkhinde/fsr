# Architecture Decision Records (ADRs) & DX Rules

This file documents the major architecture decisions and developer experience (DX) rules that govern FSR.js.

## ADRs

### ADR-001: Redis is Required Infrastructure
*   **Status**: LOCKED
*   **Decision**: Redis is a hard requirement. The engine will fail to boot if a valid `REDIS_URL` is not provided.
*   **Rationale**: Multi-instance deployments rely on a shared memory layer for atomic field updates (RedisJSON/Hash) and instant pub/sub event distribution rather than file-system polling.

### ADR-002: Three-Layer Storage Model
*   **Status**: LOCKED
*   **Decision**: Cache hierarchy is strictly defined: Redis (hot serve/bus) → Postgres (durable source of truth) → Disk (async recovery backup). Disk writes are fire-and-forget; disk reads are restricted to cold-start boots.

### ADR-003: Unified Rendering Lifecycle via `promote_after`
*   **Status**: LOCKED
*   **Decision**: A single integer configures the rendering mode:
    *   `promote_after` is absent/0 → SSG (page baked at startup).
    *   `promote_after = 1` → ISR (page baked after first request).
    *   `promote_after = N` → FSR (page baked after N hits).
    *   No live descriptors/templates → Pure SSR (fallback behaviour).

### ADR-004: Field-Level Granularity (LiveProp vs Static)
*   **Status**: LOCKED
*   **Decision**: Static fields are baked directly into the static HTML template during promotion. Dynamic fields marked with `LiveProp<T>` generate `s-live` HTML slots and are updated via data-only JSON patches pushed to clients.

### ADR-005: Event-Driven Watcher (No Polling)
*   **Status**: LOCKED
*   **Decision**: Watchers subscribe to the `kiln:invalidate` Redis channel. Database triggers invoke `LISTEN/NOTIFY` channels in Postgres, triggering instantaneous watcher reconciliation without polling loops.

### ADR-006: `s-live` HTML Attribute Convention
*   **Status**: LOCKED
*   **Decision**: Dynamic fields map to an `s-live="slot_name"` attribute. List items follow the naming structure: `list_name__row_id__field_name` (e.g., `contacts__42__favorite`).

### ADR-007: HTTP Adapter (Elysia on Bun)
*   **Status**: LOCKED
*   **Decision**: `adapter-elysia` exposes the standard server handlers (`handlePage`, `handleFsrHub`, `handleFsrSnapshot`, `handleAction`). It registers internal FSR endpoints under `/__kiln/fsr` and `/__kiln/fsr/snapshot`.

### ADR-008: Route Discovery (Routekit + Vite)
*   **Status**: LOCKED
*   **Decision**: `routekit` compiles the route manifest at build time, scanning files inside the `pages/` directory and constructing layout inheritance chains.

### ADR-009: React Integration Surface
*   **Status**: ACTIVE
*   **Decision**: React wrapper libraries strictly supply hooks (`useLive`, `useSubmit`) for rendering and action dispatch. No custom React server-rendering engine is implemented.

### ADR-010: Explicit Dependency Key Model
*   **Status**: LOCKED
*   **Decision**: Dependency keys are typed and explicit. No magic database wrappers are used. Developers explicitly bind components using `dependsOn` arrays mapping to table structures (e.g., `contacts:id=123`).

---

## Critical DX Rules & Conventions

*   **Immutable Shells**: Baked HTML page and layout structures must remain immutable. Watchers must patch only JSON snapshots, not the baked HTML shells.
*   **JSON Authority**: JSON snapshot payloads are the sole authority for freshness updates.
*   **Layout Preservation**: Internal navigation must not request full-page HTML. Using server layout headers (`X-PS-Present`), only the required layout/page fragments should be downloaded and swapped.
*   **Postgres Lifecycle Defaults**: Default database properties are locked to:
    *   `promoteAfterHits: 2` (default promotion threshold).
    *   `patchDebounceSecs: 5` (debounce invalidations).
    *   `revalidateSeconds: 300` (revalidate stale entries).
    *   `purgeAfterSeconds: 2592000` (auto-purge unused routes after 30 days).
    *   `purgeSweepSeconds: 3600` (hourly sweep frequency).
