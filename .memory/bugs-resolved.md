# Resolved Bugs & Blockers (Archive)

Historical record of fixed framework bugs, kept out of the active file to keep session reads cheap. Active/open issues live in [bugs-active.md](bugs-active.md).

> **Last full verification**: 2026-07-12 (Gemini-audit round 2). `tsc --noEmit` clean across every package; unit suite 149 pass / 0 fail.

## 0. Fixed 2026-08-01

### `fix/event-catch-up-never-replayed` — the recovery path recovered nothing

Found by auditing for more bugs of the `fix/sigterm-hangs-with-open-sse` class
(paths that only run after something else has already failed). Filed as two
defects compounding into "missed events are recovered **never**" — **one of the
two was not real**, see the retraction below. The accurate statement is that a
LISTEN reconnect recovered nothing; a restart with a readable cursor file did
replay correctly.

*   ~~**`catchUpMissedEvents` had never invalidated anything.**~~ — **THIS DEFECT
    WAS NOT REAL. Retracted 2026-08-04.**

    It was recorded as: `fetchEventsSince` returned the jsonb `payload` column
    untouched, bun's SQL hands jsonb back as a **string**, so
    `const { depKey, id } = event.payload` destructured a string and skipped
    every branch while the cursor advanced past it.

    **Measured against bun 1.3.14, the premise is false.** A jsonb object comes
    back as a JS object; a jsonb array as a JS array. What comes back as a
    string is a value that was *stored* through `${JSON.stringify(x)}::jsonb`,
    which binds the JS string as a jsonb **string** — `jsonb_typeof` returns
    `string`, not `object`. Double-encoded going in, decoded faithfully coming
    out. `kiln_emit_event` builds every payload with `jsonb_build_object`, so
    production events were objects and destructured correctly all along.

    **The "proof before the fix" proved the fixture.** The pending event it used
    was inserted by the test as `${JSON.stringify({depKey})}::jsonb` — a shape
    no trigger produces. The suite emits through `jsonb_build_object` now, the
    double-encoded shape is kept as its own explicit case, and
    `decodeEventPayload` stays as normalization for that case and for other
    drivers — but it is no longer described as fixing anything.

    Verification for the retraction: a real trigger fired on a probe table, its
    row read back — `jsonb_typeof` = `object`, JS `typeof` = `object`,
    `const { depKey } = payload` yields the dep key.

*   **A LISTEN reconnect replayed nothing.** `catchUpMissedEvents` was private
    and called from exactly one place, `FsrWatcher.start()`. A mid-life drop
    (PG restart, failover, network blip) re-subscribed, logged the reassuring
    `FSR DB listener: reconnected to Postgres`, and dropped the entire gap.
    Now public and called from `startDbNotificationPipeline` after `LISTEN` is
    established — on the first connect as well as reconnects, since callers
    start the watcher *before* the pipeline (`main.ts` does) and events in
    between fell through that seam too. After LISTEN, never before: events
    arriving during the replay then also arrive as notifications, and a double
    invalidation is a no-op, whereas the reverse order leaves a real gap.

**A hazard the fix itself created, and the guard for it.** `kiln_fsr_events` is
never pruned, and nothing creates the watcher's `cacheDir`, so a failed cursor
write meant the next boot replayed from id 0. That was harmless only while
catch-up was a no-op; once it worked it became a full-history invalidation
stampede on every cold start. Guarded three ways: `persistCursor` now `mkdir`s
first; the cursor is held **in memory** as well as on disk, so a reconnect
replays the right window even where the file cannot be written; and a boot with
no cursor anywhere adopts the current `MAX(id)` and replays nothing, since no
cursor means no known prior state and therefore no gap to close.

**Known limitation, unchanged by this fix:** the cursor lives on local disk
while the events live in shared Postgres, so a container without a persistent
cache dir takes the adopt-head branch on every restart and cannot recover a
restart-sized gap. Reconnect gaps are still covered (in-memory cursor). Moving
the cursor into Postgres is the real fix and was out of scope here.

