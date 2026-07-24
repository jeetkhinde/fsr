# Rendering modes & caching

The rendering mode is **observed, not declared** (ADR-016). Source: `packages/routekit/src/page-options.ts`, `purity.ts`, `boot.ts`; cache in `packages/engine/src/cache.ts`, `packages/core/src/config.ts`.

## `bake` — one optional export, default auto

| `export const bake` | Behaviour |
|---|---|
| *(absent)* | **Auto.** Bakes on the first render whose `load()` never touched `req.locals` / `headers` / `query` / `raw` / body. One identity-touching render demotes the route to pure SSR for the process lifetime and deletes stale artifacts. Session pages need **no** declaration. |
| `'static'` | Prebaked at startup when `entries()` exists; otherwise bakes on first request. |
| `'shared'` | Always bakes on first render, even if identity was accessed (dev-mode warning). |
| `false` | Pure SSR. Never cached. Escape hatch for impurity the tracker can't see (e.g. `load()` reading per-user rows directly). |
| `'user'` | **Cached per `(route, user id)`** via the app's `identity` hook (hooks.ts, ADR-017). Anonymous requests fall back to SSR. Actions delete the actor's copy (read-your-own-writes); scalar `LiveProp` patches are per-user and SSE-authorized server-side. Requires a query-free `load()` — pages reading `?error`/`?invited`-style banners must stay SSR until query joins the key. `Live.list` not yet supported per-user. |

`promote_after` / `fsr.promoteAfterHits` no longer exist; exporting them fails boot with `StartupError('RemovedOption')`. Promotion is artifact presence — there is no hit counter, and the cached read path performs zero Postgres queries. `cache_key` pages are exempt from auto-demotion (declaring a key states that the varying input `load()` reads is exactly what the key partitions on) and bake per variant on first hit.

Layouts are classified the same way: an identity-touching layout `load()` is never pattern-cached and blocks the page bake too (its HTML embeds in the page shell).

**Deploy invalidation:** set `fsr.buildId` (e.g. the git SHA) and baked snapshots self-invalidate on the first read after a deploy — no manual flush. Without it, flush the app's Redis namespace and `.kiln-cache` when deploying breaking cache changes (as when upgrading across ADR-016).

**The identity hook** (`hooks.ts`): `export const identity: KilnIdentity = (req) => (req.locals.user as { id: string } | undefined)?.id ?? null;` — a stable user id, never a session token (sessions rotate and multiply per device). It also authorizes per-user SSE: the `/__kiln/fsr` subscription resolves the user server-side, so patch streams cannot be subscribed cross-user.

### Pre-baking dynamic routes (SSG)

```tsx
export const bake = 'static';
export async function entries() {
  return [{ id: '1' }, { id: '2' }]; // params to pre-bake for /posts/[id]
}
```

### Per-page options (all optional exports)

- `revalidate` — seconds before a stale cache entry is revalidated (`false` to disable)
- `debounce` — seconds to debounce invalidation patches
- `pinInRedis` — skip TTL expiry for this route's Redis entries
- `patch_mode: 'json' | 'both'` — SSE delivery mode for live fields
- `json_first: true` — always return JSON (see [data-loading.md](data-loading.md))

## When do you need Redis / Postgres?

**Only for FSR and `LiveProp` SSE.** A pure SSG / ISR / SSR app runs on the disk cache alone.

- **Redis** — hot serve tier + pub/sub event bus for live invalidation
- **Postgres** — durable metadata, dependency links, recency; `LISTEN/NOTIFY` drives cache invalidation
- **Disk** — always-present cold fallback (`.kiln-cache` by default)

## Cache invalidation (no polling)

A DB mutation fires `pg_notify('kiln_invalidate', …)` → `FsrWatcher` → Redis pub/sub → SSE hub → `silcrow.js` patches the DOM. Instant, event-driven.

## Auto-derived dependencies (auto-deps)

