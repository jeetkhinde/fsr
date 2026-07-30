# Active Work Context

**Kiln framework** workspace only. Completed-session history → [work-log.md](work-log.md). App-specific work lives under `apps/<app>/.memory/`.

Last updated: 2026-07-27

## Current State

- Branch: `fix/emit-event-non-bigint-id` — the 2026-07-27 source audit plus fixes for all six of its
  §1 defects (see [bugs-resolved.md](bugs-resolved.md) §1). Not yet merged.
- Recently merged to `main` (`758eb44`):
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
- PostgreSQL: needed for `test:integration` and `apps/jags-list`
- Redis: needed for FSR / LiveProp SSE features and related tests

## Next Priorities (from [roadmap.md](roadmap.md))

1. **External watcher process** — dev-selectable, default `'embedded'`. NOT implemented: no watcher
   process, IPC or daemon exists (investigated 2026-07-29). Blocked on how an out-of-process watcher
   would invoke a `Live.list`'s closures — see [roadmap.md](roadmap.md) § Phase 4.2.
2. ~~Fine-grained debounce scheduling~~ — DONE (already implemented; asserted 2026-07-29).
3. ~~`address-book` layout migration~~ — MOOT: `examples/address-book` was deleted 2026-07-30
   (see [work-log.md](work-log.md)). The latent framework hazard it exposed is still open — the
   purity tracker does not track `params`, which is wrong for a layout reading a DESCENDANT's param;
   recorded in [roadmap.md](roadmap.md) § Phase 4.4.
4. ~~DX backlog~~ — all nine Phase 5 items DONE 2026-07-29.

> `promote_after` was previously priority #1 here. **Resolved** by ADR-016 (2026-07-19): the bake
> classifier keeps session-reading pages pure SSR automatically and `promote_after` was hard-removed.
> The old cross-reference to `bugs-active.md` §1 pointed at a section that no longer existed.
