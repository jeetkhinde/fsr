# Architecture Decision Records (ADRs) & DX Rules

This file documents the major architecture decisions and developer experience (DX) rules that govern FSR.js.

## ADRs

### ADR-001: Redis is Required for FSR/Live Features Only
*   **Status**: REVISED 2026-07-08 (original wording was incorrect)
*   **Decision**: `CacheConfig.provider` accepts `'memory' | 'filesystem' | 'sqlite' | 'redis'`. Redis is **not** required for all deployments. It is required only when FSR/LiveProp SSE features are active (promoted routes, `Live.value()`, `Live.list()`). A pure SSG/SSR/ISR Kiln app can boot and run with SQLite or in-memory cache — no Redis needed.
*   **Rationale**: Multi-instance deployments with live fields rely on Redis as a shared memory layer and pub/sub event bus. Single-instance or cache-only deployments have no such requirement. The original "Redis is a hard boot requirement" statement was an architectural aspiration, not what the code enforces — `startKiln()` accepts `redis: null` and falls through to disk/SQLite gracefully.

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
*   **Status**: LOCKED (wording revised 2026-07-10)
*   **Decision**: `adapter-elysia` implements the framework-agnostic `ServerAdapter` interface (`registerPage`/`registerAction`/`registerSSE`/`registerAsset`/`applyMiddleware`/`applyServerHooks`/`listen`); route handlers are closures built by `startKiln()`. Internal FSR endpoints live under `/__kiln/fsr` (SSE) and `/__kiln/fsr/snapshot` (JSON page route).
*   **Revision note**: the original wording named standalone `handlePage`/`handleFsrHub`/`handleFsrSnapshot`/`handleAction` functions — those were placeholder stubs that were never wired and were deleted in the 2026-07-10 audit.

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
*   **Consistency mechanism**: A promoted page's own full-HTML cache entry embeds its layouts' HTML as of bake time, so invalidating the layout cache alone wouldn't reach already-promoted routes. Every page-level `BakedSnapshot` therefore carries a `layoutSignature` (a hash fingerprint of the exact layout cache entries used to assemble it, from `computeLayoutSignature()` in `boot.ts`). On each promoted-cache-hit, the current signature is recomputed and compared; a mismatch forces a full re-bake, same as a missing/corrupt cache entry. Found via a unit test that intentionally exercised `deleteLayout()` against an already-promoted route and asserted the next request reflected the change — it failed until this signature check was added (see `bugs-resolved.md`).
*   **Not migrated**: `examples/address-book`'s `ContactsLayout` reads `req.query.q`/`req.params.id` and violates the load()-scoping rule; it intentionally still uses the old per-route full-page bake path rather than being refactored to comply.

### ADR-012: `json_first` Page Export for JSON-Default Routes
*   **Status**: ACTIVE (shipped 2026-07-08, commit `7276441`)
*   **Decision**: Any page file may export `json_first = true` to declare itself a JSON-first endpoint. The page handler returns `load()` data as JSON to all clients unconditionally, regardless of the `Accept` header. This is layered on top of the existing content-negotiation path (`Accept: application/json` continues to work on any page).
*   **Rationale**: Eliminates the need for a separate `api/` directory. Pages in `pages/api/` with `json_first = true` are API endpoints with full routing, typed deps, actions, and FSR support. The `apiDir` config key exists but `startKiln()` does not wire it — `json_first` is the idiomatic replacement.
*   **Implementation**: `PageDefinition.json_first` (`core/src/types.ts`), `PageOptions.jsonFirst` + `extractPageOptions` (`routekit/src/page-options.ts`), content-negotiation guard widened to `wantsJson(req) || options.jsonFirst` (`routekit/src/boot.ts` line ~185).

### ADR-013: Streaming SSR is Not Needed
*   **Status**: DECISION (2026-07-08)
*   **Decision**: Kiln will not implement Streaming SSR or React Suspense boundaries.
*   **Rationale**: Streaming SSR solves "my `load()` is slow so the user sees a blank screen." Kiln's FSR architecture eliminates this problem at a higher level: promoted routes serve pre-baked HTML from Redis instantly (nothing to stream); un-promoted routes should keep `load()` fast by returning a shell + `LiveProp` placeholders, which the SSE channel fills after the shell renders. This pattern is strictly superior to streaming — it handles initial load AND ongoing updates. Adding streaming SSR would solve a problem the architecture already eliminates.