A live field doesn't need a manual `dependsOn` — Kiln can observe which tables `load()` touched and derive it. Swap the page's Postgres client for `createKilnSql` (`@kiln/core`) and every table queried through it during a request is unioned into that render's `LiveProp`/`Live.list` fields' `depends_on`:

```ts
// db/client.ts
import { createKilnSql } from '@kiln/core';
export const sql = createKilnSql(process.env.DATABASE_URL!);
```

```tsx
// pages/dashboard.tsx
import { sql } from '../db/client.js';
import { Live } from '@kiln/core';

export async function load() {
  const [{ count }] = await sql`SELECT count(*)::int FROM projects`;
  return {
    // No manual dependsOn — 'projects' is captured automatically because
    // load() queried it through createKilnSql.
    projectCount: Live.value(count),
  };
}
```

- **What it captures**: `boot.ts` runs every request's real `load()` call inside `withDepCapture` (`@kiln/core`); `createKilnSql` records the table names parsed out of each tagged-template query into that capture scope. When a page's live fields are persisted, the observed tables are unioned into each field's `depends_on` — an explicit `Live.value(x, ['sessions'])` still keeps `'sessions'`, plus whatever was auto-observed.
- **Table-level, not row-level.** Table names are parsed from `FROM`/`JOIN`/`INTO`/`UPDATE` with a best-effort regex — `WHERE` predicates aren't inspected. Over-capture (an extra table the query touched but didn't strictly need) only costs one extra revalidation check; the regex itself only ever over-matches, never misses a table it can see, so a loose regex is the safe failure direction *for the regex*. That's not an absolute "auto-deps can never under-invalidate" guarantee for the capture mechanism as a whole, though: queries run inside `sql.begin(async tx => tx\`...\`)` go through the raw transaction object, which bypasses the capture Proxy entirely, so tables read transactionally inside a `load()` are **not captured at all** — a real, pre-existing under-capture gap (see [gotchas.md](gotchas.md)). For row-scoped precision (`contacts:id=42`), or to cover a `.begin()`-only read, pass a manual dependency key — see [live-and-islands.md](live-and-islands.md#manual-dependency-keys-the-row-level-escape-hatch).
- **Scope**: auto-deps only populates a live field's `depends_on`. It has no effect on the route's own baked HTML+JSON artifact — that artifact's staleness is TTL/tombstone-driven, unrelated to `depends_on`. A page with no `LiveProp`/`Live.list` fields has nothing to attach the captured tables to.
- **Opt out**: `fsr.autoDeps = false` in `kiln.config.ts` disables the union entirely; fields fall back to only their explicit `dependsOn`. Default on.
- **Requires `createKilnSql`.** A plain `new SQL(url)` (or any other client) isn't instrumented — queries run through it are invisible to auto-deps. Outside a capture scope `createKilnSql` behaves exactly like `new SQL(url)`, so it's a safe drop-in everywhere.

## `kiln sync-triggers` — install/verify invalidation triggers

Auto-deps and manual dependency keys both assume something fires `pg_notify('kiln_invalidate', …)` when a row changes. Rather than hand-writing a trigger function per table, declare the tables in `kiln.config.ts` and let the CLI install a shared one:

```ts
// kiln.config.ts
export default defineConfig({
  fsr: {
    postgresUrl: process.env.DATABASE_URL,
    triggerTables: [
      { table: 'projects' },                                    // depKey defaults to 'projects'
      { table: 'tasks', events: ['insert', 'update', 'delete'] }, // default events, spelled out
      { table: 'notifications', ownerColumn: 'user_id' },        // owner-scoped — see below
      { table: 'activity', events: ['insert'] },                  // append-only tables need only INSERT
    ],
  },
});
```

```sh
kiln sync-triggers          # installs any missing trigger; idempotent, safe to re-run
kiln sync-triggers --check  # CI mode: never writes; exits non-zero if any table is missing its trigger
```

