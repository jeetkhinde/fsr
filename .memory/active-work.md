# Active Work Context

**Kiln framework** workspace only. Completed-session history → [work-log.md](work-log.md). App-specific work lives under `apps/<app>/.memory/`.

Last updated: 2026-07-31

## Current State

**In flight: `feat/action-response-api`** (worktree `.worktrees/feat-action-response-api`) — P0 #2,
complete and verified, not yet merged. `main` @ `f5fa13a`.

Last full framework verification: **2026-07-31** on `feat/action-response-api` — `bun run test:unit`
**248 pass / 60 skip / 0 fail**, `bun run test:integration` exit 0 (live PG + Redis),
`bun run build` exit 0, and all seven `apps/jags-list` suites green individually (24 pass / 0 fail).

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

## Next Priorities — framework only (surveyed from source 2026-07-31)

Ordered by launch risk. Every claim below was traced to a file:line in this survey, not carried
from the older roadmap.

### P0 — will bite a real app at launch

**1. An app that owns its entry point cannot use islands.** (M — smaller than it was)
`kiln dev` / `kiln start` construct their own `ElysiaAdapter` (`packages/cli/src/cli.ts:148,204`)
and never load the app's own entry, so a custom entry forfeits the island build pipeline (Vite
chunks + `kiln-islands.json`). `apps/jags-list` still has no islands.

**The old framing — "auth forces a custom entry" — is dead.** #2 is fixed, so cookies no longer
require owning the entry. What actually keeps jags-list on a custom entry, read from
`apps/jags-list/src/main.ts` after the rewrite, is (a) better-auth's `/api/auth/*` catch-all, which
is not a Kiln page, and (b) its hand-built FSR wiring and `registerAsset` call. So this is now
"let app code contribute raw routes and assets under the CLI", which is a smaller and much better
defined problem. `startKiln` already accepts `islandsManifestUrl` (`boot.ts:39`) and `kiln start`
serves `/_kiln/client/*` in ~20 replicable lines.

**2. ~~Actions never receive `res`.~~ DONE 2026-07-31** — `feat/action-response-api`, ADR-019.
Actions get `(req, res)`; `headers` is a `Headers` with a required `res.cookies`;
`AppError.conflict()` covers 409. jags-list's raw auth routes are deleted. Details in
[bugs-resolved.md](bugs-resolved.md) §0.

**3. `Live.list` is far narrower than its API suggests.** (M for what remains) Three constraints
left, none visible at the call site:
- rows must be `<li>` inside `<ul>`/`<ol>` (`live-list-render.ts:90,131`) — a div board or a table
  cannot be marked at all;
- patches are dropped inside islands (`live-client-script.ts:63`) and, unlike scalars, never
  published to the store — so a list inside an island receives nothing;
- no `target` option, unlike `LiveProp` (`packages/live/src/list.ts`);
- ~~no auto-deps~~ — **DONE 2026-07-31** on `fix/live-list-auto-deps`. Each list captures its own
  query's tables; a list with no deps at all warns. jags-list's explicit `dependsOn` is deleted and
  `test:live` passes on captured deps. Details in [bugs-resolved.md](bugs-resolved.md) §0.

**Found while fixing the above, not fixed:** layout `load()` is never wrapped in `withDepCapture`
(`page-render.ts`, the layout branch calls `lMod.load(tracker.proxied)` directly), so layout
**scalar** live fields get no auto-deps at all. Layout *lists* are fine — list capture is
self-contained. Unmeasured severity; nobody has hit it because layouts with live scalars are rare
in the test vehicle.

### P1 — warned, but still surprising (each is a live `warnOnce`)

| Combination | Behaviour | Size |
|---|---|---|
| `cacheKey` + any live field | live updates silently skipped | M |
| `bake='user'` + `Live.list` | per-user lists unsupported | M |
| `bake='user'` + dynamic segment + live fields | **SSE scoped to the wrong user** | M |
| `Live.list` in a dynamic-segment layout | all instances share one channel | M |

The third is the worst of these — wrong-user data, not merely missing updates.

### P2

- **External watcher** — settled 2026-07-30 as dev's-choice, default `'embedded'`; not implemented.
  Only becomes work if you want it real. Blocked on how an out-of-process watcher invokes a
  `Live.list`'s closures — see [roadmap.md](roadmap.md) § Phase 4.2. (L)
- **`.env` files are gitignored**, so a fresh clone/worktree cannot run `test:integration` — it
  fails with `database "jagjeet" does not exist` until `test-app/.env` is copied across. Cost time
  twice on 2026-07-30. Ship `.env.example` + a preflight check. (XS)

### Recommended starting point

**Ordering now lives in `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md`** (merged
via PR #33) — it ranks every remaining framework item by framework severity and records a measured
conflict map. Read that first; this section only summarises.

Landed 2026-07-31: PR #31 (actions receive `res`), PR #32 (`Live.list` auto-deps).

The theory that P0 #1 and #2 would "collapse together" was **tested and only half held**. Fixing #2
removed auth as a reason to own the entry, but jags-list still needs a custom entry for
better-auth's catch-all and its FSR wiring — so #1 survived, in reduced form. Recorded because the
prediction was explicit and the outcome should be too.

### Known test-harness limitation (found 2026-07-31)

`cd apps/jags-list && RUN_APP_TESTS=1 bun test tests/` — running all suites in **one** invocation —
fails with `PostgresError: Connection closed` (3 pass / 10 fail). Each suite spawns its own server
and the connections collide. **This is pre-existing, not a regression**: verified identical on
unmodified `main` @ `f5fa13a`. Run the suites one file at a time; all seven pass individually.
