# Active Work Context

**Kiln framework** workspace only. Completed-session history → [work-log.md](work-log.md). App-specific work lives under `apps/<app>/.memory/`.

Last updated: 2026-08-04

## Current State

**In flight: `fix/event-cursor-in-postgres`** (worktree `.worktrees/fix-cursor-in-postgres`) — moves
the catch-up cursor off local disk into a shared `kiln_fsr_cursor` row (ADR-022). `main` @ `5ad5553`.

(The entry that stood here — "In flight: `feat/action-response-api`" — was stale for four days; it
merged as PR #31 on 2026-07-31.)

Last full framework verification: **2026-08-04** on `fix/event-cursor-in-postgres` —
`bun run test:unit` **340 pass / 60 skip / 0 fail**, `bun run test:integration` exit 0 (live PG +
Redis), `bun run build` exit 0, and `apps/jags-list` **53 pass / 0 fail across 16 files** in one
`RUN_APP_TESTS=1 bun test` invocation.

Note for fresh worktrees: they start with no `node_modules` and no `packages/*/dist`, so
`bun install && bun run build` must run before any test, and `.env` files must be copied in
(still gitignored — the P2 item below).

Merged since 2026-07-27:
- **PR #27** — layout cache keyed by pattern AND its own params (fixes cross-instance chrome leak).
- **PR #28** — the framework backlog: `boot.ts` 1592 → 429 lines across 6 modules, all nine Phase 5
  DX items, correctness fixes, and `examples/address-book` deleted.
- **PR #29** — ADR-011 layout scoping enforced at runtime (purity tracker layout mode).
- PRs #24/#25/#26 — Jag's List Plan 3a (live wiring), Plan 3b plan doc, backlog plan doc.

### Framing (2026-07-31, from the maintainer)

**`apps/jags-list` is a test vehicle, not a product.** It exists to exercise Kiln through a real
app so the framework does not fail at launch. Findings from building it are therefore **framework
bugs**, not app backlog — prioritise them as such. Framework work is the focus; app features are
only interesting insofar as they exercise a framework path.

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

## Next Priorities — framework only

### The 2026-07-31 survey is fully closed (`fix/framework-dx`, 2026-07-31)

Every item in `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md` — the doc that ranked
the remaining framework work by severity — is done. Items 1 and 2 landed as PRs #34/#35; items 0 and
3-7 landed on `fix/framework-dx`:

| # | Item | Outcome |
|---|---|---|
| 0 | `.env.example` + preflight | `test-app/.env.example` + `bun run preflight`, first step of `test:integration` |
| 3 | Layout scalar live fields | Registered under the page route with per-segment auto-deps — **wider than filed**: they were never registered at all, so capturing deps alone would have been a no-op |
| 4 | `Live.list` in islands | `target: 'store'` + `useLiveList()` in `@kiln/react` |
| 5 | App entry + islands | `config.server.setup` + `ServerAdapter.registerRaw` (ADR-020) |
| 6 | Three warned combos | Dynamic-layout `Live.list` **supported** via `layoutInstancePath()`; the other two **decided against**, warnings reworded to say so |
| 7 | External watcher | **Removed** — typed for two releases with nothing behind it (ADR-021) |

**Two findings were wider than filed, and that is the pattern worth carrying forward.** Item 3 was
filed as a missing `withDepCapture`; tracing it showed layout live fields had no slot row and no
loader — the client subscribed to a slot the server never fed. Item 6's third combination was filed
as a limitation to warn about; it was a routing-identity bug (pattern vs instance path) and was
simply fixable. Both were found by following the value end-to-end through the *real* client
(`packages/client/src/silcrow.js`, which subscribes per `[data-kiln-live]` element), not by reading
the registration site alone.

**Nothing from that survey remains open.** The next framework work needs a fresh survey; the
standing backlog is in [roadmap.md](roadmap.md).

### ~~Known test-harness limitation~~ — FIXED 2026-08-01, and the recorded cause was wrong

`cd apps/jags-list && RUN_APP_TESTS=1 bun test` now runs clean: **53 pass / 0 fail across 16
files**, exit 0 (and `bun test tests/` alone is 24 pass / 0 fail). Previously the whole-app run was
38 pass / 15 fail and `tests/` alone was 3 pass / 10 fail, both with `PostgresError: Connection
closed`.

**The cause recorded here on 2026-07-31 — "each suite spawns its own server and the connections
collide" — was wrong.** So was the follow-up diagnosis that blamed concurrency. Measured
2026-08-01: `bun test` runs test **files sequentially in a single process** (two files with
overlapping timers show the same pid and no interleaving), so nothing ever ran concurrently and
nothing collided.

The real cause: `db/client.ts` exports a module-level `sql` singleton, and one process means one
module registry, so all seven files share that pool. The first file's `afterAll` called
`sql.close()`, leaving a dead pool for every file that ran *after* it. Deterministic, not flaky —
which the "collision" framing would have predicted wrongly.

Fixed by deleting the `sql.close()` calls from all **twelve** integration test files — six under
`tests/`, two under `lib/`, four under `db/`. Fixing only `tests/` looks like a fix if you verify
with `bun test tests/`, but leaves `bun test` from the app root still failing, since `lib/` and
`db/` suites share the same pool. The one-shot scripts under `scripts/` still close it, correctly:
they are their own process and exist to terminate. Rationale is in `db/client.ts` so the calls
don't get re-added.

~~**Separate, still-open flakiness (found while verifying this):** two app-test runs back to back
can fail with `Unable to connect`.~~ — **FIXED 2026-08-01** on `fix/sigterm-hangs-with-open-sse`,
and the recommended workaround was the wrong one. The suggestion here — "leave a few seconds
between runs, or the suites need dynamic ports" — treated a missing `await` as a scheduling
problem. All six server-spawning suites called `proc.kill()` and moved on; `kill()` only *signals*.
Measured: rebinding the same port immediately after `kill()` fails **2 times in 3**, so the ports
were fine and the teardown was not. Fixed with `await proc?.exited`; dynamic ports were never
needed.

**That await then found a real framework bug.** With it, `live.integration.test.ts` — the one suite
that leaves an SSE reader open — began timing out its teardown at 5s, because
`ElysiaAdapter.listen`'s SIGTERM handler awaited `app.stop()` and an SSE stream never drains. Any
Kiln app with a live field hung forever on SIGTERM. Fixed to `stop(true)`; see
[bugs-resolved.md](bugs-resolved.md) §0.

**Scope note:** the pool bug was an *app* test-harness bug — the framework's own `test:integration`
runs each suite as a separate `bun` invocation, so it never shared a pool. The shutdown bug found
downstream of it was **not**: it was in `@kiln/adapter-elysia` and shipped to every app. Worth
remembering that the test vehicle earned its keep exactly as intended.
