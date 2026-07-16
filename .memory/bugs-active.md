# Active Bugs, Blockers & Type Errors

Open **framework** issues only. Resolved history → [bugs-resolved.md](bugs-resolved.md). App-level bugs live under `apps/<app>/.memory/`, not here.

> **Last verified**: 2026-07-12 — `tsc --noEmit` clean across every package (`core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`, `client`); unit suite 149 pass / 0 fail.

## 1. Open: absent `promote_after` is not pure SSR (surfaced 2026-07-14)

**Status: OPEN** — real framework defect (the code contradicts its own docs);
no framework fix yet, deferred pending a design decision. Surfaced while
building `apps/jags-list`.

`boot.ts`: `const promoteAfter = options.promoteAfter ?? kilnConfig?.fsr?.promoteAfterHits ?? 2;`
A page that omits `promote_after` falls through to the global
`fsr.promoteAfterHits` (2), so it is promoted + cached after 2 hits — NOT pure
SSR. This contradicts the framework's own docs: `features.md` says
"absent/false → Pure SSR, never cached" and ADR-003 says "absent → SSG" — the
two docs and the code all disagree. Impact: silently breaks per-user auth
pages (observed a per-user home served stale/cross-user after promotion).

App-side workaround (in use): every auth-varying / per-request page must
`export const promote_after = false` (nullish coalescing preserves `false`,
giving true pure SSR). ADR-015 documents this as a requirement.

Framework fix candidates (not yet chosen): (a) make absent === pure SSR so
caching is opt-IN; or (b) reconcile the docs to the code and add a startup
warning when a session-reading `load()` has no explicit `promote_after`.

---

## 2. Infrastructure & Integration Test Issues

*   **Database Invalidation Integration Failures**:
    *   **File**: `packages/engine/src/list-store.test.ts`
    *   **Description**: Integration database tests require a live PostgreSQL connection. If `DATABASE_URL` is not provided in the environment (or missing from `.env` in `test-app/`), tests crash.
    *   **Impact**: `bun run test:integration` crashes if the local database environment is not pre-configured.

## 3. Playwright E2E Skips
*   The Playwright testing suite inside `examples/address-book` has an intentional desktop browser skip configured in its test suite that needs monitoring.
