# Gotchas — read before assuming a feature exists

Kiln has several surfaces that are **typed, scaffolded, or discovered but not actually wired**. Don't generate code that relies on them. Verified against source as of 2026-07-13.

| You might reach for… | Reality | Do this instead |
|----------------------|---------|-----------------|
| `apiDir` / an `api/` folder for routes | Config key exists and `create-kiln` scaffolds it, but `startKiln()` never loads it — **not served at runtime** | `json_first = true` page, content negotiation, or `actions` ([data-loading.md](data-loading.md)) |
| `_loading.tsx` | Discovered by the router but **no server-side semantic** | Return a fast shell + `LiveProp` fields ([live-and-islands.md](live-and-islands.md)) |
| `cache.provider: 'memory'` or `'sqlite'` | **Not implemented** — throws `StartupError('UnsupportedProvider')` at boot | `'filesystem'` (default) or `'redis'` ([rendering-and-caching.md](rendering-and-caching.md)) |
| `LiveProp`/`Live.list` on a `cache_key`-variant page | **Not supported** (decided, not a TODO) — skipped with a one-time warning; the page renders but never updates. Live registrations write to the route's base cache paths, which would poison every other variant | Drop the `cache_key`, or drop the live fields and let the route revalidate on its TTL |
| `Live.list` on a `bake='user'` page | **Not supported** (decided) — skipped with a one-time warning. Scalar `LiveProp` fields under `bake='user'` *are* fully supported | Use scalar live fields, or drop `bake='user'` from that page |
| i18n (`KilnI18n`) | Exists in `@kiln/core` but **not integrated into any request path** | Handle locale yourself for now |
| Streaming SSR | Deliberately absent — see [rendering-and-caching.md](rendering-and-caching.md) | FSR + `LiveProp` over SSE |
| Full-page React hydration | **Prohibited** (ADR-014) | Islands only ([live-and-islands.md](live-and-islands.md)) |
| `dom`-target `LiveProp` inside an island | Bake-time warning; silcrow won't patch inside the React root | `target: 'store'` + `useLiveValue` |
| `dom`-target `Live.list` inside an island | Same rule, same warning — rows are marked and then never patched | `target: 'store'` + `useLiveList(name, { key })` ([live-and-islands.md](live-and-islands.md#a-livelist-inside-an-island)) |
| `fsr.watcher: 'external'` | Typed, implementation only partial | Use `'embedded'` |
| An `action` that both writes to `res` and returns a value | The committed body wins; the **return value is ignored** (warns once) | Pick one — commit via `res.html`/`res.json`, or return a value and let Kiln serialize it |
| A logout form in `_layout.tsx` | Actions register against a **page** pattern; layouts have none | Post to a page action absolutely, e.g. `/login?/signout` ([auth.md](auth.md)) |
| A plain `new SQL(url)` client for `load()` queries | **Invisible to auto-deps** — `createKilnSql` is what records tables into a live field's `depends_on` | `createKilnSql` from `@kiln/core/sql` ([rendering-and-caching.md](rendering-and-caching.md#auto-derived-dependencies-auto-deps)) |
| A query run inside ``sql.begin(async tx => tx`...`)``, even with a `createKilnSql` client | **Invisible to auto-deps** — `tx` is bun's raw transaction object, unwrapped by the capture Proxy, so tables read transactionally inside a `load()` are NOT captured (a real under-capture gap, unlike the auto-deps regex itself, which only ever over-captures) | Add a manual `dependsOn` / `Live.value(x, [...])` for any table only ever read inside a `.begin()` block |
| A query run via ``sql.unsafe('SELECT ...')``, even with a `createKilnSql` client | **Invisible to auto-deps** — only tagged-template calls carry capturable SQL text; `.unsafe` is proxied straight through to the base client | Add a manual `dependsOn` / `Live.value(x, [...])` for any table only ever read through `.unsafe` |
| A stale trigger left behind after editing `triggerTables` | `kiln sync-triggers` compares the installed trigger against config and reports `outdated` / recreates it — but **nothing runs it for you**; an un-run sync means an edited `ownerColumn` or `events` never takes effect | Re-run `kiln sync-triggers` after every `db:migrate` and wire `kiln sync-triggers --check` into CI |
| `ownerColumn` scoping a `DELETE` on a `triggerTables` table | **Not owner-scoped** — a delete still tombstones the route for every user, only insert/update are owner-scoped | Be aware when combining `bake = 'user'` with a live field depending on a table whose rows get deleted (see ADR-018) |
| `bake = 'user'` on a dynamic-segment pattern (e.g. `/users/:id`) with `LiveProp` fields | SSE/snapshot identity scoping matches routes by exact string, never a dynamic pattern — live patches won't scope to the subscribing user (warned once at runtime) | Keep `bake = 'user'` + live fields on static-segment routes until this is resolved |

## Naming / API traps

- **Page cache variant export is `cache_key`** (snake_case). The camelCase `cacheKey` is deprecated.
- **`Live` is imported from `@kiln/core`**, not `@kiln/live`. Client hooks (`island`, `useLiveValue`, `useSilcrowForm`, …) come from `@kiln/react`.
- **Redis is NOT globally required** — only for FSR / LiveProp SSE. Don't add a Redis dependency to a static site.
- **`AppError.redirect(path)` is returned from actions** (→ 303); the other `AppError.*` factories are thrown.

## Verification habit

This surface moves fast. Before asserting "Kiln supports X," check `.memory/features.md`, then grep the source (`packages/*/src`). If this file disagrees with the code, the code wins — and fix this file.