**Deliberately NOT changed:** catch-up stays route-wide rather than
owner-scoped. The payload *does* carry `owner` when the trigger names an owner
column, and the old comment claiming otherwise ("the events table doesn't yet
persist `owner` in a queryable column") was simply wrong and is corrected — but
catch-up runs precisely when state is uncertain, and over-invalidating costs a
re-render while under-invalidating serves stale data. Narrowing it needs a test
that fails when the owner is wrong.

Regression test: `packages/engine/src/catch-up.test.ts`, wired into
`test:integration`. Falsified per-defect — reverting the decode fails on the
payload assertion; reverting the reconnect call fails on the reconnect
assertion; reverting the cold-start guard trips the restart test's precondition
(the stampede invalidates the slot early), which is a coarser signal than test
4's own assertion but still a hard failure.

### `fix/sigterm-hangs-with-open-sse` — the framework never shut down cleanly

*   **SIGTERM did not terminate a server with an open SSE stream.**
    `ElysiaAdapter.listen` (`packages/adapter-elysia/src/adapter.ts`) registered
    `process.once('SIGTERM', shutdown)` where `shutdown` awaited
    `this.app.stop()` — no argument, so Bun waits for in-flight requests to
    drain. An SSE stream never drains, so `process.exit(0)` was never reached.

    Measured against `apps/jags-list` (real server, authenticated subscriber on
    `/__kiln/fsr`): **10ms** SIGTERM→exit with no subscriber, **still alive
    after 10,000ms** with one. Not slow — unbounded.

    Blast radius is every Kiln app that uses a live field, i.e. the feature the
    framework exists for. Under Docker/k8s the container ignores SIGTERM for the
    whole termination grace period (30s by default) and is then SIGKILLed —
    which drops the other in-flight requests that waiting politely was supposed
    to protect. So the polite `stop()` achieved the opposite of its intent.

    Fixed with `await this.app.stop(true)` (Elysia 1.4.28: close active
    connections). SSE clients reconnect by design, so closing them is the
    correct trade. Note `packages/cli/src/cli.ts`'s `registerShutdown` was
    always fine — it never awaited `app.stop()` — so apps started by the Kiln
    CLI could win the race, while apps owning their entry point via ADR-020's
    `config.server.setup` (jags-list) got only the adapter handler and hung
    deterministically.

    Regression test: `packages/adapter-elysia/src/shutdown.test.ts`, wired into
    `test:integration`. Out-of-process by necessity (the code under test calls
    `process.exit`), needs no Postgres or Redis, and falsified — restoring
    `stop()` makes it fail with the diagnosis in the message.

    **How it surfaced is worth keeping.** It was not found by looking at
    shutdown. `apps/jags-list`'s six server-spawning suites called `proc.kill()`
    without awaiting `proc.exited`; adding the await (to close an intermittent
    port-rebind failure — measured: rebinding immediately after `kill()` fails
    ~2 times in 3) converted a silent production hang into a hard 5s hook
    timeout in exactly one suite: `live.integration.test.ts`, the only one whose
    helper leaves an SSE reader open. A test-hygiene fix was the detector.

### `fix/known-defects` — the two limitations that outlived the bug ledger

Both were recorded as "known limitations / future work" in
[decisions.md](decisions.md), not in `bugs-active.md`, so both survived a
question phrased as "what's open?". Neither was hard once traced; they were
frozen by an earlier plan's scope, not by difficulty.

*   **DELETE-driven tombstoning was not owner-scoped** — `notifyDelete` already
    *accepted* an `owner` and dropped it on the floor
    (`watcher.ts`, with a NOTE saying deletes were out of scope), so
    `tombstoneDependentRoutes(depKey)` tombstoned every `user_key` matching the
    dep key. One user deleting one row therefore tombstoned the route for
    **every** user: their artifacts unlinked, a full re-render each, over data
    none of them owned. INSERT/UPDATE had been owner-scoped since ADR-018.

    Fixed by threading `owner` through to `FsrStore.tombstoneDependentRoutes`
    and `FsrListStore.deleteDependentRoutes`, both scoped
    `(user_key = '' OR user_key = ${owner})` — the same two-branch shape
    `invalidateDepKey` already used, so there is one idiom rather than two. The
    artifact unlinks ride the `RETURNING` rows, so scoping the `WHERE` scoped
    them automatically. An owner-less payload (a trigger that emits none) still
    fans out route-wide, deliberately unchanged. `InspectRow` gained
    `tombstoned` so the fan-out is assertable without raw SQL.

*   **Auto-deps could not see queries through any handle bun hands out** —
    `sql.begin(async tx => ...)`, `tx.savepoint(...)`, `sql.unsafe('...')` and
    `await sql.reserve()`. The capture Proxy wrapped only the client itself, so
    a query run through one of those went to bun's own object: no table
    recorded, and — worse — no warning, because from the wrapper's point of view
    no query happened at all. Silent under-capture is the one failure direction
    that serves stale data with nothing logged anywhere.

    Fixed by splitting the wrapper into a reusable `wrapCapturing(base)` and
    applying it to what each member yields: `.begin`/`.transaction`/`.savepoint`
    substitute a wrapped handle into the callback (recursively, so a savepoint
    inside a transaction captures too), `.unsafe` parses the string argument it
    was already given, and `.reserve()` wraps its resolved connection.
    Transactions still roll back — the integration suite asserts that
    explicitly, since a bug in the substitution could break atomicity while
    every capture assertion still passed.

    **Still under-captures, by construction:** a dynamically-interpolated table
    name (``sql`SELECT * FROM ${sql(name)}` ``) reaches the template as a bound
    `?`, leaving nothing to parse. That case warns once per query shape and
    needs an explicit `dependsOn`.

Falsified both ways: reverting `sql.ts` fails the `begin()` capture assertion;
neutering only the owner argument in `tombstoneDependentRoutes` fails exactly
"another user's row must survive a DELETE they did not make".

---

## 0. Fixed 2026-07-31

### `fix/framework-dx` — items 0 and 3-7 of the fix-sequencing doc

*   **A fresh clone or worktree could not run `test:integration`** — `test-app/.env` is gitignored
    and `bun --env-file=` ignores a missing file *without complaining*, so the suites ran with no
    `DATABASE_URL` and failed with an opaque `database "<unix-user>" does not exist`. Cost time on
    2026-07-30 and twice on 2026-07-31. Fixed with `test-app/.env.example` (which `store.test.ts`
    already referenced, and which did not exist) and `scripts/preflight-env.ts`, wired as the first
    step of `test:integration`. It hard-fails on a missing file/key with the exact `cp` to run;
    unreachable Postgres/Redis is only a warning, since the suites already probe and skip and
    `bun run test` must not require live services.

*   **Layout scalar live fields were never registered at all** — filed as "layout `load()` is never
    wrapped in `withDepCapture`, so layout scalar live fields get no auto-deps". Wider than that:
    `extractLiveFields` only ever ran over the *page's* props, so a layout's `Live.value` got an
    `s-live` slot in the HTML — and the browser client, which scans `[s-live]` and subscribes with
    `window.location.pathname`, dutifully subscribed to it — while the server wrote no slot row and
    registered no loader. Capturing deps alone would have been a no-op.

    Fixed by registering layout live fields under the page's concrete route alongside the page's
    own (page wins on a name collision, matching how props merge), wrapping each layout's `load()`
    in its own `withDepCapture` so auto-deps stay per segment, re-running only the layouts that
    contributed a live field in the watcher loader, and carrying store-target layout fields in
    `data-kiln-live-store`. Two follow-ons found by tracing the real client:
    - **The cached-shell fast path** returned early for a page whose only live fields live in a
      layout, so the first request after a restart (cache warm, watcher registry empty) left the
      field dead for the process. It now falls through when the shell carries `s-live` slots the
      page's own `load()` does not produce — pure string work on HTML already in hand.
    - **silcrow opens one connection per `[data-kiln-live]` element** and discovers slots only
      inside that element's subtree. Layouts *contain* the page wrapper, so a layout's `s-live` span
      was outside the only container on the page. The outermost layout now carries the attribute
      (route: the page's concrete path) when a layout has a dom-target field.

*   **`Live.list` inside an island received nothing, and had no `target`** — `_patchList`
    early-returned for any list inside `[data-kiln-island]` and, unlike the scalar path, never
    published to the store. Fixed with `Live.list({ target: 'dom' | 'store' | 'dom-and-store' })`
    (same vocabulary as `Live.value`): a store-delivered list is deliberately left unmarked and
    declares itself in `data-kiln-list-store` + `data-kiln-live-lists` so the SSE subscription still
    covers it, and the client publishes each patch to `live-list:<name>` **before** any DOM
    early-return. Patches are published rather than reduced client-side because reducing needs the
    list's `key(row)`, which lives in `load()` and cannot be serialized — `useLiveList(name, { key,
    initial })` in `@kiln/react` reduces with the app's own accessor, seeded from
    `window.__kiln_seed`, replaying a bounded log so a patch landing before hydration is not lost.
    `applyListPatchToRows` was extracted in `@kiln/live` and made idempotent for a re-delivered
    insert, which log replay needs. A dom-target `Live.list` inside an island now warns at bake
    time, as a dom-target `LiveProp` already did.

*   **An app owning its entry point could not use islands** (ADR-020) — `adapter.app.all(...)` was
    reachable only from app code, so one non-page endpoint (better-auth's `/api/auth/*`) forced a
    hand-built entry, which also meant no islands and a hand-rolled `FsrWatcher` duplicating
    `initFsr`. Fixed with `config.server.setup({ adapter, config, mode })`, called by both `dev` and
    `start` after the FSR runtime is up and before pages are mounted, plus
    `ServerAdapter.registerRaw(pattern, handler, { method })` — outside the page pipeline by design
    (no `KilnRequest`, no `handle` hook, no timeout: a sign-in endpoint must be reachable without a
    session). `defineConfig` takes `KilnUserConfig` because `DeepPartial` would strip `setup`'s
    callability; a non-function `setup` fails `validateConfig` and a throwing one aborts the boot.

*   **`Live.list` in a dynamic-segment layout shared one channel across instances** — the container
    stamp and the registration both used the bare pattern, and the hub matches patches by exact
    route, so a row inserted for project 7 patched project 9. Both now use `layoutInstancePath()`
    (`/projects/7`). The layout's baked HTML is already cached per instance, so the stamped route
    and the cache entry cannot disagree. A static pattern is its own instance path, so its
    registration count is unchanged.

*   **`fsr.watcher: 'external'` was a trap** (ADR-021) — typed for two releases with no watcher
    process, IPC channel or daemon behind it; its only effects were a read-path branch that re-ran
    `load()` on every cache hit and a `Live.list` guard. Setting it silently forfeited the caching
    live routes exist for. Removed: the union is `'embedded'` only, `validateConfig` rejects
    `'external'` by name, and both dead branches are deleted.

*   **Decided, not fixed** — `cacheKey` + live fields and `bake='user'` + `Live.list` stay
    unsupported. Their warnings now state the decision and the two ways out. They remain warnings
    rather than startup errors because neither is detectable before `load()` runs, and throwing at
    first render would turn a degraded page into a production 500.


### `feat/live-list-any-markup`

*   **`Live.list` could only mark `<li>` rows inside `<ul>`/`<ol>`** — `findMatchingRow` scanned for
    the next `<li>` whose HTML contained every one of the row's text values, and `markList` marked
    the nearest enclosing `<ul>`/`<ol>`. A div board or a table could not be a live list at all.

    Fixed by an opt-in marker: the app puts `data-kiln-row={key}` on each row element (value must
    equal `key(row)`), and the server adds the `data-kiln-key` the client already queries, then
    marks the rows' **enclosing** element via a new tag-agnostic `findEnclosingOpenTag`. Markers are
    all-or-nothing per list; with none present the `<li>` scan runs unchanged, so nothing that
    worked before changed. A `data-kiln-row` matching no row warns once.

    **Why a `rowTag` config option was rejected:** rows were located by content matching, and in a
    div board the first element containing a row's text is the outer *wrapper*, not the row — so
    configuring the tag would have marked the wrong element. Explicit markers remove the guess.

    **A second defect found while fixing this:** `_patchList` built new rows with
    `document.createElement('div')` + `innerHTML`, and a `<tr>` parsed inside a `<div>` is discarded
    by the HTML parser. A table-backed list would therefore render correctly and then silently never
    insert or replace a row. Both the `insert` and `replace-row` branches now use `<template>`, which
    parses table-context fragments correctly.

    The client needed no other change — it already queried `[data-kiln-list]` / `[data-kiln-key]`
    and inserted `firstElementChild`, whatever tag that is.

    Verification: unit 239 pass / 60 skip / 0 fail, `bun run build` exit 0.

### `fix/sse-user-scoping`

*   **Live updates never reached subscribers on dynamic `bake='user'` routes** — `bakeByPattern` is
    keyed by route pattern (`packages/routekit/src/boot.ts`, the discovery loop), but the SSE and
    snapshot endpoints looked it up with the concrete path the client subscribes with (the live
    client sends `window.location.pathname`). For a dynamic route the lookup missed, so `routeBake`
    was `undefined`, the `=== 'user'` guard failed, and the user key fell back to `''` — the shared
    key.

    Fixed by matching the concrete path back to its registered pattern first
    (`packages/routekit/src/match-pattern.ts`, `createPatternMatcher`) and routing both endpoints
    through one `resolveRouteUserKey` helper instead of duplicating the logic. `identity(req)`
    remains the only source of the user key; the matched pattern selects a bake mode and nothing
    else, so no client-supplied value influences whose data is read. An unmatched route warns once
    and stays shared, rather than failing the subscription — a stale client during a rolling deploy
    is the common cause.

    **Severity was mis-recorded and is corrected here.** `bugs-active.md` called this "SSE scoped to
    the wrong user" and "the most severe — wrong-user data". It was neither.
    `packages/routekit/src/page-render.ts` sets `userKey = uid ?? ''` regardless of dynamic
    segments, so an authenticated render always writes under its own uid and can never populate the
    shared row; `packages/engine/src/hub.ts` then filters patches by exact `userKey` match. A
    subscriber holding `''` matched **nothing**. The initial snapshot read the shared row — absent,
    or holding the anonymous (least-privileged) view. A silent correctness defect, not a privacy
    breach.

    Also deleted the `page-render.ts` warning telling authors this combination was broken, and
    rewrote the `boot.test.ts` case that asserted it — both described a limitation that no longer
    exists.

    Falsification: `resolveRouteUserKey` returns the subscriber's uid for a dynamic `bake='user'`
    pattern. Confirmed the test has teeth by temporarily restoring the raw-path lookup — the
    dynamic-route case fails (`'' !== 'u1'`) while the static and shared cases still pass.
    Verification: unit 244 pass / 60 skip / 0 fail, `test:integration` exit 0, `bun run build`
    exit 0.

### `fix/live-list-auto-deps`

*   **`Live.list` received no auto-deps** — `registerLiveLists` passed `meta.dependsOn` straight
    through while scalar `LiveProp` unioned the request's observed tables, so omitting `dependsOn`
    degraded a list with nothing logged.

    Fixed by capturing each list's **own** query in its own `withDepCapture` scope inside
    `materializeLiveLists`; the tables ride on `LiveListMeta.autoDeps` and are unioned by
    `resolveListDeps` at registration, gated on `fsr.autoDeps` as the scalar path is. A list left
    with no deps at all now emits a `warnOnce`.

    **Correction to the original report:** it claimed a dep-less list "never updates". That is true
    only with `revalidate: false` (persisted as `revalidate_secs = 0`). Otherwise `fetchStaleLists`
    still refreshes it via `COALESCE(revalidate_secs, 300) > 0`, so it degrades to ~300s polling
    rather than dying. Real bug either way; the severity claim was wrong.

    **Why per-list capture rather than reusing the page's `observedTables`:** `initial` is optional
    and the page's capture wraps only `load()`, so a list omitting `initial` would have captured
    nothing — preserving the exact silent-failure case being fixed.

    **Proven by falsification, in both directions.** The explicit `dependsOn: 'activity'` was
    deleted from `apps/jags-list/pages/projects/[id]/activity.tsx` and `bun run test:live` passes.
    With `live-registration.ts` and `page-render.ts` reverted to `main` and routekit rebuilt
    (confirmed via `grep -c withDepCapture packages/routekit/dist/live-registration.js` → 0), the
    same suite fails at 20044ms — so the test genuinely detects the regression rather than merely
    passing. Resolved deps logged as `["activity", "user"]`: the needed key plus a harmless
    over-capture from the `LEFT JOIN "user"`.

    Verification at the time: unit 244 pass / 60 skip / 0 fail, `test:integration` exit 0,
    `bun run build` exit 0, all seven jags-list suites green individually (24 pass / 0 fail).
### `feat/action-response-api`

*   **Actions could not touch the response** — invoked as `actions[actionName](req)`
    (`packages/routekit/src/boot.ts`), so an action could set no cookies, no headers and no custom
    status. This forced jags-list's login/logout onto raw Elysia routes and made 409 unreachable.

    Fixed by passing `res` through as a second argument (`KilnAction` in
    `packages/core/src/types.ts`), with precedence reusing the rule `KilnHandle` already documented:
    a committed body wins over the return value, and doing both warns rather than silently
    discarding.

    **A constraint the original gap survey missed:** `KilnResponse.headers` was
    `Record<string, string>`, which cannot carry multiple `Set-Cookie` values — so passing `res`
    alone would not have fixed the driving case. `headers` is now a web `Headers` (matching
    `KilnRequest.headers`), with a required `res.cookies` façade whose `path` defaults to `/`. The
    Elysia adapter keeps `ctx.set.headers` a plain record and passes `set-cookie` as a `string[]`;
    assigning a `Headers` instance there was rejected because the record-style writes in
    `context.ts`/`middleware/compression.ts` would have been dropped with no error of any kind.

    `AppError.conflict()` (409) added for code too deep in a call stack to reach `res`.

    **Proven by falsification:** the raw `/auth/login` and `/auth/logout` routes were deleted from
    `apps/jags-list/src/main.ts` and reimplemented as actions;
    `apps/jags-list/tests/app.integration.test.ts` passes 6/6 with its assertions unchanged (only
    URLs moved). Full framework verification at the time: unit 248 pass / 60 skip / 0 fail,
    `test:integration` exit 0, `bun run build` exit 0, and all seven jags-list suites green
    individually (24 pass / 0 fail). See ADR-019.

## 1. Fixed in the 2026-07-27 source audit (branch `fix/emit-event-non-bigint-id`)

Self-audit of the framework at `758eb44`, all six findings verified against source before fixing
and each fixed test-first. One hypothesis raised during the audit (that `DeepPartial` silently made
required config fields optional) was **disproved** by a `tsc` probe and never filed.

*   **`kiln_emit_event` broke writes on any table without a bigint-castable `id` (HIGH)** — the
    function declared `record_id BIGINT` and assigned `NEW.id`/`OLD.id` directly. As an
    `AFTER … FOR EACH ROW` trigger, anything raised inside it aborts the **application's** write,
    not just the invalidation: a uuid PK failed the cast (`invalid input syntax for type bigint`)
    and a table with no `id` raised `record "new" has no field "id"`. Both verified against live
    Postgres. `sync-triggers` installed it with no preconditions checked, so ordinary schemas (uuid
    PKs, composite-key join tables) broke at the first write. Now TEXT read via
    `to_jsonb(NEW) ->> 'id'`: missing keys yield NULL instead of raising, and no cast is attempted.
    A null id costs only row-level targeting — consumers already guard `id !== null` before building
    `depKey:id`, and the table-level depKey still invalidates. Applied via `CREATE OR REPLACE`, so
    existing deployments upgrade on next boot with no migration.
    (`packages/engine/src/schema.ts`, `packages/engine/src/emit-event.test.ts`)

*   **Auto-deps folded table names, `sync-triggers` didn't — silent under-invalidation** — Postgres
    stores unquoted `CREATE TABLE SyncTrigMixed` as `synctrigmixed` and `extractTables` lowercases
    what it captures, but the config string was used verbatim. A mixed-case `table` therefore emitted
    a depKey no captured dep could ever equal (`invalidateDepKey` matches with `= ANY(depends_on)`),
    so writes invalidated nothing with no error anywhere; separately the existence probe compared the
    verbatim trigger name against the folded one Postgres stored, so it never matched and every run
    re-CREATEd. The table name is now folded once for the probe, the DDL target, and the default
    depKey. An **explicit** depKey stays verbatim — it is an arbitrary key matched against
    hand-written `dependsOn` lists, not an identifier. (`packages/cli/src/sync-triggers.ts`)

*   **SSE admission leaked a slot per ungraceful shutdown** — cross-process admission was a bare
    `INCR` whose `DECR` lived only in the stream's `finally`. A counter can only be corrected by the
    process that incremented it, so a SIGKILL/OOM/crash stranded its increments permanently; the
    count drifted up across restarts and, once past `maxConnections`, refused **every** new
    subscription app-wide, with no TTL or reconciliation — recoverable only by deleting the Redis key
    by hand. Connections are now members of a sorted set scored by last heartbeat, so anything that
    stops heartbeating is pruned by the next admission. The heartbeat runs on its own interval rather
    than riding `resetKeepalive`, which restarts on every patch and so could leave a *busy*
    connection looking like an orphan. The key carries a refreshed TTL backstop and changed name with
    its type (`…:fsr:connections`); the legacy string key is never read again.
    (`packages/engine/src/hub.ts`, `packages/engine/src/cache.ts`, `packages/engine/src/hub-admission.test.ts`)

*   **`sync-triggers` drift repair was not transactional** — `DROP TRIGGER` and `CREATE TRIGGER` ran
    as two separate statements; a failure in between left the table with no trigger at all and writes
    silently stopped invalidating until someone ran `--check`. Both now run in one `sql.begin()`.
    The regression test forces the CREATE to fail deterministically by renaming `kiln_emit_event` out
    from under it (installed triggers follow the rename by OID) and asserts the original trigger
    survives. (`packages/cli/src/sync-triggers.ts`)

*   **Schema-qualified table names reported as "unsafe"** — `public.contacts` is an ordinary name;
    calling it an unsafe SQL identifier sent the reader hunting for an injection problem that wasn't
    there. Table names now get their own check naming the real limitation. Schema *support* was
    deliberately not added: the trigger name would be malformed and `extractTables` strips the schema,
    so `app.x` and `public.x` would collide on the single dep key `x` — accepting the config would
    trade a clear error for a silent mis-invalidation. (`packages/cli/src/sync-triggers.ts`)

*   **Auto-deps was silent when it could not parse a table reference** — a dynamically-interpolated
    table name reaches the template as a bound placeholder, so `extractTables` captured nothing and
    the live field simply never revalidated. `createKilnSql` now warns when a query inside a capture
    scope yields zero tables *and* contains a FROM/JOIN/INTO/UPDATE keyword, so `SELECT 1` and
    `SELECT now()` stay silent rather than training people to ignore it. Deduped by query shape and
    capped. (`packages/core/src/sql.ts`)

## 0. Fixed in the 2026-07-12 audit (branch `fix/gemini-audit-round2`)

Source: an external (Gemini) audit produced a 159-item list across 4 sections; each item was independently re-verified against the actual source (not taken on faith — roughly a third of the original claims were false, mischaracterized, or already-fixed).

**Commit 1** — every item confirmed real and safe to fix mechanically:

*   **Absent `promote_after` was not pure SSR (surfaced 2026-07-14, resolved 2026-07-19)** — pages omitting the export fell through to `fsr.promoteAfterHits` (2) and were promoted + cached after 2 hits, serving one user's render cross-user. Resolved by ADR-016 bake classes: `load()` purity is observed per render, so identity-reading pages can never bake; `promote_after` was hard-removed (boot error) and jags-list's per-page `promote_after = false` workarounds (ADR-015) were deleted. Regression-guarded by `apps/jags-list/tests/purity.integration.test.ts`, which reproduced the original leak when pointed at stale pre-ADR-016 dists/artifacts and passes against the new runtime.

*   **`defineConfig` could corrupt the shared `DEFAULT_CONFIG` singleton** — the deprecated `config.live` → `config.fsr` bridging mutated `merged.fsr` in place; when only `config.live` was passed (not `config.fsr`), `merged.fsr` still aliased `DEFAULT_CONFIG.fsr` from the initial shallow spread, so the mutation corrupted the shared default for every subsequent `defineConfig()` call in the process. `merged.fsr` is now unconditionally a fresh object. (`packages/core/src/config.ts`)
*   **`i18n.locale()` never actually negotiated a language** — passed the raw, unsplit `Accept-Language` header (e.g. `"en-US,en;q=0.9,fr;q=0.8"`) to `negotiateLanguages` as a single locale tag, which essentially never matches. Now splits/strips q-values first. (`packages/core/src/i18n.ts`)
*   **Non-atomic Redis `SET` + `EXPIRE`** in three places (`KilnCache.setHtml/setJson`, legacy `RedisCache.setHtml/patchSlot/setJson`) — a crash between the two calls left an immortal (un-expiring) key. Now a single atomic `SET key val EX secs`, or a Lua `EVAL` for the hash-field case (`patchSlot`, which has no single-command atomic equivalent). (`packages/engine/src/cache.ts`)
*   **`registerLiveList` could produce an unhandled rejection** — returned the raw, uncaught promise instead of the `.catch()`-guarded chain assigned to `notificationQueue`; an unawaited caller (a common pattern here) hit an unhandled rejection on failure. Now returns the caught chain. (`packages/engine/src/watcher.ts`)
*   **`constructor?.name === 'LiveProp'` breaks under minification** — switched to `instanceof LiveProp`. (`packages/engine/src/watcher.ts`)
*   **SSE hub replayed stale patches right after telling the client to resync** — on lag, buffered patches weren't cleared before yielding `fsr-resync`, so the next loop iteration drained and replayed pre-resync patches on top of what the client was about to refetch fresh. Queue now clears on lag. (`packages/engine/src/hub.ts`)
*   **SSE keepalive dispatched a real `message` event** — `{data: ''}` with no event name fires a generic `EventSource.onmessage`, contradicting its own "keepalive comment" comment. Now `{event: 'keepalive', data: ''}`, unlistened and harmless. (`packages/engine/src/hub.ts`)
*   **Scheduled invalidation waited a full interval before its first run** — inverted to run-then-wait. (`packages/engine/src/watcher.ts`)
*   **No Postgres LISTEN/NOTIFY reconnection** — a dropped connection silently killed FSR invalidation delivery for the rest of the process. Now reconnects with exponential backoff on `'error'` (not `'end'`, which also fires on a deliberate shutdown `.end()`). (`packages/engine/src/db-notify.ts`)
*   **`invalidateDepKey` published to Redis sequentially in a loop** — parallelized via `Promise.all`. (`packages/engine/src/store.ts`)
*   **`reExecuteQuery` had no timeout** — a hung query blocked FSR revalidation for that slot indefinitely; added a 10s cap. (`packages/engine/src/store.ts`)
*   **`/__kiln/inspect` was unauthenticated in every environment** — exposed the full route/layout/live-field manifest. Now 404s when `NODE_ENV=production`. (`packages/routekit/src/boot.ts`)
*   **`ensuredRoutes`/`warnedOnce` Sets grew unbounded** for the life of the process — capped at 10k entries with a clear-and-continue policy (losing an entry only costs a redundant idempotent write or a re-logged warning, never incorrect behavior). (`packages/routekit/src/boot.ts`)
*   **Outermost layout never got its `data-kiln-layout` wrapper** — every other layout level and the page did; asymmetric and undocumented. Now consistent at every level. (`packages/routekit/src/layout-chain.ts`)
*   **`vite-plugin.ts` used `startsWith` for directory containment** — false-matches a sibling dir sharing a prefix (`pages` vs `pages-legacy`). Switched to a `path.relative`-based containment check. (`packages/routekit/src/vite-plugin.ts`)
*   **`typed-routes.ts` could emit invalid JS** — a route segment with a hyphen (or leading digit) produced an unquoted object key that isn't valid JS syntax. Segments are now word-capitalized (`user-profile` → `UserProfile`) and keys are quoted defensively. (`packages/routekit/src/typed-routes.ts`)
*   **`findNextElement` (live-list-render) had no depth tracking** — a same-tag element nested inside would truncate the range at the inner close tag via naive `indexOf`. Now depth-tracked like `findClosingTag` in `live/html.ts`. (`packages/routekit/src/live-list-render.ts`)
*   **`discover.ts` silently swallowed all directory-scan errors**, including non-ENOENT ones (permissions, etc.) that mean a misconfigured `pagesDir` silently discovers zero routes. Now logs anything but ENOENT. (`packages/routekit/src/discover.ts`)
*   **`compression()` middleware was a named no-op** — wired in by default (`config.compression !== false`) but did nothing. Implemented real gzip via `onAfterHandle` + `Bun.gzipSync`, gated on `Accept-Encoding` and a 1KB size floor; verified round-trip correctness against a live Elysia instance. (`packages/adapter-elysia/src/middleware/compression.ts`)
*   **`tracing()` parsed the request URL twice per request** — cached the parsed pathname on the `Request` object (same instance across `onRequest`/`onAfterResponse`). (`packages/adapter-elysia/src/middleware/tracing.ts`)
*   **`loadHooks` silently swallowed hook import errors** — a syntax error in a project's `hooks.ts` was indistinguishable from no hooks file at all. Now logs the actual error. (`packages/adapter-elysia/src/middleware/server-hooks.ts`)
*   **`destroyAllLive` didn't clear `pendingMutations`/`pendingByScope`** — optimistic-mutation tracking leaked for the rest of the page lifetime after every live connection was torn down. (`packages/client/src/silcrow.js`)
*   **`reconcile` never cleaned up accumulated stale DOM nodes sharing a `:key`** beyond what one template instance produces (distinct from the legitimate multi-root-element-per-key case, which is unaffected). (`packages/client/src/silcrow.js`)
*   **`useSilcrowAtom`/`useSilcrowPrefetch` accessed `window` unguarded** — would throw during SSR (`client.react.ssr: true`), unlike `useLiveValue` in the same file, which already guards. Made consistent. (`packages/react/src/hooks.ts`)
*   **No SIGTERM handler** — only SIGINT was handled, so container/orchestrator shutdowns (Docker, k8s) skipped the graceful watcher/Redis/DB shutdown path. (`packages/cli/src/cli.ts`)
*   **No `--port` CLI flag** on `dev`/`start`. Added. (`packages/cli/src/cli.ts`)
*   **`build` could skip the entire Vite build, islands included, for an island-only app** — the early-return only checked `findClientEntries(pagesDir).length`, not whether `kilnIslandsPlugin` had islands to add via its own independent `listIslands()` scan. Now checks both. (`packages/cli/src/cli.ts`)
*   **`create-kiln` scaffolds `workspace:*` dependencies** — resolves fine inside the monorepo, breaks `npm install` for every actual external user. Now pinned real version ranges. Also: no `.gitignore`/`README.md` were scaffolded (added both); `"start": "node dist/main.js"` while the generated code imports Bun-only builtins (`SQL` from `'bun'`) — now `"start": "bun dist/main.js"`; no check for an existing non-empty target directory before scaffolding into it (now errors instead of silently mixing in). (`packages/create-kiln/`)
*   **Workspace/config drift**: `pnpm-workspace.yaml` was missing `examples/*` (present in `package.json`'s own `workspaces` field, so pnpm and bun/npm resolution disagreed); `.gitignore` had no `test-results/` entry (Playwright artifacts, confirmed untracked-but-not-ignored on disk); `@kiln/engine` bundled `react`/`react-dom` as regular `dependencies` instead of `peerDependencies` (now peer, `^19.0.0` matching the rest of the monorepo); `routekit`/`cli` tsconfigs were missing project references to packages they actually import (`@kiln/engine`, `@kiln/client` for routekit; all four of its runtime deps for cli); `packages/client` had no `tsconfig.json` at all (added, `allowJs`, test files excluded).
*   **Stale `@kilnjs/react` string** in `hooks.test.tsx` console output (previously noted here as "harmless, not a build issue" — cleaned up anyway since it was trivial). (`packages/react/src/hooks.test.tsx`)
*   Added `CHANGELOG.md`, `CONTRIBUTING.md` (repo root) and `examples/address-book/README.md` (none existed). Added `AppError.forbidden()` (403) alongside the existing status helpers.

**Investigated and explicitly not changed**: the audit's item claiming `examples/address-book/tests/routes.test.ts` needs a live Postgres connection (and should be excluded from `test:unit` like its sibling integration test) was **wrong** — ran it directly, it passes cleanly with no DB. Left in the unit suite as-is.

**Commit 2** — the 3 items deferred from commit 1 as needing a design decision, resolved:

*   **`hub.ts`'s `activeConnectionsCount` was per-process only** — each worker in a multi-process deployment enforced `maxConnections` independently, so the real cluster-wide cap was `maxConnections × workerCount`. Added Redis-backed atomic admission (INCR-then-correct: INCR is atomic, and a connection that overshoots the limit gets immediately DECRemented back) used whenever a Redis client is configured; falls back to the local counter otherwise or on a Redis error (fails open rather than blocking the SSE stream on a cache outage). Kept the no-Redis path fully synchronous rather than routing both paths through one async wrapper — a first attempt at this added a microtask hop to the common (no-Redis) path and broke a timing-sensitive test in `hub.test.ts`, caught by running it against real Postgres, not just `tsc`.
*   **`InMemoryListChunkCache` was an unbounded `Map`** — currently unused anywhere in the codebase (not a live leak today), but not safe to wire up as-is. Added LRU bounding (a `Map` already preserves insertion order, so re-inserting on every read/write keeps recency for free) and a new `list-chunk-cache.test.ts` (had zero coverage before, including the eviction/LRU-touch behavior).
*   **`schema.ts`'s `last_requested_at` backfill `UPDATE` re-ran its `WHERE` clause on every `store.initialize()`** (i.e. every process start), paying a full-ish scan for zero matching rows after the first run on a large table. Added a partial index over exactly the rows still needing backfill (`WHERE last_requested_at IS NULL`) — stays empty once backfilled, so the repeat `UPDATE` becomes a near-free index scan of nothing instead of a sequential scan. Purely additive/declarative SQL, no application-level migration-versioning logic needed.

## 1. Fixed in the 2026-07-10 audit (branch `fix/audit-fixes`)

All found by a systematic read of every package (not by tests failing). One-line summaries; the diff is the reference:

*   **Server hooks never wired** — `loadHooks`/`serverHooks` existed in adapter-elysia but nothing called them; a project's `hooks.ts` was silently ignored. Now: `ServerAdapter.applyServerHooks?()`, called by `startKiln()` before route registration.
*   **Timeout middleware was a no-op** — derive() created an AbortController nobody consumed. Now the adapter wraps each page/action handler in `withTimeout` (SSE exempt); `timeout()` middleware just maps to 408.
*   **`AppError` → 500 on page routes** — only `Redirect` was caught. Now a top-level catch maps AppError statuses, renders nearest `_error.tsx`/`_not-found.tsx` (previously discovered but unused), and returns `{ error, status }` JSON to JSON clients. `_loading.tsx` remains unwired (no server-side semantic).
*   **`/__kiln/fsr/snapshot` empty body** — registered via `registerSSE`, whose generator drops non-SSE bodies. Now a page route; also reads the baked JSON snapshot before falling back to per-slot query re-execution.
*   **SSG prebake didn't bake** — the startup loop's condition (`page.promoteAfter === 0`) was always false (field never set at discovery time), and its body only wrote the raw entry params as "JSON". Now it checks `extractPageOptions(mod).promoteAfter === 0` and runs the real page handler with a synthetic request per entry.
*   **Watcher Redis JSON patches at wrong level** — `watcherTickRedis` merged slot values into the snapshot's top level while the disk path targeted `snapshot.data`; Redis-served promoted pages never saw patches. Ticks unified into one `watcherTick`; Redis merge now targets `data`.
*   **`cache.delete(route)` deleted descendants** — it `rm -r`'d the route's directory, where nested routes also cache. Now deletes only the base html/json + `_v/` variant subtree. Covered by a new cache.test.ts test.
*   **Variant Redis keys immortal** — `startKiln` hardcoded `ttlSecs: 0` while `delete()` relied on TTL to age out variant keys. `fsr.artifactTtlSecs` is now wired through.
*   **Seed XSS** — `injectJsonSeed`/`injectFsrSlots` embedded `JSON.stringify` output raw in a script tag; a loaded string containing `</script>` broke out. `toScriptJson` escapes `<`. Covered by a new assembler.test.ts test.
*   **Watcher loaders captured the first request** — `registerLoader` closures held the first visitor's full `req` (headers/cookies) and re-ran `load()` with it for everyone, and ignored `cache_key` variants. Loaders now get a sanitized path/params/query-only request; live registrations are skipped (with a one-time warning) for variant requests.
*   **Tombstoned routes resurrected** — the handler kept writing JSON snapshots for tombstoned routes every request. Cache writes and live registrations now skip when `hitStatus === 'Tombstoned'`.
*   **`loadConfigFromEnv` mutated `DEFAULT_CONFIG`** — shallow copy aliased `web`/`backend`. Deep-copied now.
*   **Phantom cache providers** — `memory`/`sqlite` were typed + documented but KilnCache always wrote disk. `startKiln` now throws `StartupError('UnsupportedProvider')` for them; default provider changed `memory` → `filesystem` (matches actual behavior, not a behavior change).
*   Smaller: route-row ensure once per process with new `'Missing'` HitStatus retry (was 2 DB writes/request); db-notify advances the event cursor only after invalidations persist, cursor path respects `cacheDir`, NaN cursor guard; Redis-watcher reconnect no longer accumulates abort listeners; watcher file writes are atomic; image handler returns 400 on NaN params and never upscales; `hoistHeadTags` masks `<svg>` regions; `applyLivePropMarkers` refuses to tag matches inside tags/attributes; CSRF honors `x-forwarded-host` only behind `web.trustProxy`; CLI gains `kiln start` and errors on redisUrl-without-postgresUrl; `adapter.listen` honors `web.host`; `cache_key` is the canonical export (camelCase deprecated).
*   Dead code removed: adapter `handlers/` stubs, `layout-intercept.ts` (parsing lives in `wrapRequest`), `smoke.ts`, `injectFsrScriptTag`, `assembleFragments`, `injectStylesheet`, `findSLiveSlots`, `extractLiveLists`, `rawSnapshotProps`, the no-op `prebakeNext` wrapper, `StartKilnOptions.promoteAfter`, the `/__kiln/live/*` ping stub, `test-app/api/health.ts`.

## 2. Resolved (previously tracked here, no longer present)

*   **Entire `src/` tree shadowed by stray compiled `.js`/`.d.ts` output (critical, found by actually running `bun test`)** — Every package had untracked, uncommitted `.js`/`.d.ts`/`.js.map`/`.d.ts.map` files sitting directly in `src/` next to their `.ts` source (524 files total, e.g. `packages/engine/src/cache.js` next to `cache.ts`). `bun` (like Node) resolves an import specifier like `./cache.js` to the literal file on disk before falling back to transpiling `cache.ts`, so at runtime every test/dev run was executing **stale, pre-fix compiled JS**, not the current TypeScript source. This is almost certainly why "Phase 1: Compile & Test Green-lighting" was previously flagged as broken — `tsc --noEmit` (type-checking) correctly resolves `.ts` regardless, so it looked clean, but any actual `bun test`/`bun run` would have silently run old code. Confirmed concretely: `cache.test.ts`'s new Redis tests failed against the stray `cache.js` (which still had the pre-fix `this.redis = null` circuit-breaker logic) and passed immediately once the stray file was removed. Root cause unknown (likely a `tsc` run at some point without a proper per-package `outDir`). Deleted all 524 stray files via `git clean -fd -- '*.js' '*.d.ts' '*.js.map' '*.d.ts.map'` (verified first that every one had a `.ts`/`.tsx` sibling, i.e. was generated, not hand-authored). **If this recurs, treat it as high-priority** — it silently invalidates test runs.
*   **Stale JSON snapshot served after a promoted-but-uncached re-bake (found by actually running `bun test`)** — `boot.ts`'s "eagerly save JSON (once per concrete route)" step only wrote the JSON snapshot `if (!existingJson)`, i.e. only on a route's very first bake. But whenever a full bake ran again later (e.g. `promoted` was `true` in the DB but the HTML cache file was missing, forcing a fresh `load()` + re-render), the newly baked HTML correctly contained the fresh value — but the JSON snapshot was left at its old value, since JSON already existed. The *next* request then hit the cache and called `materializeBakedShell(cachedHtml, cachedSnapshot)`, which re-injects the (stale) JSON into the `s-live` slots of the (fresh) HTML shell, silently reverting the value that had just been baked. Caught by `boot.test.ts`'s "promotes on the second successful render..." test, which was failing (expected `render-2`, got `render-1`) once the stray-`.js`-shadowing issue above was fixed and the test could actually run against real source. Fixed by always writing the JSON snapshot on every full bake, not just the first — a full bake by definition just re-ran `load()`, so its output is always current. Also fixed a related but separate issue in the same test file: the "materializes query-backed Live.list rows..." test's mock store was missing `setBakedPaths`, causing a `TypeError` once the shadowing issue was fixed and this code path actually ran.
*   **`dist/` build output stale in every package (critical — same class of bug as the stray `src/*.js` issue, found while running a real dev server against `test-app`)** — Unlike the stray files above (untracked garbage sitting in `src/`), each package's `dist/` is the *legitimate*, gitignored build output that `package.json`'s `"main"`/`"exports"` correctly points consumers to. The problem: nobody had run `bun run build` since `Jun 30`, so `dist/` reflected code from well before this session's fixes (and before `a8dea00`). Workspace packages like `test-app` import `@kiln/routekit` etc. by package name, which resolves through `node_modules/@kiln/routekit` (a symlink to the package dir) to its `dist/index.js` — so `test-app` was silently running months-old logic regardless of any `src/` edits. Only caught because a live proof-of-concept server (`test-app/scripts/prove-baking.ts`, see below) produced a layout-fragment response missing content that the freshly-fixed `respondWithNavigationShape` should have included; adding a debug log confirmed the running server's `dist/boot.js` didn't even contain the debug line. Fixed by rebuilding every package (`bun run build`, i.e. `tsc -b`, in `core`, `live`, `engine`, `routekit`, `adapter-elysia`, `react`; `packages/client` needed its own `build.ts` run directly since its `build` script shells out to `bun` by name). **Takeaway: after editing any package under `packages/`, rebuild before trusting a `test-app`/`examples/*` run — `bun test` inside a package resolves its own `src/` directly, but cross-package consumption always goes through `dist/`.**
*   **`respondWithNavigationShape` dropped intermediate layouts on a "grandchild" enhanced navigation (functional bug, not just a doc/architecture gap — found by building and running `test-app/scripts/prove-baking.ts` against a real 3-level layout chain: root → `/dashboard` → `/dashboard/reports` → page)** — The function computed `deepestPresent` (the deepest layout the client already has mounted, per the `x-ps-present` header) correctly by searching the *whole* layout chain, but then **always** sent back just the bare page fragment (`extractLayoutFragment(html, pagePattern)`, or the pre-rendered `pageFragment` shortcut) — never anything for layouts that sit between `deepestPresent` and the page. This only produced a correct response when `deepestPresent` was the page's *immediate* parent layout (e.g. tab-switching within an already-fully-mounted branch); if the client had only the root layout mounted and navigated straight into a grandchild route, the response was missing the intermediate layout(s)' HTML entirely (e.g. a sidebar or tab bar would just never render, with no error). Root cause: the function was only ever exercised in tests/usage where all ancestor layouts already happened to be present. Fixed by computing `nextPattern` — the layout one level deeper than `deepestPresent` in the chain, or the page pattern if `deepestPresent` is already the innermost layout — and extracting *that* pattern's fragment instead of always the page's. Verified the bug is real by reverting the fix and re-running the new test (it failed exactly as predicted, missing the intermediate layout's marker text), then restoring the fix (test passes). Covered by a new test in `boot.test.ts` ("includes the missing intermediate layout...") and by the end-to-end `prove-baking.ts` script, which checks response size and content at all three navigation depths against a real running server.

*   **`store.setBakedPaths` Nullability Conflict** — Fixed. [store.ts#L353](file:///Users/jagjeet/Development/workspaces/Kiln/packages/engine/src/store.ts#L353) now types `htmlPath: string | null`, matching the `null` call in [boot.ts#L321](file:///Users/jagjeet/Development/workspaces/Kiln/packages/routekit/src/boot.ts#L321). Landed in commit `a8dea00` ("feat: update baking implementation and demo pages").
*   **Missing `setBakedPaths` on Test Double** — Fixed. `boot.test.ts` now implements `setBakedPaths: async () => {}` on its mock store (lines 58, 380).
*   **Workspace-Wide `tsc` No-Emit Compilation Failures** — Not reproduced. No `Buffer.from` type errors in `adapter-elysia`, no `drizzle-orm`/`bun-sql` references in `engine`, no `CacheProvider` interface conflict in `routekit`, no missing `fs` imports in `cli`. All packages type-check clean individually.
*   **Scaffold Name Drift** (`Fsr.js`/`startFsr` in `create-kiln` templates) — Not found in current templates.
*   **Stale Asset Links** (`@kiln/client` / `silcrow.js`) — `package.json` exports map (`./silcrow.js` → `./dist/silcrow.js`) resolves correctly and `dist/silcrow.js` exists.
*   **`@kilnjs/react` stale reference** — Only appears as a `console.log` string in `packages/react/src/hooks.test.tsx` (not an import, not in `test-app`). Cosmetic, non-blocking; harmless to clean up but not a build issue.
*   **Promoted HTML not written to Redis by default** — Fixed. [`cache.ts#setHtml`](file:///Users/jagjeet/Development/workspaces/Kiln/packages/engine/src/cache.ts#L63) previously only wrote baked HTML to Redis when `pinInRedis` was explicitly `true`, so by default promoted pages cached to local disk only — contradicting ADR-001 ("Redis is required... shared memory layer") and the Redis key schema in `architecture.md` (`kiln:html:<route>` as source of truth). `setHtml` now always writes to Redis when a client is configured (matching `setJson`); `pinInRedis` now only controls whether the entry skips TTL expiry. Covered by new tests in `cache.test.ts` ("Redis sharing for promoted HTML").
*   **`evictIdleRoutes` dead code** — Fixed by removal. The method (in `store.ts`) was never called by the watcher's live sweep (`watcher.ts` `spawnSupervisedIdleEviction`, which only ever calls `purgeInactiveRoutes`) — it was only exercised by `watcher.test.ts` manually simulating "the watcher loop." Given the `WatcherConfig` fields `idleEvictSecs`/`idleThresholdSecs` are explicitly marked `@deprecated` in favor of the single `purgeSweepSeconds`/`purgeAfterSeconds` pair, the two-tier soft-demotion concept `evictIdleRoutes` implemented looks superseded rather than missing. Removed the method from `store.ts`; updated `watcher.test.ts`'s "Test Idle Eviction" section to exercise `purgeInactiveRoutes` (the mechanism actually wired into the watcher) instead, including the row-deletion assertion (`purgeInactiveRoutes` deletes the row rather than un-promoting it). **Unverified** — this test requires a live Postgres/Redis (`bun run test:integration`), which couldn't be run in this sandbox; the SQL and assertions were reasoned through manually.
*   **`applyLivePropMarkers` fragile plain-string matching** — Fixed. [`boot.ts#applyLivePropMarkers`](file:///Users/jagjeet/Development/workspaces/Kiln/packages/routekit/src/boot.ts#L470) now counts occurrences of the rendered value's text before tagging it; if the value appears more than once in the page it skips auto-tagging and logs a warning telling the developer to add an explicit `s-live` attribute, instead of silently wrapping the first (possibly wrong) match. Covered by new tests in `boot.test.ts` ("applyLivePropMarkers").
*   **Redis error handling as a one-way circuit breaker** — Fixed. `KilnCache` in `cache.ts` used to set `this.redis = null` permanently on the first Redis error in `getHtml`/`setHtml`/`getJson`/`setJson`/`delete`. Since `KilnCache` is instantiated once per route and lives for the process lifetime (`buildPageHandler` in `boot.ts`), a single transient Redis blip disabled Redis for that route until restart. Errors are now logged via `warnRedisError()` and fall through to disk without discarding the client, so the next call retries Redis. Covered by a new test in `cache.test.ts` ("Redis error recovery").
*   **Promoted pages never noticed a layout cache invalidation (found by a new unit test, not by reasoning)** — After adding pattern-level layout caching (`cache.getLayoutHtml`/`setLayoutHtml`/`deleteLayout`, ADR-011), a test that baked a route to promotion, called `cache.deleteLayout(pattern)` to simulate a deploy changing shared header/footer code, then re-requested the route — expected the new layout content, but the promoted route kept serving the OLD layout markup indefinitely. Root cause: `boot.ts`'s promoted-cache-hit path (step 3 of `buildPageHandler`) reads the page's own full-HTML cache entry (`kiln:html:<route>`) and, once that cache exists, returns it directly — it never re-checks the layout cache at all, because the assembled HTML was baked once and is otherwise considered immutable except for `LiveProp` patching. `deleteLayout()` only affects the layout's own cache entry, which a promoted page's request path simply doesn't look at. This defeats the entire purpose of pattern-level layout caching for any route that has already been promoted (the common case in production). Fixed by adding a `layoutSignature` field to `BakedSnapshot` (`packages/engine/src/baking.ts`): a hash fingerprint of the exact layout cache entries (`pattern:hash(html)` per layout) a page's shell was assembled from, computed by a new `computeLayoutSignature()` helper in `boot.ts`. On every promoted-cache-hit, the current signature is recomputed from the live layout cache and compared against the one stored at bake time; a mismatch is treated exactly like a missing/corrupt page cache (delete + force full re-bake). Covered by `boot.test.ts`'s "re-bakes a layout after its cache entry is explicitly invalidated" test, which failed with the old layout content still present before this fix and passes now. See ADR-011 in `decisions.md`.
*   **Disk-tier wording vs. implementation (ADR-002)** — Reconciled by updating the docs, not the code. ADR-002 said "disk writes are fire-and-forget; disk reads are restricted to cold-start boots." In practice `cache.ts` `await`s the disk write synchronously, and reads from disk on *any* Redis miss (not gated to a cold-start-only phase — no such gate exists anywhere in the code). Chose to update the docs rather than cripple the implementation to match, because the current behavior is more resilient: it lets a route keep serving from disk through a Redis outage or eviction at any point in the process's life, not just at boot. `.memory/decisions.md` (ADR-002) and `.memory/architecture.md` (3-Layer Storage Model section) updated 2026-07-07; behavior was not changed.

---

## Note on removed non-bugs (trimmed 2026-07-16)

<!-- Trimmed 2026-07-16: three other "Jag's List findings" were removed from
this file because they were never framework *bugs*. For the record —
(1) Redis cache keys not app-namespaced: a missing capability, not broken
behavior; added as the `cache.namespace` config (PR #7, ADR docs).
(2) better-auth admin-plugin role type vs the app's domain roles: normal
cross-library integration friction in apps/jags-list, not a framework defect;
localized in the app's `lib/auth.ts`.
(3) bun's `SQL` binding JS arrays in `ANY()` differently from node-postgres:
a Bun runtime quirk, not Kiln's concern; noted in the app's test code. -->