### ADR-014: React Islands over Baked HTML (Store-Bridge Hydration)
*   **Status**: ACCEPTED 2026-07-10 · **Implementation spec**: `docs/design/adr-014-react-islands.md` (prescriptive, phase-by-phase — read it before writing any code)
*   **Decision**: Client-side React is supported through **islands only**. Baked HTML remains the canonical UI; interactive components are authored in an `islands/` directory (sibling of `pages/`), wrapped with `island(Component, name, { hydrate })` from `@kiln/react`, SSR'd into the baked shell inside a `data-kiln-island` marker, and hydrated individually by a react-free bootstrap (`/_silcrow/islands.js`). Full-page hydration is prohibited.
*   **Invariants** (normative; each has a test — see spec §3):
    1. With JS disabled every page still renders fully from baked HTML (islands degrade to their SSR output).
    2. `hydrateRoot` is only ever called on island markers — never on `document`/`body`/layouts.
    3. silcrow's DOM patchers never touch anything inside `[data-kiln-island]`.
    4. Live data inside an island uses `target: 'store'` + `useLiveValue()`; a dom-target `LiveProp` inside an island is a bake-time warning, not an auto-tag.
    5. Hydration props come from the marker (`data-kiln-props`, bake-time values via the seed codec); freshness afterwards comes only from Silcrow store subscriptions. Islands never self-fetch initial data.
    6. Markers embed island *names*, never chunk URLs; the bootstrap resolves names through a `no-store` manifest (`/_kiln/islands.json`) — this is the deploy-skew defense. A failed chunk gets one guarded reload, then fails static.
    7. Any hydration failure leaves baked HTML intact and emits `kiln:island-error`.
    8. Everything embedded in HTML goes through `encodeSeed`/`decodeSeed` (`@kiln/core/seed-codec`), never bare `JSON.stringify`.
*   **Rationale**: FSR's value is that promoted routes serve pre-baked HTML and never re-run component code; silcrow patches that HTML surgically. Full hydration hands the DOM to React, which would overwrite silcrow's patches and re-run the whole tree client-side — rebuilding Next.js on top of FSR while destroying its cost model. Islands capture the actual motivation (React-dependent ecosystem: component libraries, forms, animation, charts work inside islands) while the store remains the single seam between the two renderers — a seam Kiln already built (`LiveProp` `target: 'store'`, Silcrow atoms, `@kiln/react` hooks).
*   **Division of labor**: Kiln owns rendering, caching, transport, data, navigation, and the store. React owns interactivity inside declared islands, always reading through the store. App-scoped React libraries (TanStack Query, Redux) integrate by hydrating from the seed and subscribing to `live:*` store publishes — never by owning fetching.
*   **Consequences**: `BAKED_RENDER_VERSION` bumps to 2 when markers ship (forces clean re-bake of all cached routes); `applyLivePropMarkers` stops tagging store-target fields; a new `islands/` app directory convention; nested islands, client routers, and Server Components are explicitly out of scope (see spec non-goals).

### ADR-015: App request hook (`handle`) + `req.locals`
*   **Status**: ACCEPTED 2026-07-16 · **Agent guide**: `docs/agents/auth.md`
*   **Decision**: Apps express per-request policy (auth, request-id, logging) through a single `handle(req: KilnRequest, res: KilnResponse)` export in `hooks.ts` (the `KilnHandle` type in `@kiln/core`), and carry per-request data forward via a required `locals: Record<string, unknown>` field on `KilnRequest`. The adapter runs `handle` after it builds the `KilnRequest` and before every Kiln-registered route's `load()`/action (pages, actions, SSE, including framework-internal routes); `handle` mutates `req.locals` to attach data and writes to `res` (redirect/json) to short-circuit — if `res.bodyType` is set on return, the adapter sends it and skips the route handler. This is SvelteKit's `handle` + `event.locals`.
*   **Replaces**: the earlier Elysia-coupled `KilnHooks.onRequest(ctx)` (raw Elysia context, ran outside the Kiln request path, couldn't populate a `KilnRequest`). `onError`/`onStart`/`onStop` remain adapter-lifecycle hooks.
*   **Rationale**: the auth gate and the `load()` that needs the user sat on opposite sides of `wrapRequest`, forcing every protected page to re-resolve the session. `handle` resolves it once into `req.locals`; `requireUser(req)` becomes a sync read. Chokepoint is the **adapter** (not `buildPageHandler`) so one allowlist gates framework-internal routes too — no regression exposing `/__kiln/inspect` or the FSR SSE stream. Contract lives in core (`KilnRequest`/`KilnResponse`), never an Elysia macro, so it holds across adapters.
*   **Consequences**: `KilnRequest` gains a required `locals` field — every synthetic request literal must set it (`{}`). Layout loads and startup prebakes set `locals: {}` **deliberately empty** (cache-safety: a baked layout must not embed one user's data). Auth-dependent pages must be `promote_after = false`.

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
