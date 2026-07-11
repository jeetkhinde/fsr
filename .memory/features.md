# Kiln Feature Inventory (Source-Verified)

Last verified: 2026-07-10 on branch `fix/audit-fixes` (full-codebase audit + fixes).
Previous baseline: `7276441` (feat: add json_first page export for JSON-default routes)

**Read this file before scanning code or answering "does Kiln support X?"**

---

## Routing (`packages/routekit/src/discover.ts`, `manifest.ts`)

- File-based routing from `pages/` directory (configurable via `pagesDir`)
- Dynamic segments: `[id]` → `:id`, catch-all `[...path]` → `*`
- Route groups: `(group)/folder` — stripped from URL pattern, no effect on routing
- Index files: `posts/index.tsx` → `/posts`
- Nested layouts via `_layout.tsx` inheritance chains, resolved by `getLayoutsForPage()`
- Typed routes (compile-time type safety via `packages/routekit/src/typed-routes.ts`)
- Route priority: static > dynamic (`:param`) > wildcard (`*`) — sorted in `discoverRoutes()`
- `hasEntries` flag: pages exporting `entries()` get pre-baked at startup when `promote_after: 0`

### Special file conventions (per directory)
| File | Purpose |
|------|---------|
| `_layout.tsx` | Shared layout wrapping all child routes |
| `_error.tsx` | Error UI when a page in/below that directory throws (nearest wins; receives `{ error: { status, message, type }, path }`) |
| `_loading.tsx` | Discovered but **not wired yet** — no server-side semantic today |
| `_not-found.tsx` | UI for `AppError.notFound()` thrown by a page (falls back to `_error.tsx`) |

Thrown `AppError`s map to their real status (404/401/422/500) on page routes;
JSON clients get `{ error, status }`. Non-AppError throws render a 500.

---

## Rendering Modes (`packages/routekit/src/page-options.ts`, `boot.ts`)

All modes controlled by a **single integer export** `promote_after` on the page file:

| Export value | Mode | Behaviour |
|---|---|---|
| `0` | SSG | Baked at startup via the real page handler + synthetic request (`entries()` required for dynamic routes) |
| `1` | ISR | Baked on first request, cached forever after |
| `N` | FSR | Baked after N hits, cached after |
| absent / `false` | Pure SSR | Baked on every request, never cached |

Per-page options (all optional exports from the page file):
- `promote_after` — rendering mode integer
- `revalidate` — seconds before stale cache is revalidated (or `false` to disable)
- `debounce` — seconds to debounce invalidation patches
- `purge_after` / `purge_after` — seconds before unused cache entry is evicted
- `pinInRedis` — skip TTL expiry for this route's Redis entries
- `patch_mode: 'json' | 'both'` — SSE delivery mode for live fields
- `json_first: true` — always return JSON regardless of `Accept` header (see below)

---

## JSON-first Pages & API Endpoints

Kiln has **two ways** to serve JSON from a page:

### 1. Content negotiation (default, always available)
Any page's `load()` result is served as JSON when the client sends `Accept: application/json` (and no `text/html`). Same URL, same `load()`, same route — the framework detects the header and returns `res.json(data)` directly, bypassing all HTML rendering.

### 2. `json_first` export (shipped 2026-07-08, commit `7276441`)
```ts
// pages/api/health.ts
export const json_first = true

export async function load(req: KilnRequest) {
  return { status: 'ok', ts: Date.now() }
}
```
- Always returns JSON regardless of `Accept` header — curl, fetch, browser, all get JSON
- No `default` component export required
- The `api/` directory convention (`apiDir` in config) is therefore unnecessary — `pages/api/health.ts` with `json_first = true` IS the API endpoint
- Implemented in: `PageDefinition` (`core/src/types.ts`), `PageOptions` + `extractPageOptions` (`routekit/src/page-options.ts`), `buildPageHandler` content-negotiation guard (`routekit/src/boot.ts` line ~185)

---

## Live / Real-time (`packages/core/src/live-prop.ts`, `list.ts`)

