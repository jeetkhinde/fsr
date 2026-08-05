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

*   ~~**Crash/disconnect event catch-up had never worked**~~ — **FIXED 2026-08-01** on
    `fix/event-catch-up-never-replayed`, but **defect (a) as recorded was wrong — corrected
    2026-08-04.**

    (a) was filed as: `fetchEventsSince` returned the jsonb `payload` untouched, bun's SQL hands
    jsonb back as a **string**, so `const { depKey } = event.payload` was always `undefined`.
    **Measured against bun 1.3.14: it does not.** A jsonb object comes back as a JS object and a
    jsonb array as a JS array. What comes back as a string is a value *stored* through
    `${JSON.stringify(x)}::jsonb`, which binds the JS string as a jsonb **string**
    (`jsonb_typeof` = `string`) — double-encoded going in, decoded faithfully coming out. Every
    payload `kiln_emit_event` writes uses `jsonb_build_object`, so production events were objects
    and destructured correctly all along. The strings were the *test suite's own fixtures*.
    `decodeEventPayload` is kept as normalization (it does cover double-encoded rows and other
    drivers) but it fixed nothing on the production path.

    (b) **was real**: catch-up was private and called only from `FsrWatcher.start()`, so a LISTEN
    reconnect logged "reconnected to Postgres" and replayed nothing. That is what made missed events
    unrecoverable across a reconnect, and `catch-up.test.ts` case 3 covers it.

    **The lesson is the one already in this file, applied to us:** a test that constructs its own
    fixture can measure the fixture instead of the system. The suite inserted double-encoded
    payloads no trigger ever produces, then concluded the driver was at fault. It now emits through
    `jsonb_build_object`, matching `kiln_emit_event`, with the double-encoded shape kept as an
    explicit separate case. See [bugs-resolved.md](bugs-resolved.md) §0.

*   ~~**The catch-up cursor lived on local disk while its events lived in shared Postgres**~~ —
    **FIXED 2026-08-04** on `fix/event-cursor-in-postgres`. A container with no persistent cache dir
    found no cursor on every restart, took the adopt-current-head branch and dropped the whole
    restart-sized gap; catch-up therefore recovered restarts only on a machine that kept its own
    disk, i.e. in development. The cursor is now one shared `kiln_fsr_cursor` row, advanced with
    `GREATEST` and read as the greatest of {in-memory mark, row, legacy file (one-release shim)}.
    Shared rather than per-instance because replay writes only to the shared `kiln_fsr` tables — see
    ADR-022. Regression test: `packages/engine/src/catch-up.test.ts` case 2, which now uses a
    *different* temp dir for the replacement instance and fails on the old code with
    "a replacement instance with no local cursor file did not replay the restart gap".

    **The known limitation was the bug.** It sat in this file for three days as a design note
    ("moving the cursor into Postgres is the real fix") rather than a defect, which understated it:
    the recovery path it degraded was already the one nobody exercises.

