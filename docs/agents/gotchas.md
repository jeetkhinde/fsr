# Gotchas — read before assuming a feature exists

Kiln has several surfaces that are **typed, scaffolded, or discovered but not actually wired**. Don't generate code that relies on them. Verified against source as of 2026-07-13.

| You might reach for… | Reality | Do this instead |
|----------------------|---------|-----------------|
| `apiDir` / an `api/` folder for routes | Config key exists and `create-kiln` scaffolds it, but `startKiln()` never loads it — **not served at runtime** | `json_first = true` page, content negotiation, or `actions` ([data-loading.md](data-loading.md)) |
| `_loading.tsx` | Discovered by the router but **no server-side semantic** | Return a fast shell + `LiveProp` fields ([live-and-islands.md](live-and-islands.md)) |
| `cache.provider: 'memory'` or `'sqlite'` | **Not implemented** — throws `StartupError('UnsupportedProvider')` at boot | `'filesystem'` (default) or `'redis'` ([rendering-and-caching.md](rendering-and-caching.md)) |
| `LiveProp` on a `cache_key`-variant page | **Skipped** with a one-time warning — live updates don't fire | Use LiveProp on non-variant pages |
| i18n (`KilnI18n`) | Exists in `@kiln/core` but **not integrated into any request path** | Handle locale yourself for now |
| Streaming SSR | Deliberately absent — see [rendering-and-caching.md](rendering-and-caching.md) | FSR + `LiveProp` over SSE |
| Full-page React hydration | **Prohibited** (ADR-014) | Islands only ([live-and-islands.md](live-and-islands.md)) |
| `dom`-target `LiveProp` inside an island | Bake-time warning; silcrow won't patch inside the React root | `target: 'store'` + `useLiveValue` |
| `fsr.watcher: 'external'` | Typed, implementation only partial | Use `'embedded'` |

## Naming / API traps

- **Page cache variant export is `cache_key`** (snake_case). The camelCase `cacheKey` is deprecated.
- **`Live` is imported from `@kiln/core`**, not `@kiln/live`. Client hooks (`island`, `useLiveValue`, `useSilcrowForm`, …) come from `@kiln/react`.
- **Redis is NOT globally required** — only for FSR / LiveProp SSE. Don't add a Redis dependency to a static site.
- **`AppError.redirect(path)` is returned from actions** (→ 303); the other `AppError.*` factories are thrown.

## Verification habit

This surface moves fast. Before asserting "Kiln supports X," check `.memory/features.md`, then grep the source (`packages/*/src`). If this file disagrees with the code, the code wins — and fix this file.