Run it once after every migration that adds or renames a table listed in `triggerTables`. Each table gets `AFTER INSERT OR UPDATE OR DELETE ON <table> FOR EACH ROW EXECUTE FUNCTION kiln_emit_event('<depKey>'[, '<ownerColumn>'])`, named `<table>_kiln_invalidate`. `sync-triggers` checks `pg_trigger` by name first — an existing trigger with that name is left alone regardless of what it does. If you're migrating off a hand-written trigger that happens to share this naming convention, `DROP` it explicitly in your migration first, or `sync-triggers` will believe the real one is already installed. See `packages/create-kiln/src/templates.ts`'s migration for the pattern.

Tables with a composite primary key (no plain `id` column) aren't supported by the generic trigger — `kiln_emit_event()` unconditionally reads `NEW.id`/`OLD.id` and errors on a table without one. Keep a hand-written trigger for those; `apps/jags-list/migrations/0000_init.sql`'s `task_labels` trigger is the reference example.

### `owner` — per-user invalidation scoping

Pair `ownerColumn` with `bake = 'user'` (or a per-user `LiveProp`) so one user's write doesn't invalidate every other user's cached artifact:

```ts
{ table: 'notifications', ownerColumn: 'user_id' }
```

When a trigger names an owner column, `kiln_emit_event()` resolves that column's value on the changed row and includes it as `owner` in the `pg_notify` payload; `invalidateDepKey(depKey, owner)` then marks stale only the shared row (`user_key = ''`) plus that one owner's per-user row — every other user's cached snapshot is untouched. Omit `ownerColumn` and every `user_key` sharing that dep key goes stale, exactly as before this feature existed (backward-compatible default).

**Known limitation — deletes are not owner-scoped.** A `DELETE` on a table with `ownerColumn` still tombstones the dependent route for every user, not just the row's owner (`FsrWatcher.notifyDelete` → `tombstoneDependentRoutes`, a pre-existing code path left unchanged — see ADR-018). This only matters once an app combines `bake = 'user'` with a live field that depends on a table whose rows get deleted.

## Freshness tiers: active vs. dormant

Eagerly re-running `load()` for every stale live field the instant its dependency changes is free when someone's watching and wasted work at scale when nobody is. Kiln splits stale-slot revalidation into two tiers:

- **Active** — a route with an open `/__kiln/fsr` SSE subscription within the last `fsr.activeWindowSecs` (default 30s; a subscribe call pins the route active via `markActive`). The background `FsrWatcher` tick eagerly re-runs `load()` and patches these routes' stale live fields the moment their dependency invalidates, so the connected client sees the update pushed to it.
- **Dormant** — everything else. The watcher tick skips these routes (nobody's connected to receive a push, so eager revalidation would be wasted); their staleness sits untouched in `kiln_fsr` until the next real request. That request's cache-hit path checks for a dormant-stale slot before serving the cached shell, and rebuilds synchronously on that read rather than serving known-stale content.

Net effect: freshness is instant for anyone with the page open, and correct-on-next-read for everyone else — without the watcher doing unbounded eager work for routes nobody's watching.

## Cache providers (advanced)

The default `create-kiln` config configures caching through the `fsr` block. If you set an explicit `cache.provider` in `kiln.config.ts`:

| Provider | Status |
|----------|--------|
| `'filesystem'` | **default** — disk cache (+ Redis hot tier when an FSR redis URL is set) |
| `'redis'` | disk cold tier + Redis hot tier |
| `'memory'` / `'sqlite'` | **NOT implemented** — `startKiln()` throws `StartupError('UnsupportedProvider')` at boot |

## Why Kiln has no streaming SSR (by design)

Streaming SSR exists to hide a slow `load()`. Kiln solves it differently: promoted routes serve pre-baked HTML from Redis instantly (nothing to stream), and un-promoted routes return a fast shell plus `LiveProp` fields delivered over SSE — which keeps updating after load, unlike streaming, which delivers once. Don't reach for streaming SSR; use FSR + LiveProp.