### LiveProp\<T\>
```ts
Live.value(initialValue, dependsOn, options)  // shorthand factory
Live.initial(value)                           // no deps, never updates
new LiveProp(value, dependsOn, options)       // direct constructor
```
Fluent builder:
```ts
new LiveProp(0, ['contacts']).debounce(5).target('store').revalidate(300)
```

**Delivery targets** (`options.target`):
| Target | Effect |
|---|---|
| `'dom'` (default) | Patches `s-live="slot_name"` DOM node via SSE |
| `'store'` | Updates client-side store only (no DOM write) |
| `'dom-and-store'` | Both simultaneously |

**Dependency keys** — two equivalent forms:
```ts
dependsOn: ['contacts:id=42']                    // plain string
dependsOn: [{ table: 'contacts', column: 'id', value: '42' }]  // structured DependencyKey
```

### Live.list\<T\>
```ts
Live.list({ query, key, dependsOn, initial?, debounce?, revalidate? })
```
- Returns a native `T[]` with metadata attached via `Symbol.for('kiln.live-list.meta')` (enumerable: false)
- Server computes row-level diffs: `replace-row`, `insert`, `move`, `remove`
- `key(row)` function determines row identity for reconciliation
- Changing one row in a list of 1000 sends one diff, not 1000 rows

---

## React Islands (ADR-014 — `@kiln/react` `island()`, `packages/client/src/islands.js`)

Client-side React is supported through **islands only** — full-page hydration
is prohibited (see `.memory/decisions.md` ADR-014 and
`docs/design/adr-014-react-islands.md`).

### Authoring

```
app-root/
  pages/dashboard.tsx
  islands/Counter.tsx     ← file basename === island name
```

```tsx
// pages/dashboard.tsx
import Counter from '../islands/Counter.js';
import { island } from '@kiln/react';
const CounterIsland = island(Counter, 'Counter', { hydrate: 'visible' }); // 'load' (default) | 'idle' | 'visible'

export async function load(req) {
  return { start: 41, activeUsers: Live.value(0, ['sessions'], { target: 'store' }) };
}
export default function Dashboard({ start }) {
  return <main><CounterIsland start={start} /></main>;
}
```

```tsx
// islands/Counter.tsx — ordinary React component, default export
import { useLiveValue } from '@kiln/react';
export default function Counter({ start }: { start: number }) {
  const activeUsers = useLiveValue<number>('activeUsers', 0);
  ...
}
```

### The four island rules

1. **Props are bake-time values** (embedded in the marker via the seed codec)
   and must be plain JSON data — no Dates/Maps/functions.
2. **Live data inside an island uses the store**: declare the field with
   `target: 'store'` (no `s-live` DOM slot is generated) and read it with
   `useLiveValue(field, fallback)` — pass the bake-time value as `fallback`
   so SSR and first client render match. SSE scalar patches publish
   `{ value }` to the `live:<field>` Silcrow atom scope.
3. **Silcrow never patches DOM inside `[data-kiln-island]`** — the React root
   owns that subtree. A dom-target LiveProp inside an island triggers a
   bake-time warning.
4. **Navigation stays with silcrow** — use plain `<a>` links; no client
   router inside islands.

### Mechanics

- SSR: `island()` wraps the component's baked output in a
  `data-kiln-island` marker (display:contents) with hydrate strategy + props.
- Build: `kilnIslandsPlugin` (Vite) emits one chunk per island via
  `virtual:kiln-island/<Name>` hydration wrappers (bootstrap stays
  react-free), plus `dist/client/kiln-islands.json` (name → hashed URL,
  content-hash version).
- Serve: `/_kiln/islands.json` (no-store; dev proxies Vite) + bootstrap at
  `/_silcrow/islands.js`, injected only into pages containing markers.
- Skew defense: markers carry island **names**, never URLs; the bootstrap
  resolves through the always-fresh manifest. A missing/failed chunk gets one
  sessionStorage-guarded reload, then fails static and emits a
  `kiln:island-error` CustomEvent (baked HTML always stays on screen).
- Nested islands are unsupported (outermost marker wins).
- `BAKED_RENDER_VERSION` is 2 since islands shipped — older cached snapshots
  re-bake on first request.
- Demo: `test-app/islands/Counter.tsx` + `test-app/pages/islands-demo.tsx`.

---

