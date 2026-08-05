# Jag's List — Active Work

App work log only. Framework state → repo root [`../../.memory/active-work.md`](../../.memory/active-work.md).

Last updated: 2026-08-05

## Current State

- **Plan 1 (foundation + auth)** shipped as PR #6 — better-auth (FSR + SSR),
  invite-only access, session gating; 20 E2E tests pass.
- **Plan 2 (CRUD)** shipped (code on main via PR #7-11 mid-July; plan doc
  itself landed later as PR #23, `b67c85a`, 2026-07-28 — a docs-only catch-up
  merge, not new app code). Delivered: `db/{projects,columns,tasks,members}.ts`
  with fractional ordering, `lib/activity.ts`, `pages/projects` (list +
  `[id]/board` + `[id]/activity`), `pages/tasks/[id].tsx`. Members create
  projects/tasks/columns; admins archive projects/delete columns. Board is
  JS-free SSR (create/move/rename/delete via form actions) — no drag-drop
  island yet.
- **Bake-classes dogfooding (ad hoc, ahead of app Plan 3)**: `pages/index.tsx`
  now uses `bake = 'user'` (ADR-017) with an identity hook in `hooks.ts` and
  `createKilnSql` auto-deps (`db/client.ts`) for per-user cached home +
  cross-user isolation E2E. This is framework dogfood work, not app Plan 3.
- **Plan 3a (live wiring — activity feed)** shipped on branch
  `worktree-jags-list-03a-live-wiring`; plan at
  `docs/superpowers/plans/2026-07-28-jags-list-03a-live-wiring.md`.
  `/projects/:id/activity` dropped its gate-only `requireUser` (the gate lives
  in `hooks.ts`), so it now bakes, and its `events` prop is a `Live.list` with
  explicit `dependsOn: 'activity'`. New suites: `test:gate`, `test:live`.
  **This closed the framework's highest-value test gap** — ADR-018 auto-deps
  is now proven end-to-end through a real page, not just at the
  capture/trigger/watcher layer.

- **CLI migration (2026-08-05)**: the app no longer owns an entry point.
  `src/main.ts` is deleted; better-auth's `/api/auth/*` and the `app.css`
  asset are mounted from `kiln.config.ts`'s `server.setup` (ADR-020), and
  `dev`/`start`/`build` are the CLI. Integration suites boot `kiln start` via
  `tests/spawn-app.ts`, so CLI boot is covered by the app's own tests. This is
  what unlocked islands — see below.
- **Plan 3b (board island) shipped 2026-08-05.** `/projects/:id/board` now
  bakes (dropped its gate-only `requireUser` and both `req.query.error`
  reads; the banner is filled client-side from `location.search`). Whole-board
  state ships as one object-valued `Live.value` with `target: 'store'` and
  deps `['tasks','columns']`, read in `islands/BoardIsland.tsx` via
  `useLiveValue`. dnd-kit drag-drop with optimistic moves; `moveTask` takes an
  optional `expectedVersion` and the action answers a real **409**
  (`AppError.conflict`) on a stale one. The JS-free move/create forms stay
  below the island and `test:crud` guards them. New suite: `test:board` (9).
  **Two framework bugs fell out of this** — see below.

## Framework bugs this app found (both fixed 2026-08-05)

Filed in the repo-root [`../../.memory/bugs-active.md`](../../.memory/bugs-active.md) § 1; noted
here because the app is the reason they were found.

1. **Pages with scalar live fields never served their baked artifact.**
   `hasRegisteredRoute` scanned live *lists* only, so an island-fed page
   re-rendered on every request forever. Surfaced because a board test
   asserted two requests return the identical artifact and dnd-kit stamps a
   per-render counter. Affected `test-app/pages/islands-demo.tsx` too.
2. **`kiln build` bundled page modules for the browser**, so it failed on the
   first page importing server-only code — i.e. on any real app. jags-list
   was the first app to run it.

## Auth / rendering note (in use)

RESOLVED (ADR-016, 2026-07-19): the bake classifier now keeps session-reading
pages pure SSR automatically; the per-page `promote_after = false` workaround
exports were removed. Previously this worked around the absent-`promote_after`
defect (ADR-015); the framework bug entry it used to cite is gone from
[`../../.memory/bugs-active.md`](../../.memory/bugs-active.md) now that it's fixed.

## Two live-wiring rules (learned the hard way in Plan 3a)

1. **`Live.list` gets NO auto-deps** — always pass `dependsOn`. Only scalar
   `LiveProp` unions observed tables. Verified by falsification: deleting
   `dependsOn` makes `test:live` fail on a 20s timeout.
2. **A live page's `load()` must not call `requireUser` or read `req.query`.**
   The watcher re-runs loaders with empty locals, so `requireUser` throws on
   refresh; any identity read also blocks baking, and the demotion latches for
   the process lifetime.

## Known bug found during Plan 3a (PRE-EXISTING, filed separately)

~~**Dynamic-segment layouts are cached by route PATTERN, not concrete path.**
`packages/engine/src/cache.ts` `diskLayoutHtmlPath(pattern)` produces
`.kiln-cache/layouts/v3/projects/:id/shell.html` — one file for every project.
So `pages/projects/[id]/_layout.tsx`, which loads `projectById(req.params.id)`,
renders the FIRST-baked project's name and nav links on every other project's
board and activity pages. Page bodies are correct; only the chrome leaks.
Reproduced with AND without the Plan 3a change (control run), so it is not
caused by this work.~~ — **FIXED by PR #27** (framework repo root
`.memory/decisions.md` § ADR-011 "own-params amendment", 2026-07-28). The
layout cache key now includes the layout's own params
(`…:<pattern>|<instance-token>`), so `/projects/7/*` and `/projects/8/*` bake
separately. This entry sat here as open for a while after the fix landed —
left visible, struck through, rather than deleted, so it isn't re-filed.

## Next

- **`/projects` restructure** (deferred from 3a): the page renders an
  admin-only Archive button off `me.role`, so it cannot be baked shared until
  that authorization boundary moves out of the baked shell.
- **Task detail live fields** — deferred to Plan 4: `/tasks/:id` is currently a
  bare edit form with no display text to patch. Live-patching form controls
  would wipe `<select>` options and stomp in-progress edits.
- **Plan 4** (unspecced): comments/mentions, notifications + bell island,
  search, subtasks, labels, My Tasks.
