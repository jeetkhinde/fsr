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

**3. `Live.list` is far narrower than its API suggests.** (L for the cluster) Four constraints,
none visible at the call site:
- rows must be `<li>` inside `<ul>`/`<ol>` (`live-list-render.ts:90,131`) — a div board or a table
  cannot be marked at all;
- patches are dropped inside islands (`live-client-script.ts:63`) and, unlike scalars, never
  published to the store — so a list inside an island receives nothing;
- no `target` option, unlike `LiveProp` (`packages/live/src/list.ts`);
- **no auto-deps** — `registerLiveLists` passes `meta.dependsOn` straight through
  (`live-registration.ts:89,107`) while `LiveProp` unions observed tables. Omit `dependsOn` and the
  list silently never updates. **Treat this one as a bug, not a gap**: the asymmetry is invisible
  and fails silently. Proven by falsification in `apps/jags-list` (`bun run test:live` fails on a
  20s timeout without it).

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

P0 #1 and #2 are close to one problem. Give actions a response handle, then let a custom entry
consume the island pipeline — #1 and #2 collapse together, and jags-list can finally exercise
islands, which is the point of having it. Then the `Live.list` cluster, starting with auto-deps
parity because it fails silently.

**Open decision before coding:** the action/response API shape. Options include passing `res` as a
second argument, returning a response descriptor, or a `cookies`/`headers` bag on the request.
Worth a brainstorm — it is public surface and hard to change later.