## Middleware (`packages/adapter-elysia/src/middleware/`)

All built-in, applied automatically by `startKiln()` via `adapter.applyMiddleware()`:

| Middleware | File | Default |
|---|---|---|
| CSRF protection | `csrf.ts` | On — origin/referer double-submit on POST/PUT/PATCH/DELETE with form content-type. `web.trustProxy: true` opts into honoring `x-forwarded-host` |
| Request timeout | `timeout.ts` | 30 s (`web.requestTimeoutMs`) — enforced by the adapter wrapping each page/action handler in `withTimeout`; returns 408. SSE routes exempt |
| Compression | `compression.ts` | Stub (pass-through) |
| Request tracing | `tracing.ts` | Off — enable with `web.tracing: true`; logs `→ METHOD /path` + `← METHOD /path STATUS` |

(`silcrow-target` + `X-PS-Present` parsing into `req.isEnhanced` / `req.layoutsPresent` happens in `wrapRequest` in `context.ts` — the old layout-intercept middleware was redundant and removed.)

### Server hooks (`hooks.ts` at project root)
```ts
export const onRequest = async (ctx) => { /* auth, rate limiting */ }
export const onError   = async (ctx) => { }
export const onStart   = async () => { }
export const onStop    = async () => { }
```
Loaded by `startKiln()` via `adapter.applyServerHooks(process.cwd())` before routes are
registered. This is Kiln's middleware / lifecycle hook layer.

---

## Actions (collocated POST handlers)

```ts
// pages/contacts.tsx
export const actions = {
  async create(req: KilnRequest) {
    const data = await req.formData()
    // ... insert into DB
    return AppError.redirect('/contacts')
  },
  async delete(req: KilnRequest) { ... }
}
```
- Registered as `POST /contacts?/create`, `POST /contacts?/delete`
- `AppError.redirect(path)` caught by handler → `res.redirect(303)`
- Collocated with the page that renders the result — Kiln's equivalent of SvelteKit form actions

---

## Error Handling (`packages/core/src/errors.ts`)

```ts
// Typed errors — throw from load() or actions
AppError.notFound(msg?)        // → 404
AppError.unauthorized(msg?)    // → 401
AppError.validation(msg)       // → 422
AppError.internal(msg?)        // → 500
AppError.redirect(path)        // → 303 redirect

// Result<T> — discriminated union for no-throw style
type AppResult<T> = { ok: true; data: T } | { ok: false; error: AppError }
const r = success(data)        // { ok: true, data }
const r = failure(appError)    // { ok: false, error }
```
- `StartupError` with typed codes: `'ConfigLoad' | 'UnsupportedProvider'`
- `HookError` interface: `{ status, message, source? }`

---

## Caching & Storage (`packages/core/src/config.ts`, `packages/engine/src/cache.ts`)

### Cache providers

```ts
cache: { provider: 'filesystem' | 'redis' }   // default: 'filesystem'
```

| Provider | Behaviour |
|---|---|
| `'filesystem'` | Disk cache at `cache.dir` (default `.kiln-cache`). Redis hot tier added when `fsr.redisUrl` is set |
| `'redis'` | Same disk cold tier + Redis hot tier from `cache.url` (or `fsr.redisUrl`) |
| `'memory'` / `'sqlite'` | **Not implemented** — typed in `CacheProvider` but `startKiln()` throws `StartupError('UnsupportedProvider')` |

**Redis is only required when FSR/LiveProp SSE features are used.** A pure SSG/SSR/ISR Kiln app runs on the disk cache alone. `fsr.artifactTtlSecs` sets Redis expiry for non-pinned entries (also what ages out per-variant `cache_key` Redis keys).

### Three-layer storage (when Redis is active)
1. **Redis** — hot serve + pub/sub event bus
2. **PostgreSQL** — durable metadata, dependency links, hit counts
3. **Disk** — synchronous fallback for any Redis miss (outage, eviction, cold start)

### Pattern-level layout caching (ADR-011)
`_layout.tsx` files bake once per URL pattern (`kiln:layout:html:/dashboard`), shared by all routes beneath. `cache.deleteLayout(pattern)` invalidates with one write.

