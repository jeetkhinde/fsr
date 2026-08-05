# Jag's List

Small-team project management on Kiln — the framework's flagship dogfood app.
Spec: `docs/superpowers/specs/2026-07-14-jags-list-design.md`.

## Setup

Requires local Postgres and Redis.

    createdb jagslist
    cp .env.example .env       # set DATABASE_URL, BETTER_AUTH_SECRET, and a Redis DB index
    bun install                # from the repo root
    bun run auth:migrate       # better-auth tables (user/session/account/verification)
    bun run db:migrate         # app tables + touch triggers + role model
    bun run db:sync-triggers   # installs/verifies the kiln_emit_event invalidation triggers
    bun run bootstrap-superadmin -- you@example.com <password> "Your Name" <handle>
    bun run dev                # http://localhost:3200

Forgotten the bootstrap password? Public sign-up is disabled and
`bootstrap-superadmin` refuses once a superadmin exists, so use:

    bun --env-file=.env scripts/set-password.ts you@example.com <new-password>

Run `db:sync-triggers` again after any migration that adds/renames a table
listed in `kiln.config.ts`'s `fsr.triggerTables` — it's idempotent (safe to
re-run; a table whose trigger already exists is a no-op).

Note: from a fresh git worktree, build the framework packages first
(`bun run --filter '@kiln/*' build` at the repo root) — the `@kiln/*` deps
resolve to `packages/*/dist`, which is gitignored.

## Roles

`superadmin` › `admin` › `user`.

- **superadmin** — the first user (created by `bootstrap-superadmin`); immutable,
  nobody can modify, demote, or delete it. Only one exists.
- **admin** — manages the team (creates invites; the promote/demote console
  arrives in a later milestone). Cannot touch the superadmin.
- **user** — regular member.

## Projects, columns & tasks

- **/projects** — every member sees all active projects. Any member creates a
  project (auto-seeded with Backlog / In Progress / Done). Admins archive.
- **/projects/:id/board** — kanban. Add tasks to a column, move a task via the
  per-card column picker (JS-free), add/rename columns; admins delete empty
  columns. Moving a task into a terminal column ("Done") logs completion.
- **/tasks/:id** — edit title, description, assignee, priority, due date.
- **/projects/:id/activity** — the project's event feed, newest first.

All pages are server-rendered: their `load()` reads the session, so the bake
classifier (ADR-016) keeps them pure SSR automatically. Live updates and the
drag-and-drop board island arrive in Plan 3.

