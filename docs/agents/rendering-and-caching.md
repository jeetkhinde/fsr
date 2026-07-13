# Rendering modes & caching

One integer export controls the rendering mode. Source: `packages/routekit/src/page-options.ts`, `boot.ts`; cache in `packages/engine/src/cache.ts`, `packages/core/src/config.ts`.

## `promote_after` — the single dial

```ts
export const promote_after = 0; // and so on
```

| Value | Mode | Behaviour |
|-------|------|-----------|
| `0` | **SSG** | Baked at startup via the real handler. Dynamic routes need `entries()` |
| `1` | **ISR** | Baked on first request, cached thereafter |
| `N` | **FSR** | Baked after N hits, cached after |
| absent / `false` | **Pure SSR** | Rendered every request, never cached |

### Pre-baking dynamic routes (SSG)

```tsx
export const promote_after = 0;
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
- **Postgres** — durable metadata, dependency links, hit counts; `LISTEN/NOTIFY` drives cache invalidation
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
