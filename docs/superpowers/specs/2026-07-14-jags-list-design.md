# Jag's List — Design Spec (v1)

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Owner:** Jagjeet
**App location:** `apps/jags-list/` (this monorepo, consuming `packages/*` via workspace deps)

## 1. What it is

Jag's List is a small-team project management tool and Kiln's flagship dogfood app. One team per deployment. Auth, users, projects, kanban boards with drag-and-drop, tasks (due dates, priority, labels, subtasks), comments with @mentions, per-user notifications, activity feeds, and full-text search — all built on Kiln primitives: FSR-promoted pages, `Live.list`/`LiveProp` SSE patches, React islands, collocated actions, and `json_first` endpoints.

A second, explicit goal: surface Kiln gaps by building a real authed multi-user app on it. Two gaps are already predicted (§9); each becomes its own framework PR when hit.

### Non-goals (v1)

File attachments, email notifications, multi-workspace/tenancy, offline/PWA, i18n, mobile apps, public/anonymous access, per-project permissions (all members see all projects).

## 2. Stack and new dependencies

Existing stack: Bun, Elysia (via `@kiln/adapter-elysia`), Postgres, Redis, React (islands only).

New third-party dependencies — the complete list:

| Dependency | Why | Scope |
|---|---|---|
| `better-auth` | Auth: email+password, sessions, its own migrated schema | Server + `/api/auth/*` |
| `pg` (or better-auth's Kysely dialect) | better-auth requires a supported DB driver; app queries stay on `bun-sql` | better-auth internals only |
| `@dnd-kit/core` + `@dnd-kit/sortable` | Accessible drag-and-drop for the kanban board | Board island chunk only |
| `marked` | Markdown → HTML for task descriptions and comments | Server-side only |
| `sanitize-html` | Sanitize rendered markdown before it enters baked HTML | Server-side only |

Everything else (validation, sessions gating, mentions parsing, fractional ordering, search) is hand-rolled or Kiln/Postgres-native.

## 3. Architecture

`apps/jags-list/src/main.ts` mirrors `examples/address-book/src/main.ts`: the app owns the `ElysiaAdapter`, `FsrStore`, `FsrWatcher`, `RedisCache`, and `startDbNotificationPipeline`, then calls `startKiln()`. Single unified process in v1 (no web/backend split). Production boot requires reachable Postgres and Redis, same check as address-book.

**Registration order (load-bearing):**

1. `adapter.app.mount('/api/auth', auth.handler)` — better-auth's fetch handler, mounted **before** `startKiln()`. Elysia hooks only apply to routes registered after them, so auth endpoints are public by construction.
2. `startKiln(adapter, config, './pages', { fsr: true, store, watcher, redis })` — applies middleware + `hooks.ts`, then registers all pages, actions, SSE, and assets. Everything Kiln registers is therefore session-gated by `onRequest`, **including promoted-cache serves and the `/__kiln/fsr` SSE endpoint** (verified: `startKiln()` applies `applyServerHooks` before any `registerPage`).

One Postgres database: better-auth tables (managed by `@better-auth/cli migrate`) + app tables (managed by our own SQL migrations in `apps/jags-list/migrations/`, applied by `scripts/migrate.ts`) + `kiln_fsr`.

### App file layout

```
apps/jags-list/
  pages/            # routes (see §6)
  islands/          # Board.tsx, NotificationBell.tsx
  db/               # client.ts (bun-sql), queries per domain, validation
  lib/              # auth.ts (better-auth instance), markdown.ts, mentions.ts, positions.ts
  migrations/       # numbered .sql files incl. triggers
  scripts/          # migrate.ts, bootstrap-admin.ts
  hooks.ts          # onRequest session gate
  kiln.config.ts
  src/main.ts
  styles/
  tests/            # unit, db integration, e2e (Playwright)
```

## 4. Auth and sessions

- **better-auth**, email + password only. Open sign-up **disabled**.
- User fields via better-auth `additionalFields`: `role: 'admin' | 'member'` and `handle` (unique, lowercase, set at sign-up/invite) — `handle` is what `@mentions` resolve against.
- **Bootstrap:** `scripts/bootstrap-admin.ts` creates the first admin (email + password args) via better-auth's server API.
- **Invites:** admins create invite tokens (app `invites` table: token, email, role, expires_at, used_at). `/invite/:token` (public) renders a sign-up form; its action verifies the token, calls better-auth's sign-up server API, stamps `used_at`. Invalid/expired/used token → 404.
- **Session gate** in `hooks.ts onRequest`: call `auth.api.getSession({ headers })`. Attach the session user to the request context for pages/actions. Unauthenticated: redirect page requests to `/login`, return 401 JSON for JSON requests.
- **Public path allowlist** (no session required): `/login`, `/invite/:token`, `/_silcrow/*`, `/_kiln/*`, `/assets/*`, `/favicon.ico`. `/api/auth/*` is public by mount order, not by allowlist. The SSE endpoint `/__kiln/fsr` is deliberately **not** on the allowlist — it carries team data and stays session-gated.
- **Permission rule (complete):** admins may create invites, archive/delete projects, and delete columns. Members may do everything else — including all task/comment/label/subtask operations and deleting their own comments. There are no per-project permissions in v1.

## 5. Data model

better-auth owns `user`, `session`, `account`, `verification`. App tables reference `user.id` (text). All app tables get `created_at`/`updated_at` and an `AFTER INSERT/UPDATE/DELETE` trigger emitting `pg_notify('kiln_invalidate', …)` with the dependency keys listed in §7.

| Table | Columns (beyond id/timestamps) |
|---|---|
| `projects` | name, description, archived_at, created_by |
| `columns` | project_id FK, name, position (double precision), is_terminal (bool — "counts as done") |
| `tasks` | project_id FK, column_id FK, title, description (markdown source), assignee_id, priority (0=none 1=low 2=med 3=high), due_date (date), created_by, position (double precision — midpoint insertion, rebalance when adjacent gap < 1e-6), version (int, bumped every update), search (generated tsvector over title + description, GIN index) |
| `labels` | name, color (workspace-global) |
| `task_labels` | task_id, label_id (PK pair) |
| `subtasks` | task_id FK, title, done (bool), position |
| `comments` | task_id FK, author_id, body (markdown source) |
| `activity` | project_id, task_id nullable, actor_id, verb, payload jsonb |
| `notifications` | user_id, actor_id, type ('assigned' \| 'mentioned' \| 'commented'), task_id, read_at nullable |
| `invites` | token (unique), email, role, expires_at, used_at nullable, created_by |

Deleting a project cascades columns/tasks/subtasks/comments/activity. New projects are seeded with columns Backlog / In Progress / Done (Done: `is_terminal = true`).

**Activity verbs (closed set for v1):** `project.created`, `project.archived`, `column.created`, `column.renamed`, `task.created`, `task.moved`, `task.assigned`, `task.completed` (moved into a terminal column), `task.updated`, `comment.added`.

**Notification rules** (never notify the actor about their own action): task assigned → notify assignee; @mention in a comment or description → notify mentioned user; comment on a task → notify assignee and task creator.

### Markdown pipeline

DB stores raw markdown. Rendering is server-side only: `marked` → `sanitize-html` (allowlist: p, a, strong, em, code, pre, ul/ol/li, blockquote, h1–h4) in the presentation layer before HTML enters a bake or SSR render. @mentions (`@handle`) are linkified during rendering; mention *extraction* for notifications happens at action time against known user handles. No client-side markdown parsing ever.

## 6. Routes and rendering strategy (split-surface)

The core architectural idea: an authed team tool splits into **team-shared surfaces** (identical HTML for every member → safe to bake and share) and **per-user surfaces** (never cached).

### Team-shared — `promote_after: 1`, live via SSE

| Route | Content | Live mechanism |
|---|---|---|
| `/projects` | Project cards with open-task counts | `Live.list` on projects |
| `/projects/:id/board` | Kanban: columns + task cards | Board island (§8) + live task list |
| `/tasks/:id` | Task detail: description, subtasks, labels, comments, comment form | `Live.list` (subtasks, comments), `LiveProp` scalars (title, assignee, column); comment form = plain collocated action, no island |
| `/projects/:id/activity` | Activity feed, newest first | `Live.list` on activity |

### Per-user — no `promote_after` (pure SSR)

| Route | Content |
|---|---|
| `/` | My Tasks: assigned to me, not in a terminal column, bucketed Overdue / Today / This week / Later / No date |
| `/notifications` | Notification list + mark-read / mark-all-read actions |
| `/search?q=` | Postgres FTS: `websearch_to_tsquery` over `tasks.search`, ranked, linking to `/tasks/:id` |
| `/api/me/unread-count` | `json_first: true`; unread notification count (feeds the bell island) |

### Public (SSR)

`/login`, `/invite/:token`.

### Layout

One root `_layout.tsx`: top nav (logo, project switcher, search box, notification bell island, user menu). Pattern-cached per ADR-011 — so its `load()` reads no per-user data; the bell is an island that fetches its own count (§9 gap 2). Project-scoped `_layout.tsx` under `/projects/:id/*` adds project name + tab nav (Board / Activity).

**Mutations:** every write is a collocated action on the page that renders it (`?/createTask`, `?/moveTask`, `?/renameColumn`, `?/addComment`, `?/toggleSubtask`, `?/markRead`, …). All work as plain form POSTs (JS-free baseline); islands call the same endpoints via fetch for optimistic UX. Every action validates input (shared `db/validation.ts`), checks the session user's membership/role, writes SQL, inserts `activity`, and creates `notifications` where §5 rules apply. Redirect-after-POST via `AppError.redirect`.

## 7. Live collaboration flow

```
action SQL write → table trigger → pg_notify('kiln_invalidate', dep keys)
  → startDbNotificationPipeline → FsrWatcher → Redis pub/sub → SSE hub
  → silcrow: DOM patch (shared pages) / store publish (islands)
```

Dependency key conventions:

| Data | Keys emitted |
|---|---|
| tasks | `tasks:project_id=<pid>`, `tasks:id=<tid>` |
| columns | `columns:project_id=<pid>` |
| comments/subtasks | `comments:task_id=<tid>` / `subtasks:task_id=<tid>` |
| projects | `projects:all`, `projects:id=<pid>` |
| activity | `activity:project_id=<pid>` |
| notifications | `notifications:user_id=<uid>` (consumed today only by SSR pages; see §9 gap 2) |

**Kanban move:** the board island applies the move optimistically, POSTs `?/moveTask` (task_id, column_id, position, expected version). Server validates version (409 on conflict → island refetches board JSON via content negotiation), writes, bumps version. The trigger broadcasts a `Live.list` diff; other clients' boards update through the store; the originating client reconciles by task version (its optimistic state already matches — the diff is a no-op).

## 8. Islands (the only client-side React)

| Island | Hydrate | Job |
|---|---|---|
| `Board` | `load` | dnd-kit columns/cards, optimistic moves, live list subscription |
| `NotificationBell` | `idle` | Unread count badge; fetches `/api/me/unread-count` after hydration and on silcrow navigation events; links to `/notifications` |

Island rules apply (ADR-014): props are bake-time JSON, live data via `target: 'store'` + `useLiveValue`, silcrow owns navigation, no nested islands. Everything else on every page is baked HTML patched by silcrow.

## 9. Predicted Kiln gaps (framework improvement backlog)

Building this app is expected to hit these; each becomes its own Kiln issue/PR when confirmed:

1. **Store-target `Live.list`.** Islands consume live data through Silcrow store atoms, but store publishing is documented for scalar `LiveProp`s only. The board island needs live *list* diffs in the store. If unsupported, extend the list-broadcast path to publish diffs to `live:<field>` atoms.
2. **Per-user live fields on shared pages.** A promoted page's SSE fields are fixed at bake time, so a shared shell can't carry `notifications:user_id=<me>` deps. v1 works around it (bell fetch-on-hydrate + refetch on navigation); the framework fix is user/session-scoped SSE channels.
3. **(Watch list)** `cache_key` variants don't support live updates (documented); auth-varying pages avoid `cache_key` in this design, but if we ever want per-user cached pages, this gap is next.

## 10. Error handling and permissions

- `_error.tsx` and `_not-found.tsx` at app root; task/project pages throw `AppError.notFound()` for missing/archived-and-hidden entities.
- Actions: `AppError.validation()` on bad input; `AppError.unauthorized()` when role checks fail; version-conflict on `moveTask` returns 409 JSON for the island, standard error page for form posts.
- All queries parameterized via `bun-sql` tagged templates. Rendered markdown sanitized (§5). Kiln's CSRF middleware covers form actions; better-auth covers its own endpoints.

## 11. Testing

- **Unit (bun test):** validation, `positions.ts` (midpoint + rebalance), `mentions.ts` extraction, markdown sanitization allowlist.
- **DB integration:** actions against a real Postgres — writes, activity records, notification fan-out, trigger `pg_notify` payloads (the psql `LISTEN` drill from address-book).
- **E2E (Playwright):** login + invite flow; create project → board CRUD; **two-browser live drill** (A drags a card, B's board updates without reload; A comments, B's task page appends it); JS-disabled degradation (board renders read-only, forms still mutate); unauthenticated access redirects.
- **Framework regression:** any Kiln change made for §9 lands with its own tests in the relevant package, verified in both `kiln dev` and `kiln start` (islands lesson from ADR-014).

## 12. Build order (sketch — the implementation plan will detail this)

1. Scaffold `apps/jags-list`, config, DB client, migrations + triggers, boot.
2. better-auth integration: mount, `hooks.ts` gate, bootstrap script, login page, invites.
3. Projects + columns + tasks CRUD as plain baked pages with actions (no islands yet).
4. Live wiring: `Live.list` on projects/board/task detail/activity.
5. Board island with dnd-kit (hits gap #1 → Kiln PR if confirmed).
6. Comments, mentions, notifications, bell island, My Tasks.
7. Search, labels, subtasks, polish, e2e suite.
