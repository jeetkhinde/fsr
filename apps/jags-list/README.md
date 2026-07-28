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

## Live surfaces

| Route | Mechanism | Dep |
|---|---|---|
| `/projects/:id/activity` | `Live.list` on `events` | `activity` (explicit — required) |

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

## Auth architecture (short version)

- better-auth owns `/api/auth/*`; `POST /auth/login` / `/auth/logout` are raw
  Elysia form routes (Kiln actions can't set cookies — spec §9 gap 3).
- `hooks.ts onRequest` gates every route not on the public allowlist,
  including promoted pages and the `/__kiln/fsr` SSE endpoint.

## Two Kiln realities this app works around (see repo `.memory/bugs-active.md`)

- **Redis cache keys are not app-namespaced.** Two Kiln apps sharing one Redis
  logical DB collide on shared routes like `/`. Give each app its own DB index
  in `REDIS_URL` (this app uses `/3`).
- ~~**Absent `promote_after` is not pure SSR**~~ — RESOLVED by ADR-016 (bake
  classes): session-reading pages are classified pure SSR automatically, and
  the per-page `promote_after = false` workaround exports were removed.
  Guarded by `tests/purity.integration.test.ts` (`bun run test:purity`).
