# Active Bugs, Blockers & Type Errors

Open **framework** issues only. Resolved history → [bugs-resolved.md](bugs-resolved.md). App-level bugs live under `apps/<app>/.memory/`, not here.

> **Last verified**: 2026-07-27 on `fix/emit-event-non-bigint-id` — `bun run test:unit` 208 pass / 51 skip / 0 fail, `bun run test:integration` exit 0 (live Postgres + Redis), `bun run build` green across all packages.
>
> The six §1 defects found by the 2026-07-27 source audit are **all fixed** — see
> [bugs-resolved.md](bugs-resolved.md) §1. Nothing from that audit remains open here; the DX and
> maintainability items it raised alongside them are in [roadmap.md](roadmap.md) § Phase 5.

---

## 2. Infrastructure & Integration Test Issues

*   **Database Invalidation Integration Failures**:
    *   **File**: `packages/engine/src/list-store.test.ts`
    *   **Description**: Integration database tests require a live PostgreSQL connection. If `DATABASE_URL` is not provided in the environment (or missing from `.env` in `test-app/`), tests crash.
    *   **Impact**: `bun run test:integration` crashes if the local database environment is not pre-configured.

*   **Orphaned test file — runs in neither suite** (found 2026-07-27):
    *   **File**: `examples/address-book/db/contacts.integration.test.ts`
    *   **Description**: excluded from `test:unit` via `--path-ignore-patterns`, but never named in
        `test:integration` (which lists its files explicitly). It executes in no suite.
    *   **Fix**: add it to `test:integration`, or delete it if it's superseded.

## 3. Playwright E2E Skips
*   The Playwright testing suite inside `examples/address-book` has an intentional desktop browser skip configured in its test suite that needs monitoring.

---

## Carry-forward: known ADR-018 limitations (by design, not defects)

Recorded so they aren't re-filed as bugs. Full rationale in `.codebase-memory/adr.md` § ADR-018.

*   DELETE-driven tombstoning is not owner-scoped (`notifyDelete` → `tombstoneDependentRoutes`);
    only INSERT/UPDATE are.
*   Auto-deps is proven at the capture/trigger/watcher layer but **not exercised end-to-end**
    through a page with live fields in any app — `jags-list` still has zero `Live.value`/`Live.list`
    usage. This remains the highest-value test gap: two of the six defects fixed on 2026-07-27
    (the BIGINT id cast and the depKey folding mismatch) would have surfaced immediately from one
    real live-field page.
*   Dynamic-segment `bake='user'` + live fields falls back to shared-key SSE scoping (warned at
    runtime).
*   The dormant check costs one awaited Postgres SELECT per validated cache hit on routes with no
    local SSE-active mark. **Decision 2026-07-27: leave as-is** — correctness over a sub-ms indexed
    read; revisit only with profiling evidence.
