# Active Bugs, Blockers & Type Errors

Open **framework** issues only. Resolved history → [bugs-resolved.md](bugs-resolved.md). App-level bugs live under `apps/<app>/.memory/`, not here.

> **Last verified**: 2026-07-31 on `main` @ `347ad6d` — `bun run test:unit` 225 pass / 60 skip / 0 fail, `bun run test:integration` exit 0 (live Postgres + Redis), `bun run build` green across all packages, and a fresh `git clone` builds in a single pass. (Count moved 229 → 225 because `examples/address-book` was deleted and the ADR-011 guard added tests.)
>
> The six §1 defects found by the 2026-07-27 source audit are **all fixed** — see
> [bugs-resolved.md](bugs-resolved.md) §1. Nothing from that audit remains open here; the DX and
> maintainability items it raised alongside them are in [roadmap.md](roadmap.md) § Phase 5.

---

## 1. Open framework gaps (surveyed from source 2026-07-31)

Full prioritisation and rationale in [active-work.md](active-work.md) § Next Priorities. Recorded
here so they are tracked as defects rather than living only in a session transcript.

*   ~~**`Live.list` receives no auto-deps, and fails silently without `dependsOn`**~~ — **FIXED
    2026-07-31** on `fix/live-list-auto-deps`. A list now captures its own query's tables and
    unions them at registration; a list with no deps at all warns. See ADR-018's 2026-07-31
    amendment and [bugs-resolved.md](bugs-resolved.md).

*   ~~**`Live.list` cannot mark non-`<ul>/<li>` markup**~~ — **FIXED 2026-07-31** on
    `feat/live-list-any-markup`. Rows opt in with `data-kiln-row={key}` and the container is
    discovered from them; the `<li>` scan remains the fallback. See
    [bugs-resolved.md](bugs-resolved.md).

*   ~~**`Live.list` inside an island receives nothing**~~ — **FIXED 2026-07-31** on
    `fix/framework-dx`. `Live.list({ target: 'store' })` + `useLiveList()`; the client publishes
    every list patch to `live-list:<name>` before any DOM early-return. See
    [bugs-resolved.md](bugs-resolved.md).

*   ~~**Actions cannot touch the response**~~ — **FIXED 2026-07-31** on `feat/action-response-api`.
    Actions now receive `(req, res)`; `KilnResponse.headers` is a `Headers` with a required
    `res.cookies`; `AppError.conflict()` covers 409. See ADR-019 and
    [bugs-resolved.md](bugs-resolved.md).

*   ~~**An app that owns its entry point cannot use islands**~~ — **FIXED 2026-07-31** on
    `fix/framework-dx` (ADR-020). `config.server.setup({ adapter, config, mode })` runs in both
    `kiln dev` and `kiln start`, before pages are mounted, and `ServerAdapter.registerRaw` mounts a
    handler outside the page pipeline — so better-auth's `/api/auth/*` catch-all and `registerAsset`
    no longer cost an app the CLI (and with it islands and the FSR supervisors). See
    [bugs-resolved.md](bugs-resolved.md).

*   ~~**Three warned-but-surprising combinations**~~ — **CLOSED 2026-07-31** on
    `fix/framework-dx`. `Live.list` in a dynamic-segment layout is now **supported** (container
    stamp and registration both use `layoutInstancePath()`, so instances stop sharing a channel;
    warning removed). `cacheKey` + live fields and `bake='user'` + `Live.list` are **decided
    against** — both warnings now state the decision and the two ways out instead of reading as a
    TODO. They stay warnings rather than startup errors on purpose: neither is detectable before
    `load()` runs, and throwing at first render would turn a degraded page into a production 500.

    A fourth, `bake='user'` + dynamic segment + live fields, was **FIXED 2026-07-31** on
    `fix/sse-user-scoping`; see [bugs-resolved.md](bugs-resolved.md). It was recorded here as "SSE
    scoped to the wrong user" and "the most severe — wrong-user data". **Both were wrong** — it
    delivered nothing rather than the wrong user's data. Corrected on the way out so the mistake
    isn't inherited.

