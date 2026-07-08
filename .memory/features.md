# Kiln Feature Inventory (Source-Verified)

Last verified: 2026-07-08 by reading actual package source code, not docs.
Source of truth: `packages/core/src/`, `packages/routekit/src/`, `packages/adapter-elysia/src/`.

---

## Routing (`packages/routekit/src/discover.ts`, `manifest.ts`)

- File-based routing from `pages/` directory (configurable via `pagesDir`)
- Dynamic segments: `[id]` → `:id`, catch-all `[...path]` → `*`
- Route groups: `(group)/folder` — stripped from URL pattern
- Index files: `posts/index.tsx` → `/posts`
- Nested layouts via `_layout.tsx` inheritance chains
- Typed routes (compile-time type safety)
- **Special file conventions per directory:**
  - `_layout.tsx` — shared layout wrapping child routes
  - `_error.tsx` — error boundary UI for that directory
  - `_loading.tsx` — loading state UI for that directory
  - `_not-found.tsx` — 404 UI for that directory
- Route priority: static > dynamic (`:param`) > wildcard (`*`)
- `hasEntries` flag: pages exporting `entries()` get pre-baked at startup when `promote_after: 0`

---

## Rendering Modes (`packages/routekit/src/page-options.ts`, `boot.ts`)

All four modes controlled by a **single integer** export `promote_after` on the page file:

| Value | Mode | Behaviour |
|-------|------|-----------|
| `0` | SSG | Baked at startup |
| `1` | ISR | Baked on first request, served from cache thereafter |
| `N` | FSR | Baked after N hits |
| absent | SSR | Baked on every request (no caching) |

- `promote_after: false` disables promotion entirely (always SSR)
- Per-page: `revalidate`, `debounce`, `purge_after`, `pinInRedis`, `patch_mode` exports
- Layout-level baking: `_layout.tsx` files can also export `promote_after`

---

## Live / Real-time (`packages/core/src/live-prop.ts`, `list.ts`)

### LiveProp\<T\>
```ts
Live.value(initialValue, dependsOn, options)
Live.initial(value)          // no dependencies, no updates
```
- **Delivery targets**: `'dom'` | `'dom-and-store'` | `'store'`
  - `dom` — patches `s-live="slot_name"` DOM node via SSE
  - `store` — updates client-side store only
  - `dom-and-store` — both simultaneously
- Fluent builder: `.debounce(seconds).target('store').revalidate(300)`
- Dependency keys: plain string `"contacts:id=42"` OR structured `{ table, column, value }`

### Live.list\<T\>
```ts
Live.list({ query, key, dependsOn, initial, debounce, revalidate })
```
- Returns a typed array (`T[]`) with metadata attached via `Symbol.for('kiln.live-list.meta')`
- Server-side row-level diffs: `replace-row`, `insert`, `move`, `remove`
- `keyOf(row)` function determines row identity for reconciliation

---

## Middleware (`packages/adapter-elysia/src/middleware/`)

All middleware is **built-in and first-party**, applied automatically by `startKiln()`:

| Middleware | File | Notes |
|---|---|---|
| CSRF protection | `csrf.ts` | Origin/referer double-submit check on POST/PUT/PATCH/DELETE with form content-type |
| Request timeout | `timeout.ts` | AbortController-based, default 30 s, returns 408 |
| Layout intercept | `layout-intercept.ts` | Parses `silcrow-target` and `X-PS-Present` headers into `req.isEnhanced`, `req.layoutsPresent` |
| Compression | `compression.ts` | Stub (pass-through currently) |
| Tracing | `tracing.ts` | Logs `→ METHOD /path` and `← METHOD /path STATUS` |

### Server hooks (`hooks.ts` convention)
Place a `hooks.ts` at the project root exporting any of:
```ts
export const onRequest = async (ctx) => { ... }  // auth guards, rate limiting
export const onError   = async (ctx) => { ... }
export const onStart   = async () => { ... }
export const onStop    = async () => { ... }
```
Kiln auto-loads this file and wires it into Elysia on boot. This is Kiln's middleware layer.

---

## Actions (collocated POST handlers)

Export `actions` from any page file:
```ts
export const actions = {
  async create(req: KilnRequest) { ... return { success: true } },
  async delete(req: KilnRequest) { ... }
}
```
- Registered as POST to the same URL pattern as the page
- Action name dispatched via query param: `POST /contacts?/create`
- Redirects (`AppError.redirect()`) are handled transparently

---

## Content Negotiation (pages as JSON endpoints)

Any page's `load()` result is automatically served as JSON when the client sends `Accept: application/json` (and no `text/html`). This means **the same URL serves HTML to browsers and JSON to API clients** — no separate API route needed for data that backs a page.

