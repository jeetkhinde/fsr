# Jag's List

Small-team project management on Kiln — the framework's flagship dogfood app.
Spec: `docs/superpowers/specs/2026-07-14-jags-list-design.md`.

## Setup

Requires local Postgres and Redis.

    createdb jagslist
    cp .env.example .env       # set DATABASE_URL, BETTER_AUTH_SECRET, and a Redis DB index
    bun install                # from the repo root
    bun run auth:migrate       # better-auth tables (user/session/account/verification)
    bun run db:migrate         # app tables + pg_notify triggers + role model
    bun run bootstrap-superadmin -- you@example.com <password> "Your Name" <handle>
    bun run dev                # http://localhost:3200

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
