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

## Auth / rendering note (in use)

RESOLVED (ADR-016, 2026-07-19): the bake classifier now keeps session-reading
pages pure SSR automatically; the per-page `promote_after = false` workaround
exports were removed. Previously this worked around the absent-`promote_after`
defect (ADR-015); the framework bug entry it used to cite is gone from
[`../../.memory/bugs-active.md`](../../.memory/bugs-active.md) now that it's fixed.

## Next

- **Plan 3** (team-shared routes go live — not yet specced/written, only
  Plans 1-2 exist under `docs/superpowers/plans/`): promote board/activity
  pages to shared FSR bake, wire `Live.list`/`LiveProp` SSE, add the dnd-kit
  kanban board island. Watch for two predicted framework gaps: store-target
  `Live.list` for the board island, and per-user live fields on otherwise-
  shared pages.
- **Plan 4** (unspecced): comments/mentions, notifications + bell island,
  search, subtasks, labels, My Tasks.
