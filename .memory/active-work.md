# Active Work Context

**Kiln framework** workspace only. Completed-session history → [work-log.md](work-log.md). App-specific work lives under `apps/<app>/.memory/`.

Last updated: 2026-07-17

## Current State

- Branch: `main` (clean).
- Recently merged to `main`:
  - PR #9 — app request `handle` hook + `req.locals` for adapter-agnostic auth (`26a45f0`).
  - PR #8 — superadmin / admin / user role model + friendly invite errors.
  - PR #7 — `cache.namespace` for per-app Redis key/channel isolation.
  - PR #6 — Jag's List Plan 1 foundation (**app**, `apps/jags-list`).
- Last full framework verification: **2026-07-12** — `tsc --noEmit` clean across all packages; unit suite 149 pass / 0 fail. Re-run before trusting, since PRs #7–#9 landed after that date.

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

1. **`promote_after` framework fix** — absent `promote_after` currently is not pure SSR; see [bugs-active.md](bugs-active.md) §1. Design decision pending.
2. **External watcher process** — `fsr.watcher: 'external'` is typed but only partially implemented.
3. **Fine-grained debounce scheduling** — per-field invalidation windows instead of coarse sweep intervals.
4. **`address-book` layout migration** — migrate `ContactsLayout` to pattern-level caching (currently violates the ADR-011 `load()`-scoping rule).
