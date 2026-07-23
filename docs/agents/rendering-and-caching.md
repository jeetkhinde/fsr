# Rendering modes & caching

The rendering mode is **observed, not declared** (ADR-016). Source: `packages/routekit/src/page-options.ts`, `purity.ts`, `boot.ts`; cache in `packages/engine/src/cache.ts`, `packages/core/src/config.ts`.

## `bake` — one optional export, default auto

| `export const bake` | Behaviour |
|---|---|
| *(absent)* | **Auto.** Bakes on the first render whose `load()` never touched `req.locals` / `headers` / `query` / `raw` / body. One identity-touching render demotes the route to pure SSR for the process lifetime and deletes stale artifacts. Session pages need **no** declaration. |
| `'static'` | Prebaked at startup when `entries()` exists; otherwise bakes on first request. |
| `'shared'` | Always bakes on first render, even if identity was accessed (dev-mode warning). |
| `false` | Pure SSR. Never cached. Escape hatch for impurity the tracker can't see (e.g. `load()` reading per-user rows directly). |

`promote_after` / `fsr.promoteAfterHits` no longer exist; exporting them fails boot with `StartupError('RemovedOption')`. Promotion is artifact presence — there is no hit counter, and the cached read path performs zero Postgres queries. `cache_key` pages are exempt from auto-demotion (declaring a key states that the varying input `load()` reads is exactly what the key partitions on) and bake per variant on first hit.

Layouts are classified the same way: an identity-touching layout `load()` is never pattern-cached and blocks the page bake too (its HTML embeds in the page shell).

**Upgrading across this change:** artifacts baked by pre-ADR-016 code are trusted as-is by the new runtime — flush the app's Redis namespace and `.kiln-cache` on deploy.

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

## Cache providers (advanced)

The default `create-kiln` config configures caching through the `fsr` block. If you set an explicit `cache.provider` in `kiln.config.ts`:

| Provider | Status |
|----------|--------|
| `'filesystem'` | **default** — disk cache (+ Redis hot tier when an FSR redis URL is set) |
| `'redis'` | disk cold tier + Redis hot tier |
| `'memory'` / `'sqlite'` | **NOT implemented** — `startKiln()` throws `StartupError('UnsupportedProvider')` at boot |

## Why Kiln has no streaming SSR (by design)

Streaming SSR exists to hide a slow `load()`. Kiln solves it differently: promoted routes serve pre-baked HTML from Redis instantly (nothing to stream), and un-promoted routes return a fast shell plus `LiveProp` fields delivered over SSE — which keeps updating after load, unlike streaming, which delivers once. Don't reach for streaming SSR; use FSR + LiveProp.