*   ~~**`.env` files are gitignored, so a fresh clone cannot run `test:integration`**~~ — **FIXED
    2026-07-31** on `fix/framework-dx`. `test-app/.env.example` plus `bun run preflight`
    (`scripts/preflight-env.ts`), wired as the first step of `test:integration`. See
    [bugs-resolved.md](bugs-resolved.md).

*   ~~**SIGTERM never terminated a server with an open SSE stream**~~ — **FIXED 2026-08-01** on
    `fix/sigterm-hangs-with-open-sse`. `ElysiaAdapter.listen`'s signal handler awaited
    `this.app.stop()` with no argument, which drains in-flight requests — and an SSE stream never
    drains, so `process.exit(0)` was unreachable. Measured against `apps/jags-list`: **10ms** to exit
    with no subscriber, **still alive after 10s** with one. Every Kiln app using a live field — the
    framework's headline feature — would have stalled its orchestrator's full termination grace
    period on every rolling deploy, then taken a SIGKILL that drops the other in-flight requests the
    polite drain was meant to protect. Now `stop(true)`. Regression test:
    `packages/adapter-elysia/src/shutdown.test.ts`. See [bugs-resolved.md](bugs-resolved.md) §0.

    **Found by accident, and that is the point.** Nobody was looking at shutdown; adding
    `await proc.exited` to the jags-list test teardown turned a silent production hang into a
    5s hook timeout in exactly one suite — the only one that leaves an SSE stream open.

*   **Nothing open in this section.** Every gap surveyed on 2026-07-31 is now closed; the sequence
    that ordered them is `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md`.

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

*   ~~DELETE-driven tombstoning is not owner-scoped (`notifyDelete` → `tombstoneDependentRoutes`);
    only INSERT/UPDATE are.~~ — **FIXED 2026-08-01** by PR #37 (`fix/known-defects`). `owner` is now
    threaded through to `FsrStore.tombstoneDependentRoutes` and `FsrListStore.deleteDependentRoutes`,
    both scoped `(user_key = '' OR user_key = ${owner})`. An owner-less payload still fans out
    route-wide, deliberately. This entry sat here for a day after the fix because PR #37's doc commit
    updated `decisions.md` and `bugs-resolved.md` only — see [bugs-resolved.md](bugs-resolved.md) §0.
*   ~~Auto-deps not exercised end-to-end through a page with live fields~~ — **CLOSED by PR #24**
    (Jag's List Plan 3a), and **strengthened by PR #32**.
    `apps/jags-list/pages/projects/[id]/activity.tsx` declares a `Live.list` with **no `dependsOn`
    at all** — PR #24 had it pinned to `'activity'`; PR #32 removed the pin so the page runs on
    auto-captured deps (`activity`, plus `user` via the join). `apps/jags-list/tests/live.integration.test.ts`
    drives the whole chain: real INSERT → `kiln_emit_event` trigger → LISTEN/NOTIFY → `FsrWatcher` →
    Redis → a subscribed SSE client. Regressing auto-deps now makes that suite fail on a 20s
    timeout, so the coverage has teeth against the mechanism itself, not just against a hand-written
    dep key.
*   ~~Dynamic-segment `bake='user'` + live fields falls back to shared-key SSE scoping~~ — **FIXED
    2026-07-31**: the SSE and snapshot endpoints now match the concrete path back to its registered
    pattern before reading bake mode. See [bugs-resolved.md](bugs-resolved.md) §0.
*   The dormant check costs one awaited Postgres SELECT per validated cache hit on routes with no
    local SSE-active mark. **Decision 2026-07-27: leave as-is** — correctness over a sub-ms indexed
    read; revisit only with profiling evidence.
