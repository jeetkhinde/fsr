# Active Work Context

**Kiln framework** workspace only. Completed-session history → [work-log.md](work-log.md). App-specific work lives under `apps/<app>/.memory/`.

Last updated: 2026-07-27

## Current State

- Branch: `main` (clean) @ `758eb44`.
- Recently merged to `main`:
  - PRs #14–#20 — ADR-018 (auto-deps, `sync-triggers`, owner-scoped invalidation, freshness
    tiers) plus its follow-up fixes: SSE keepalive timeout, sync-triggers drift detection, Redis
    variant scoping, `upsertSlot`/`markFresh` stale-flag version guards, `dependsOn` retention,
    `unregisterRoute` loader cleanup.
  - PR #9 — app request `handle` hook + `req.locals` for adapter-agnostic auth (`26a45f0`).
  - PR #8 — superadmin / admin / user role model + friendly invite errors.
  - PR #7 — `cache.namespace` for per-app Redis key/channel isolation.
  - PR #6 — Jag's List Plan 1 foundation (**app**, `apps/jags-list`).
- Last full framework verification: **2026-07-27** @ `758eb44` — `bun run test:unit` 208 pass /
  51 skip / 0 fail; `bun run build` green across all packages. `test:integration` NOT run (needs
  live PG/Redis) — re-run it before trusting the DB paths.

## Workspace Checkpoints

### Version Control
- Remote: `https://github.com/jeetkhinde/fsr.git`

### Validation
- Unit tests: `bun run test:unit`
- Type check: `bun run --cwd packages/<name> tsc --noEmit` — should be clean in all packages
- Build: `bun run build` in each package before trusting cross-package consumption (`dist/` must be current — stale `dist/` has silently invalidated runs before; see [work-log.md](work-log.md))

### Infrastructure required for full test suite
- PostgreSQL: needed for `test:integration` and the `examples/address-book` app
- Redis: needed for FSR / LiveProp SSE features and related tests

## Next Priorities (from [roadmap.md](roadmap.md))

0. **Fix [bugs-active.md](bugs-active.md) §1.1 first** — `kiln_emit_event` breaks writes outright on
   any table without a bigint-castable `id` (UUID PKs, composite keys). Verified against live
   Postgres on 2026-07-27. Everything else on this list is smaller than that.
1. **External watcher process** — `fsr.watcher: 'external'` is typed but only partially implemented.
2. **Fine-grained debounce scheduling** — per-field invalidation windows instead of coarse sweep intervals.
3. **`address-book` layout migration** — migrate `ContactsLayout` to pattern-level caching (currently violates the ADR-011 `load()`-scoping rule).
4. **DX backlog** — [roadmap.md](roadmap.md) § Phase 5.

> `promote_after` was previously priority #1 here. **Resolved** by ADR-016 (2026-07-19): the bake
> classifier keeps session-reading pages pure SSR automatically and `promote_after` was hard-removed.
> The old cross-reference to `bugs-active.md` §1 pointed at a section that no longer existed.
