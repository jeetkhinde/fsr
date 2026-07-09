# Kiln Project Roadmap

Last updated: 2026-07-08

---

## Completed Milestones

### V1 Baseline
- [x] **Field-Selective Rendering Engine**: Event-driven watcher, SSE hub, field-level cache invalidation
- [x] **Layout-Aware Route Swapping**: `X-PS-Present` headers, `silcrow-target`, layout fragment negotiation
- [x] **Live Lists (`Live.list`)**: Row-level diffs (replace-row, insert, move, remove) via embedded watcher
- [x] **Pattern-Level Layout Caching** (ADR-011): `_layout.tsx` baked once per URL pattern, `layoutSignature` staleness detection
- [x] **Acceptance Testing App**: `examples/address-book` with persistent DB mutations and transactional events

### Infrastructure & DX
- [x] **Git-Based Context Portability**: `.memory/` directory for version-controlled agent context
- [x] **Relative Config Paths**: All AI config files use relative paths, portable across checkouts
- [x] **Standardised Git Hooks**: `post-commit` + `post-merge` run `code-review-graph update`
- [x] **tsc clean across all packages**: `core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`

### Features Shipped in Main (2026-07-08)
- [x] **Image Optimization** (`/_image` endpoint, sharp, disk cache, webp/jpeg/png, domain allowlist)
- [x] **Internationalisation** (`KilnI18n`, `@fluent/bundle`, `.ftl` files, `Accept-Language` negotiation)
- [x] **Service Worker** (`generateServiceWorker()`, 3 strategies, precache, offline fallback — no Workbox)
- [x] **`json_first` page export** (ADR-012): Pages declare themselves JSON-only endpoints; eliminates `api/` directory need
- [x] **Built-in middleware**: CSRF, request timeout (30 s), layout intercept, tracing, server hooks
- [x] **`_error.tsx` / `_loading.tsx` / `_not-found.tsx`** per-directory UI conventions
- [x] **Collocated actions**: `export const actions = { name(req) }` — POST handlers on page files
- [x] **Typed error system**: `AppError`, `AppResult<T>`, `success()`, `failure()`
- [x] **Four cache providers**: `memory | filesystem | sqlite | redis`

---

## Phase 3: Feature Consolidation

1. **Make Redis fully optional** ✅ — Production guard now only requires `postgresUrl`. `startKiln()` auto-wires `KilnCache` Redis from `config.fsr.redisUrl`; `FsrWatcher` falls back to polling when Redis absent; SSE hub was always in-process only.
2. **`apiDir` removed** ✅ — Field deleted from `KilnConfig`, merge logic, `create-kiln` template, and `test-app/kiln.config.ts`. Use `json_first = true` on page files instead.
3. **`@kiln/client` asset resolution cleaned up** ✅ — Removed stale `resolveSilcrowJs()` from `cli.ts` (was searching for old `silcrow` package name). `boot.ts` already used `import.meta.resolve('@kiln/client/silcrow.js')` correctly; `@kiln/client` exports were already correct.

---

## Phase 4: Hardening & Scalability

1. **Cache Partitioning / Personalisation** — Promoted routes bypass `load()`, so user-specific content can't be safely cached. Need key namespacing or session scopes. Until then, personalised routes must stay un-promoted (pure SSR).
2. **External Watcher Process** — `fsr.watcher: 'embedded' | 'external'` is typed but external mode is partially implemented. Decouple watcher from the application thread for high-mutation workloads.
3. **Fine-Grained Debounce Scheduling** — Per-field invalidation windows instead of coarse sweep intervals.
4. **`address-book` Layout Migration** — Migrate `ContactsLayout` to pattern-level caching (currently violates ADR-011 load()-scoping rule by reading `req.query.q` / `req.params.id`).
