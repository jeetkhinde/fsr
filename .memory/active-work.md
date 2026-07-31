# Active Work Context

**Kiln framework** workspace only. Completed-session history → [work-log.md](work-log.md). App-specific work lives under `apps/<app>/.memory/`.

Last updated: 2026-07-31

## Current State

**Everything is merged. `main` @ `347ad6d`, working tree clean, no open PRs, no worktrees.**

Last full framework verification: **2026-07-31** @ `347ad6d` — `bun run test:unit`
**225 pass / 60 skip / 0 fail**, `bun run test:integration` exit 0 (live PG + Redis),
`bun run build` green, and a fresh `git clone` builds in a single pass.

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

**1. The framework assumes it owns the server, so auth and islands are mutually exclusive.** (L)
`kiln dev` / `kiln start` construct their own `ElysiaAdapter` (`packages/cli/src/cli.ts:148,204`)
and never load the app's own entry. But an app that must set a cookie has to own its entry, because
actions cannot touch the response (see #2). Net effect: **auth forces a custom entry, and a custom
entry forfeits the island build pipeline** (Vite chunks + `kiln-islands.json`). `apps/jags-list`
hit exactly this and has no islands as a result. `startKiln` does accept `islandsManifestUrl`
(`boot.ts:39`), and `kiln start` serves `/_kiln/client/*` in ~20 replicable lines, so a seam
exists — it is just undocumented and unsupported.

**2. Actions never receive `res`.** (M) `actions[actionName](req)` — `boot.ts:88`. No cookies, no
custom status, no headers from an action. Consequences already observed: login/logout had to become
raw adapter routes, and a 409 was unreachable in Plan 3b because `AppError` offers only
404/401/403/422/500/redirect (`packages/core/src/errors.ts`). **Fixing this likely dissolves half
of #1.** The API shape is a public-surface decision — brainstorm before implementing.

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

Two branches are in flight and unmerged; this file is on `fix/live-list-auto-deps`, branched from
`main` @ `f5fa13a`, so it does not reflect the other one:

- **PR #31 `feat/action-response-api`** — closes P0 #2 (actions receive `res`). Its own branch
  rewrites P0 #1 and #2 above; read that branch's copy of this file, not this one, for their state.
- **`fix/live-list-auto-deps`** — the auto-deps item of the `Live.list` cluster, above.

Next, once both land: the rest of the `Live.list` cluster. The `<li>`-only markup constraint is the
most limiting for real UIs (a kanban board is divs, not a list), and the islands gap is what stops a
list inside an island receiving anything. Neither fails silently the way auto-deps did, so neither is
as urgent as that was.