### Cache invalidation
- Postgres `LISTEN/NOTIFY` → `db-notify.ts` → `FsrWatcher` → Redis pub/sub → SSE hub → `silcrow.js` DOM patch
- No polling. Watcher fires the instant a DB mutation triggers `pg_notify('kiln_invalidate', ...)`

---

## Image Optimization (`packages/routekit/src/image-handler.ts`)

- Endpoint: `/_image?src=<path>&w=<width>&q=<quality>&f=<format>`
- Backed by `sharp` (lazy dynamic import — not required if images disabled)
- Formats: `webp` (default), `jpeg`, `png`
- Disk cache at `images.cacheDir` with `Cache-Control: public, max-age=31536000, immutable`
- Path traversal protection built in
- Domain allowlist: `images.domains[]`
- Processing concurrency: `images.concurrency` (default 4)
- Enabled via `images: { enabled: true }` in `kiln.config.ts`

---

## Internationalisation (`packages/core/src/i18n.ts`)

```ts
const i18n = new KilnI18n({ defaultLocale: 'en', locales: ['en', 'fr'], localesDir: 'locales' })
await i18n.load()                              // loads locales/<locale>/*.ftl
const locale = i18n.locale(req)               // negotiates from Accept-Language header
const msg = i18n.t(locale, 'key', { n: 42 }) // formats Fluent message
```
- Backed by `@fluent/bundle` + `@fluent/langneg`
- `.ftl` (Mozilla Fluent) message format

---

## Service Worker (`packages/routekit/src/sw-template.ts`)

```ts
generateServiceWorker({
  enabled: true,
  strategy: 'cache-first' | 'stale-while-revalidate' | 'network-first',
  precache: ['/shell.html'],
  exclude: ['/api/'],
  offlineFallback: '/offline.html'
})
```
No Workbox dependency — custom SW generated at build time from a template string.

---

## Configuration (`packages/core/src/config.ts`)

```ts
defineConfig({ port, pagesDir, apiDir, web, backend, cache, fsr, images, i18n, serviceWorker, client })
loadConfigFromEnv(baseConfig)  // applies env var overrides on top
```

### Environment variable overrides
- `KILN_WEB_HOST`, `KILN_WEB_PORT`
- `KILN_BACKEND_URL`, `KILN_BACKEND_HOST`, `KILN_BACKEND_PORT`

### Two-process architecture
`web` config (frontend HTTP server) + `backend` config (separate API process). `web.backendUrl` wires them. Kiln supports running as a single unified process or as a web-frontend + backend split.

### React runtime
```ts
client: {
  react: { ssr: boolean, nodeBin: string, concurrency: number },  // default concurrency: 4
  inlineRuntime: boolean   // embed silcrow.js inline into HTML
}
```

### FSR watcher mode
```ts
fsr: { watcher: 'embedded' | 'external' }  // external typed, implementation partial
```

---

## Why Kiln Does NOT Need Streaming SSR

Streaming SSR exists to solve: "my `load()` is slow, so the user sees a blank screen." Kiln's answer is different and better:

1. **Promoted routes** — HTML is pre-baked and sitting in Redis. Response is instant. Nothing to stream.
2. **Un-promoted routes** — Keep `load()` fast by returning a shell quickly, then deliver slow fields via `LiveProp` SSE. The shell renders immediately; live data arrives via the SSE channel and keeps updating indefinitely.

Streaming SSR delivers data once during initial load then stops. FSR delivers data when the page loads AND re-delivers it whenever the underlying data changes. Adding streaming SSR to Kiln would solve a problem that FSR eliminates at a higher architectural level.

---

## API Directory (`apiDir` config)

`apiDir: './api'` is a first-class config key scaffolded by `create-kiln`. However `startKiln()` in `boot.ts` only calls `discoverRoutes(pagesDir)` — it never reads `apiDir`. **The `api/` folder is not loaded at runtime.**

This gap is effectively eliminated by:
1. `json_first = true` export — any page in `pages/` is a JSON endpoint
2. Content negotiation — any page serves JSON to `Accept: application/json` clients
3. Collocated `actions` — POST mutations on the same page file
4. Direct Elysia registration — add raw endpoints to the app instance for true API-only routes
