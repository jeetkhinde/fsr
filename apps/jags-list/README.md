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

## Inviting teammates

Sign in as an admin or superadmin → **Team** → create an invite (role: admin or
user — never superadmin) → share `/invite/<token>`. Public sign-up is disabled;
invites are the only way in.

## Tests

    bun run test                                          # unit, no infra
    bun run test:db                                       # needs Postgres
    bun run test:app                                      # spawns the app; needs Postgres + Redis

## Auth architecture (short version)

- better-auth owns `/api/auth/*`; `POST /auth/login` / `/auth/logout` are raw
  Elysia form routes (Kiln actions can't set cookies — spec §9 gap 3).
- `hooks.ts onRequest` gates every route not on the public allowlist,
  including promoted pages and the `/__kiln/fsr` SSE endpoint.

## Two Kiln realities this app works around (see repo `.memory/bugs.md`)

- **Redis cache keys are not app-namespaced.** Two Kiln apps sharing one Redis
  logical DB collide on shared routes like `/`. Give each app its own DB index
  in `REDIS_URL` (this app uses `/3`).
- **Absent `promote_after` is not pure SSR** — it inherits the global
  `fsr.promoteAfterHits` (2) and would promote per-user content into a shared
  cache. Every per-user / per-request page here exports
  `export const promote_after = false`.