---

## API Directory

- `apiDir: './api'` is a first-class config key, scaffolded by `create-kiln`
- **Status**: config type exists, directory is included in `tsconfig.json`, but `startKiln()` does NOT currently discover or wire routes from `apiDir`. It only calls `discoverRoutes(pagesDir)`.
- Workaround: register standalone endpoints directly on the Elysia app instance.

---

## Error Handling (`packages/core/src/errors.ts`)

```ts
AppError.notFound(msg?)        // 404
AppError.unauthorized(msg?)    // 401
AppError.validation(msg)       // 422
AppError.internal(msg?)        // 500
AppError.redirect(path)        // 303 — caught by page handler, calls res.redirect()

type AppResult<T> = { ok: true; data: T } | { ok: false; error: AppError }
const r = success(data)        // { ok: true, data }
const r = failure(appError)    // { ok: false, error }
```
Throw an `AppError` from `load()` or `actions` — the page handler catches it and maps to the correct HTTP response.

---

## Cache (`packages/core/src/config.ts`)

Four providers via `CacheConfig.provider`:

| Provider | When to use |
|----------|-------------|
| `'memory'` | Dev / single-instance / testing |
| `'filesystem'` | Single-instance with persistence |
| `'sqlite'` | Lightweight production without Redis |
| `'redis'` | Multi-instance / FSR live updates (required for LiveProp SSE) |

**Redis is only required when FSR/live SSE features are enabled.** SQLite or memory cache work for pure SSG/SSR/ISR apps.

---

## Image Optimization (`packages/routekit/src/image-handler.ts`)

- Endpoint: `/_image?src=&w=&q=&f=`
- Backed by `sharp` (lazy import)
- Formats: `webp`, `jpeg`, `png`
- Disk cache at `images.cacheDir` — immutable, `Cache-Control: max-age=31536000`
- Domain allowlist: `images.domains[]`
- Processing concurrency: `images.concurrency` (default 4)
- Path traversal protection built in
- Enabled via `images.enabled: true` in config

---

## Internationalisation (`packages/core/src/i18n.ts`)

```ts
const i18n = new KilnI18n({ defaultLocale: 'en', locales: ['en', 'fr'], localesDir: 'locales' })
await i18n.load()                      // loads .ftl files from locales/<locale>/*.ftl
const locale = i18n.locale(req)        // negotiates from Accept-Language header
const msg = i18n.t(locale, 'key', {})  // formats message with @fluent/bundle
```
- Backed by `@fluent/bundle` + `@fluent/langneg`
- `.ftl` (Fluent) message format

---

## Service Worker (`packages/routekit/src/sw-template.ts`)

```ts
generateServiceWorker({
  enabled: true,
  strategy: 'cache-first' | 'stale-while-revalidate' | 'network-first',
  precache: ['/offline.html'],
  exclude: ['/api/'],
  offlineFallback: '/offline.html'
})
```
Custom SW generated at runtime — no Workbox dependency.

---

## Configuration (`packages/core/src/config.ts`)

```ts
defineConfig({ port, pagesDir, apiDir, web, backend, cache, fsr, images, i18n, serviceWorker, client })
loadConfigFromEnv(baseConfig)  // overrides from env vars
```

Environment variable overrides:
- `KILN_WEB_HOST`, `KILN_WEB_PORT`
- `KILN_BACKEND_URL`, `KILN_BACKEND_HOST`, `KILN_BACKEND_PORT`

Two-process model: `web` config (frontend) + `backend` config (API server) — `web.backendUrl` points the frontend at the backend.

### React runtime config
```ts
client: {
  react: { ssr: boolean, nodeBin: string, concurrency: number },  // default concurrency: 4
  inlineRuntime: boolean   // embed silcrow.js inline into HTML instead of external script
}
```

### FSR watcher mode
```ts
fsr: { watcher: 'embedded' | 'external' }  // external mode is typed, partial implementation
```

---

## Why Kiln Does NOT Need Streaming SSR

**Promoted routes** serve a fully-assembled HTML string from Redis — response is instant. There is nothing to stream; the work is already done.

**Un-promoted (pure SSR) routes**: Kiln's idiomatic answer is not streaming but restructuring — keep `load()` fast (return cheap shell data + `LiveProp` placeholders for slow fields), then push slow data in via SSE after the shell renders. This gives the same progressive load UX as streaming SSR, plus the field stays live for future updates — two problems solved by one mechanism.

**Conclusion**: Streaming SSR solves "page is slow to compute." FSR eliminates the computation from the request path entirely. Adding streaming SSR to Kiln would be solving a problem the architecture already eliminates at a higher level.
