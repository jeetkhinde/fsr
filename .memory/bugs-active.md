# Active Bugs, Blockers & Type Errors

Open **framework** issues only. Resolved history → [bugs-resolved.md](bugs-resolved.md). App-level bugs live under `apps/<app>/.memory/`, not here.

> **Last verified**: 2026-07-29 on `worktree-kiln-framework-backlog` — `bun run test:unit` 229 pass / 60 skip / 0 fail, `bun run test:integration` exit 0 (live Postgres + Redis), `bun run build` green across all packages, and a fresh `git clone` builds in a single pass.
>
> The six §1 defects found by the 2026-07-27 source audit are **all fixed** — see
> [bugs-resolved.md](bugs-resolved.md) §1. Nothing from that audit remains open here; the DX and
> maintainability items it raised alongside them are in [roadmap.md](roadmap.md) § Phase 5.

---

## 2. Infrastructure & Integration Test Issues

*   ~~**Database Invalidation Integration Failures**~~ — **FIXED 2026-07-29**. Both
    `packages/engine/src/store.test.ts` and `list-store.test.ts` now skip with exit 0 and an
    actionable message instead of crashing. `store.test.ts` was the worse of the two: it always had
    a fallback connection string, so a missing `DATABASE_URL` never announced itself and surfaced
    later as an opaque `Connection closed`; it now probes with `SELECT 1` first. Note both are plain
    scripts, not `bun:test` suites, so the fix is warn-and-return rather than `describe.skipIf`.

*   ~~**Orphaned test file — runs in neither suite**~~ — **MOOT 2026-07-30**: fixed on 2026-07-29
    (adopted into `test:integration` with a both-tables schema guard, after confirming it was not
    stale — it passed 2/2 against a migrated address-book DB), then removed entirely when
    `examples/address-book` was deleted.

## 3. Playwright E2E Skips
*   ~~The Playwright suite inside `examples/address-book` has an intentional desktop browser skip~~ —
    **MOOT 2026-07-30**: deleted with the example. No Playwright suite remains in the repo.

---

## Carry-forward: known ADR-018 limitations (by design, not defects)

Recorded so they aren't re-filed as bugs. Full rationale in `.codebase-memory/adr.md` § ADR-018.

*   DELETE-driven tombstoning is not owner-scoped (`notifyDelete` → `tombstoneDependentRoutes`);
    only INSERT/UPDATE are.
*   ~~Auto-deps not exercised end-to-end through a page with live fields~~ — **CLOSED by PR #24**
    (Jag's List Plan 3a). `apps/jags-list/pages/projects/[id]/activity.tsx` declares a `Live.list`
    with `dependsOn: 'activity'`, and `apps/jags-list/tests/live.integration.test.ts` drives the
    whole chain: real INSERT → `kiln_emit_event` trigger → LISTEN/NOTIFY → `FsrWatcher` → Redis →
    a subscribed SSE client. Deleting the list's `dependsOn` makes that suite fail on a 20s
    timeout, so the coverage has teeth.
*   Dynamic-segment `bake='user'` + live fields falls back to shared-key SSE scoping (warned at
    runtime).
*   The dormant check costs one awaited Postgres SELECT per validated cache hit on routes with no
    local SSE-active mark. **Decision 2026-07-27: leave as-is** — correctness over a sub-ms indexed
    read; revisit only with profiling evidence.
