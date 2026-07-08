# Architecture Decision Records (ADRs) & DX Rules

This file documents the major architecture decisions and developer experience (DX) rules that govern FSR.js.

## ADRs

### ADR-001: Redis is Required Infrastructure
*   **Status**: LOCKED
*   **Decision**: Redis is a hard requirement. The engine will fail to boot if a valid `REDIS_URL` is not provided.
*   **Rationale**: Multi-instance deployments rely on a shared memory layer for atomic field updates (RedisJSON/Hash) and instant pub/sub event distribution rather than file-system polling.

### ADR-002: Three-Layer Storage Model
*   **Status**: LOCKED (disk-tier wording revised 2026-07-07 to match implementation)
*   **Decision**: Cache hierarchy is strictly defined: Redis (hot serve/bus) → Postgres (durable source of truth) → Disk (recovery backup). Disk writes happen synchronously as part of `setHtml`/`setJson` (not fire-and-forget). Disk reads are used as the fallback on *any* Redis miss — when the key isn't in Redis, or Redis itself is unreachable — not restricted to the initial cold-start boot.
*   **Revision note**: The original wording ("disk writes are fire-and-forget; disk reads are restricted to cold-start boots") describes a boot-time hydration step that was never implemented (`packages/engine/src/cache.ts` has no cold-start-only gate). Since disk is read as a general per-request fallback whenever Redis has no value, cold start is just the first, most common instance of that fallback — the same path also covers a Redis outage or eviction later in the process's life, which is more resilient than a literal cold-start-only reading would be. Wording updated to match; behavior was not changed for this revision.

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

### ADR-011: Layout-Level (Pattern-Scoped) Caching
*   **Status**: ACTIVE (scoped to `test-app` only; `examples/address-book` not migrated)
*   **Decision**: Layouts (`_layout.tsx`) are cached once per URL *pattern* (`kiln:layout:html:<pattern>` / `kiln:layout:json:<pattern>`), independent of and shared across every concrete route nested under that pattern, instead of being re-baked into each route's own page-level cache entry. `cache.deleteLayout(pattern)` invalidates a shared layout with a single write.
*   **Rule**: A layout's `load()` may only read `req.params` for segments owned by its own pattern — never `req.query`, never a descendant page's params. Genuinely per-request-varying data must be pushed to the page or resolved client-side; universal-but-time-varying data (e.g. a live counter in the header) must use `LiveProp`/`Live.list`, not plain `load()`. This rule is enforced by convention, not a runtime check.
*   **Consistency mechanism**: A promoted page's own full-HTML cache entry embeds its layouts' HTML as of bake time, so invalidating the layout cache alone wouldn't reach already-promoted routes. Every page-level `BakedSnapshot` therefore carries a `layoutSignature` (a hash fingerprint of the exact layout cache entries used to assemble it, from `computeLayoutSignature()` in `boot.ts`). On each promoted-cache-hit, the current signature is recomputed and compared; a mismatch forces a full re-bake, same as a missing/corrupt cache entry. Found via a unit test that intentionally exercised `deleteLayout()` against an already-promoted route and asserted the next request reflected the change — it failed until this signature check was added (see `bugs.md`).
*   **Not migrated**: `examples/address-book`'s `ContactsLayout` reads `req.query.q`/`req.params.id` and violates the load()-scoping rule; it intentionally still uses the old per-route full-page bake path rather than being refactored to comply.

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