Cache invalidation is table-level and hands-off: `db/client.ts` uses
`createKilnSql`, which auto-records the tables a page's `load()` reads (no
manual dep keys); `kiln.config.ts`'s `fsr.triggerTables` + `kiln
sync-triggers` install the generic Postgres triggers that fire on writes to
those tables. `notifications` names `ownerColumn: 'user_id'` so one user's
notification invalidates only that user's cached data, never every user's.
`task_labels` is the one exception — its composite primary key has no `id`
column, so it keeps a hand-written trigger (see the comment above it in
`migrations/0000_init.sql`).

## Inviting teammates

Sign in as an admin or superadmin → **Team** → create an invite (role: admin or
user — never superadmin) → share `/invite/<token>`. Public sign-up is disabled;
invites are the only way in.

## Tests

    bun run test                                          # unit, no infra
    bun run test:db                                       # needs Postgres
    bun run test:app                                      # spawns the app; needs Postgres + Redis
    bun run test:crud                                     # spawns the app; projects/board/task/activity
    bun run test:purity                                   # spawns the app; cross-user render isolation
    bun run test:freshness                                # spawns the app; auto-dep + owner-scoped invalidation
    bun run test:gate                                     # spawns the app; auth gate + live-list markers
    bun run test:live                                     # spawns the app; end-to-end SSE live drill
    bun run test:board                                    # spawns the app; bakeability, 409 moves, island pipeline, live board

`test:board`'s island-pipeline case needs `bun run build` first — it fetches
the chunk the manifest points at. The suites spawn `kiln start`
(`tests/spawn-app.ts`), so a break in CLI boot fails them.

**Stop your dev server before running the live suites.** The catch-up cursor is
fleet-shared (ADR-022): a `kiln dev` on the same Postgres consumes the
invalidation events the test server is waiting for, and `test:board` /
`test:live` then fail on a 20s timeout that looks exactly like a code
regression. Verified both ways — 8/9 with a dev server up, 9/9 without.

## Live surfaces

| Route | Mechanism | Dep |
|---|---|---|
| `/projects/:id/activity` | `Live.list` on `events` | `activity` (explicit — required) |
| `/projects/:id/board` | store-target `LiveProp` on `boardState` | `tasks`, `columns` (+ `projects` auto-captured) |

**Rule: `Live.list` does NOT receive auto-deps — always pass `dependsOn`.**
Scalar `LiveProp` fields union the request's observed tables; live lists do
not (`boot.ts` `registerLiveLists` passes `meta.dependsOn` straight through).
Omit it and you register a list that silently never updates. Proven, not
assumed: deleting `dependsOn` makes `bun run test:live` fail on a 20s timeout.
Dep keys are table-level (`'activity'`), matching `kiln.config.ts`'s
`fsr.triggerTables`.

**Rule: a live page's `load()` must not call `requireUser` or read
`req.query`.** The auth gate lives in `hooks.ts` `handle`, which runs before
every Kiln route. The watcher re-runs loaders with **empty locals**
(`makeLoaderRequest`), so `requireUser` there throws on every refresh — and
any identity read also blocks baking, with the demotion latching for the life
of the process. `tests/gate.integration.test.ts` proves the gate still holds
without it.

**Gotcha:** an empty `Live.list` takes the `markEmptyListSubscriptions` path
and never marks a `<ul>`, so seed at least one row before the first render if
you need the markers. Row matching also requires every string-valued field of
a row to appear inside its `<li>`.

## Islands

The board is a hydrated React island; everything else is baked HTML that
silcrow owns. Island names must equal their file basename under `islands/`.

Live data reaches an island **only** through the store — declare the field
`target: 'store'` and read it with `useLiveValue(name, bakeTimeValue)`.
Silcrow never patches DOM inside `[data-kiln-island]`, so there is no other
channel. Pass the bake-time value as the fallback or SSR and the first client
render disagree. Object-valued store fields arrive as **real objects** on both
the patch and the snapshot path — no `JSON.parse`.

The board deliberately uses one object-valued field rather than `Live.list`:
the board renders divs, list markers only attach to rows the list machinery
can find, and list patches are dropped inside islands anyway. The tradeoff is
whole-board payloads instead of row-level diffs, which is fine at this scale.

`bun run build` runs `kiln build`, which bundles `islands/*` into
`dist/client` and writes the manifest that `/_kiln/islands.json` serves. The
manifest maps island *names* to hashed chunk URLs, so HTML baked last week
still hydrates against today's build.

## Auth architecture (short version)

- better-auth owns `/api/auth/*`, mounted as a **raw** route from
  `kiln.config.ts`'s `server.setup` via `adapter.registerRaw` (ADR-020). Raw
  means `hooks.ts` `handle` never runs for it — which is the point: you can't
  require a session on the endpoint that creates one.
- Login/logout are ordinary Kiln **actions** on `pages/login.tsx`. They set
  cookies through `res.cookies` (ADR-019); they used to be raw Elysia routes
  because actions had no response to touch.
- This app has no entry point of its own. `server.setup` is the whole reason —
  before it, one raw route cost an app the CLI, and with it Vite and islands.
- `hooks.ts` `handle` gates every route not on the public allowlist, including
  promoted pages and the `/__kiln/fsr` SSE endpoint.

## Two Kiln realities this app works around (see repo `.memory/bugs-active.md`)

- **Redis cache keys are not app-namespaced.** Two Kiln apps sharing one Redis
  logical DB collide on shared routes like `/`. Give each app its own DB index
  in `REDIS_URL` (this app uses `/3`).
- ~~**Absent `promote_after` is not pure SSR**~~ — RESOLVED by ADR-016 (bake
  classes): session-reading pages are classified pure SSR automatically, and
  the per-page `promote_after = false` workaround exports were removed.
  Guarded by `tests/purity.integration.test.ts` (`bun run test:purity`).