*   ~~**The LISTEN client's `once('error')` missed pg's second error event**~~ — **FIXED 2026-08-04**
    on `fix/minor-recovery-findings`. pg emits two `error` events when a backend is terminated under
    an in-flight query (the query's, then "Connection terminated unexpectedly"); `once` had already
    detached, so the second reached an emitter with no listener. Bun printed a stack from inside
    pg's `client.js` and survived (measured exit 0) — on Node the same path throws. Now a permanent
    listener plus a latch, so nothing is unhandled *and* exactly one reconnect is scheduled per
    client (a plain `on` would have doubled the clients on every drop). Unit test:
    `packages/engine/src/db-notify-error.test.ts`, all three cases fail with `once`.

*   ~~**`reExecuteQuery` drops params when `queryParams` is a jsonb string**~~ — **DOES NOT
    REPRODUCE, closed 2026-08-04.** Same false premise as (a) above: `upsertSlot([2])` stores a real
    jsonb array and `fetchStaleSlots` returns a real JS array, so `Array.isArray` is true and the
    requery binds its parameters. Verified by falsification in the opposite direction — the proposed
    decode was added, then removed, and the test passed identically both times, so it was not
    committed. The end-to-end round trip is now covered as a characterization test in
    `store.test.ts` (`reExecuteQuery` with parameters), which had no coverage at all before because
    the only production caller passes a null query.

*   ~~**A page whose live fields are scalars never served its baked artifact**~~ — **FIXED
    2026-08-05** on `feat/jags-list-cli-migration`. `FsrWatcher.hasRegisteredRoute` scanned
    `liveListTargets` only, but scalar `LiveProp`s register through `registerLoader` into
    `loaderTargets`. So a page with live fields and no `Live.list` never reported as registered, and
    `page-render.ts`'s "serve the artifact only if the watcher already holds this route's closures"
    check fell through to a **full re-render on every request, forever** — the artifact was baked
    and then ignored. That code's own comment claims the check "short-circuits every later request";
    for these pages it never did.

    **Scope is the headline feature.** `target: 'store'` is the only supported way to get live data
    into an island (ADR-014), and such a field is always a scalar `LiveProp` — so *every* island-fed
    page was uncached. Reproduced on `test-app`'s own `/islands-demo`, whose `bakedAt` timestamp
    changed on four of four requests before the fix and is frozen across them after.

    The fix matches loaders by exact `(route, userKey)`, not route alone: `bake='user'` routes
    register one loader per user, and a route-level match would let user A's registration vouch for
    user B — serving B a cached artifact while never registering B's loader to revalidate it. Unit
    test: `packages/engine/src/has-registered-route.test.ts` (3 of 5 cases fail on the old code).

    **Found by dogfooding, not by audit.** It surfaced only because a jags-list test asserted two
    requests return the identical artifact, and dnd-kit's per-render `aria-describedby` counter made
    the re-render visible. Nothing in the framework's own suites noticed, because none of them
    assert that a second request *doesn't* re-render.

*   ~~**`kiln build` fed every page module to Vite as a browser entry**~~ — **FIXED 2026-08-05** on
    `feat/jags-list-cli-migration`. `findClientEntries` globbed all `.ts`/`.tsx` under `pagesDir`
    into rollup's `input`. Kiln has no page-level hydration (ADR-014) and the runtime resolves island
    names through `/_kiln/islands.json` with no notion of a page bundle, so those chunks were
    unreachable dead output — and any page reaching a server-only import failed the build outright.
    jags-list hit it on its first `kiln build`: *"AsyncLocalStorage is not exported by
    `__vite-browser-external`, imported by `packages/core/dist/sql.js`"*. `kiln build` therefore
    worked only for apps whose pages import nothing server-side, which `test-app` happens to satisfy
    and no real app does. `kilnIslandsPlugin` already appends one virtual entry per island in its own
    `config()` hook, so the glob was redundant even when it worked. Entry resolution now lives in
    `packages/cli/src/client-build.ts`, which passes no explicit `input`. Regression test builds a
    fixture app whose page imports `node:async_hooks`.

*   **Nothing else open in this section.** Every gap surveyed on 2026-07-31 is closed; the sequence
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
*   ~~The catch-up cursor is per-container while the events are shared, so a restart-sized gap is
    unrecoverable without a persistent cache dir.~~ — **FIXED 2026-08-04**, see § 1 above and
    ADR-022.
*   ~~`kiln_fsr_events` is never pruned.~~ — **FIXED 2026-08-04** on `fix/prune-event-log`.
    `FsrStore.pruneAppliedEvents(retentionSecs)` deletes rows at or below `MIN(event_id)` across
    every `kiln_fsr_cursor` row and older than `fsr.eventRetentionSecs` (default 86400), driven from
    the existing `purgeSweepSeconds` sweep. An empty cursor table deletes nothing, by SQL's null
    semantics, and a test pins that. See ADR-022's amended consequence.

    Worth noting what the first test run measured: on this machine's test database the sweep found
    **69** applied events accumulated by previous suites — the table had been growing since the
    events mechanism landed, exactly as the entry predicted.
*   The dormant check costs one awaited Postgres SELECT per validated cache hit on routes with no
    local SSE-active mark. **Decision 2026-07-27: leave as-is** — correctness over a sub-ms indexed
    read; revisit only with profiling evidence.

*   **`apps/jags-list` `test:freshness` is flaky at roughly 1 run in 3** — the owner-scoped
    notifications case fails on a 5s deadline. **Pre-existing, not branch-related**: measured
    2026-08-05 at 1/3 failures on `feat/jags-list-cli-migration` AND 1/3 on `main` with the same
    command, so it is characterised rather than fixed here. Likely the same timing sensitivity as
    roadmap Phase 6 item 7 (fleet-shared event cursor), but that is a hypothesis — it has not been
    traced. Do not read a red `test:freshness` as a regression without re-running it.
