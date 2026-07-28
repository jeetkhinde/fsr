# Jag's List — Active Work

App work log only. Framework state → repo root [`../../.memory/active-work.md`](../../.memory/active-work.md).

Last updated: 2026-07-28

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

**Dynamic-segment layouts are cached by route PATTERN, not concrete path.**
`packages/engine/src/cache.ts` `diskLayoutHtmlPath(pattern)` produces
`.kiln-cache/layouts/v3/projects/:id/shell.html` — one file for every project.
So `pages/projects/[id]/_layout.tsx`, which loads `projectById(req.params.id)`,
renders the FIRST-baked project's name and nav links on every other project's
board and activity pages. Page bodies are correct; only the chrome leaks.
Reproduced with AND without the Plan 3a change (control run), so it is not
caused by this work. Not fixed here — Plan 3a is scoped to no framework edits.

## Next

- **Plan 3b** (board island): dnd-kit kanban + the store-target `Live.list`
  gap (spec §9 gap 1). Spike the object-valued `LiveProp` + `target: 'store'`
  path first — it is unverified.
- **`/projects` restructure** (deferred from 3a): the page renders an
  admin-only Archive button off `me.role`, so it cannot be baked shared until
  that authorization boundary moves out of the baked shell.
- **Task detail live fields** — deferred to Plan 4: `/tasks/:id` is currently a
  bare edit form with no display text to patch. Live-patching form controls
  would wipe `<select>` options and stomp in-progress edits.
- **Plan 4** (unspecced): comments/mentions, notifications + bell island,
  search, subtasks, labels, My Tasks.
