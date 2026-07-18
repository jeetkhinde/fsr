# Active Bugs, Blockers & Type Errors

Open **framework** issues only. Resolved history → [bugs-resolved.md](bugs-resolved.md). App-level bugs live under `apps/<app>/.memory/`, not here.

> **Last verified**: 2026-07-12 — `tsc --noEmit` clean across every package (`core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`, `cli`, `create-kiln`, `client`); unit suite 149 pass / 0 fail.


## 2. Infrastructure & Integration Test Issues

*   **Database Invalidation Integration Failures**:
    *   **File**: `packages/engine/src/list-store.test.ts`
    *   **Description**: Integration database tests require a live PostgreSQL connection. If `DATABASE_URL` is not provided in the environment (or missing from `.env` in `test-app/`), tests crash.
    *   **Impact**: `bun run test:integration` crashes if the local database environment is not pre-configured.

## 3. Playwright E2E Skips
*   The Playwright testing suite inside `examples/address-book` has an intentional desktop browser skip configured in its test suite that needs monitoring.
