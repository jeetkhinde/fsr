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

*   **`Live.list` cannot mark non-`<ul>/<li>` markup** — `applyLiveListMarkers` finds rows by
    scanning for `<li>` inside the nearest `<ul>`/`<ol>`
    (`packages/routekit/src/live-list-render.ts:90,131`). A div-based board or a table cannot be a
    live list at all. Independent of islands.

*   **`Live.list` inside an island receives nothing** — `_patchList` early-returns when the list is
    inside `[data-kiln-island]` (`packages/routekit/src/live-client-script.ts:63`) and, unlike the
    scalar path, never publishes to the Silcrow store. `LiveListOptions` also has no `target`
    option, so there is no opt-in either (`packages/live/src/list.ts`).

*   ~~**Actions cannot touch the response**~~ — **FIXED 2026-07-31** on `feat/action-response-api`.
    Actions now receive `(req, res)`; `KilnResponse.headers` is a `Headers` with a required
    `res.cookies`; `AppError.conflict()` covers 409. See ADR-019 and
    [bugs-resolved.md](bugs-resolved.md).

*   **An app that owns its entry point cannot use islands** — `kiln dev`/`kiln start` build their own
    `ElysiaAdapter` (`packages/cli/src/cli.ts:148,204`) and never load the app's entry.
    `apps/jags-list` still has no islands. A seam exists (`startKiln` accepts `islandsManifestUrl`,
    `boot.ts:39`) but is undocumented and unsupported.

    **The cause has changed, and the old framing is now wrong.** This entry used to say "an app
    needing cookies must own its entry" — that is no longer true, since login/logout are ordinary
    actions. What still forces jags-list onto a custom entry, verified in
    `apps/jags-list/src/main.ts` after the rewrite:
    1. `adapter.app.all('/api/auth/*', ...)` — better-auth's own catch-all handler, which is not a
       Kiln page and has nowhere else to mount;
    2. its hand-built `FsrStore`/`FsrWatcher`/`startDbNotificationPipeline` wiring and
       `registerAsset` call, which duplicate what the CLI's `initFsr` does.

    So closing this needs a way to register raw routes and assets from app code under `kiln dev` /
    `kiln start` — a smaller, better-defined problem than before, and no longer coupled to auth.

*   **Three warned-but-surprising combinations** (each a live `warnOnce`): `cacheKey` + live fields
    (updates skipped); `bake='user'` + `Live.list` (unsupported); `Live.list` in a dynamic-segment
    layout (all instances share one channel). None fails silently — each warns — so they rank below
    anything that does.

    A fourth, `bake='user'` + dynamic segment + live fields, is **FIXED 2026-07-31** on
    `fix/sse-user-scoping`; see [bugs-resolved.md](bugs-resolved.md). It was recorded here as "SSE
    scoped to the wrong user" and "the most severe — wrong-user data". **Both were wrong** — it
    delivered nothing rather than the wrong user's data. Corrected on the way out so the mistake
    isn't inherited.

*   **`.env` files are gitignored, so a fresh clone cannot run `test:integration`** — fails with
    `database "jagjeet" does not exist` until `test-app/.env` is copied in. Ship `.env.example`
    plus a preflight check.

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
*   ~~Dynamic-segment `bake='user'` + live fields falls back to shared-key SSE scoping~~ — **FIXED
    2026-07-31**: the SSE and snapshot endpoints now match the concrete path back to its registered
    pattern before reading bake mode. See [bugs-resolved.md](bugs-resolved.md) §0.
*   The dormant check costs one awaited Postgres SELECT per validated cache hit on routes with no
    local SSE-active mark. **Decision 2026-07-27: leave as-is** — correctness over a sub-ms indexed
    read; revisit only with profiling evidence.
