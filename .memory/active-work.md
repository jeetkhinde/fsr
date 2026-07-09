# Active Work Context

Last updated: 2026-07-09

## Current State

Branch `main` is clean and up to date with `origin/main`.
Last commit: `7276441` — feat: add json_first page export for JSON-default routes

`tsc --noEmit` is clean across all packages: `core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`.

---

## Completed This Session (2026-07-09)

- [x] **Redis fully optional** — Production guard in `cli.ts` now only requires `postgresUrl` (not `redisUrl`). `startKiln()` in `routekit/boot.ts` auto-creates `KilnCache` Redis client from `config.fsr.redisUrl` when `options.redis` is not passed. `FsrWatcher` already handled `redis: null` gracefully (polling fallback). SSE hub never used Redis. (`packages/cli/src/cli.ts`, `packages/routekit/src/boot.ts`)

## Completed Previously (2026-07-08)

- [x] **`json_first` page export** — Pages exporting `json_first = true` now always respond with JSON regardless of `Accept` header. Eliminates the need for a separate `api/` directory. (`packages/core/src/types.ts`, `packages/routekit/src/page-options.ts`, `packages/routekit/src/boot.ts`)
- [x] **`.memory/features.md` created** — Source-verified feature inventory covering all Kiln features. Linked from `Agents.md`. Read this before scanning code.
- [x] **ADR-001 corrected** — Redis is only required for FSR/LiveProp SSE, not for all deployments. SQLite/memory/filesystem cache providers work without Redis.

---

## Workspace Checkpoints

### Version Control
- Active branch: `main`
- Remote: `https://github.com/jeetkhinde/fsr.git`
- Status: clean — no uncommitted changes (except `.claude/settings.local.json` which is local-only)

### Validation
- Unit tests: `bun run test:unit` — 102 pass, 1 skip (Postgres-dependent integration test)
- Type check: `bun run --cwd packages/<name> tsc --noEmit` — clean in all packages
- Build: `bun run build` in each package before testing cross-package consumption (dist/ must be current)

### Infrastructure required for full test suite
- PostgreSQL: needed for `test:integration` and the address-book example
- Redis: needed for FSR/LiveProp SSE features and related tests

---

## Next Priorities (from roadmap)

1. **Phase 3 — Feature Consolidation**
   - ~~`apiDir`~~ removed entirely from `KilnConfig`; `json_first` is the replacement
   - ~~`@kiln/client` asset resolution~~ cleaned up; stale `resolveSilcrowJs()` removed from `cli.ts`

2. **Phase 4 — Hardening**
   - Cache partitioning for personalised routes (promoted routes bypass `load()`, can't serve user-specific content yet)
   - External watcher process (`fsr.watcher: 'external'` typed, implementation partial)
   - Fine-grained debounce scheduling per-field
