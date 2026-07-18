# Jag's List — Plan 2 of 4: Projects, Columns & Tasks CRUD

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, JS-free kanban: create projects (auto-seeded with columns), add/edit/move tasks across columns, rename/add/delete columns, and see a per-project activity feed — all server-rendered with collocated form actions.

**Architecture:** Every route in this plan is **pure SSR** (`export const promote_after = false`) — correctness first; FSR promotion + `Live.list`/SSE and the dnd-kit board island come in Plan 3. All tables already exist (Plan 1 `migrations/0000_init.sql`); Plan 2 adds only application code: typed query modules per domain (`db/projects.ts`, `db/columns.ts`, `db/tasks.ts`), a fractional-ordering helper (`db/positions.ts`), an activity-logging helper (`lib/activity.ts`), and pages with collocated actions. Mutations are plain form POSTs that validate input, check role, write SQL, and log activity.

**Tech Stack:** Bun, Kiln (`@kiln/*`), Elysia, Postgres (`bun`'s `SQL`), React 19 (SSR only), better-auth sessions (Plan 1).

**Spec:** `apps/jags-list/docs/superpowers/specs/2026-07-14-jags-list-design.md` — read §5 (data model), §6 (routes/permissions), §10 (errors). This is plan 2 of 4.

**Depends on:** Plan 1 + the role model + the request-hook refactor — **all merged to `main`** (PRs #6–#10). Concretely:
- **Roles** (`lib/session.ts`): `superadmin`/`admin`/`user` with `requireUser`/`requireAdmin`/`requireSuperadmin`/`isAtLeastAdmin`.
- **⚠️ ADR-015 `req.locals` / `handle` hook (PR #9):** `requireUser`/`requireAdmin`/`requireSuperadmin` are now **synchronous** — the app's `handle` hook (`hooks.ts`) resolves the session once into `req.locals.user`, and these helpers read it. Call them **without `await`** (`const me = requireUser(req);`). All code in this plan already reflects this.

## Global Constraints

- App path: `apps/jags-list/`; run app commands from there. `.env` has `DATABASE_URL`, `REDIS_URL` (with a `/3` DB index), `PORT=3200`. From a fresh worktree, build framework packages first: `bun run --filter '@kiln/*' build` (repo root).
- **Every page in this plan is pure SSR** — `export const promote_after = false`. Omitting it inherits the global `fsr.promoteAfterHits` (2) and would promote per-team content prematurely (see repo-root `.memory/bugs-active.md` §1 "absent promote_after"; ADR-015 makes this a documented requirement). Plan 3 flips team-shared pages to `promote_after: 1` + live.
- **Permission model** (spec §6, using Plan 1/#8 helpers): all authenticated members may create projects and create/edit/move tasks and create/rename columns. **Admins only** (`requireAdmin`, which covers admin+superadmin) may archive projects and delete columns. No per-project permissions — every member sees every non-archived project.
- **Every mutation action** must, in order: (1) `requireUser(req)` (or `requireAdmin` for admin-only ops), (2) validate input via `db/validation.ts`, (3) write SQL via `bun` tagged templates (never string interpolation), (4) insert an `activity` row via `logActivity()`, (5) `throw AppError.redirect(path)`. `AppError.validation`/`AppError.notFound` on bad input / missing entities.
- **Activity verbs** (closed set, spec §5): `project.created`, `project.archived`, `column.created`, `column.renamed`, `column.deleted`, `task.created`, `task.moved`, `task.assigned`, `task.completed` (moved into a terminal column), `task.updated`. (`comment.added` is Plan 4.)
- **Fractional positions**: new items get `position` = (max existing + 1024) at the end, or the midpoint between neighbours on insert-between. Rebalance a column/list when any adjacent gap drops below `1e-6`. `double precision`.
- Priority: `0` none, `1` low, `2` med, `3` high. `due_date` is a `DATE` (nullable).
- React 19 SSR splits adjacent literal+expression text with `<!-- -->` markers — interpolate as one node (`{`@${handle}`}`) when exact text matters (Plan 1 lesson).
- Page option exports are snake_case (`promote_after`). Work on branch `feat/jags-list-crud` in its own worktree (create via the using-git-worktrees skill at execution start). Never commit to `main`.

## Prerequisites

- Plan 1 + role model + ADR-015 request-hook all merged to `main` (PRs #6–#10); `bun run db:migrate` applied (through `0002_roles.sql`). A superadmin exists (`bun run bootstrap-superadmin …`).
- No new SQL migration is required by this plan (all tables exist). If a data helper needs an index this plan adds it as a numbered migration (none currently needed).

## File map

```
apps/jags-list/
  db/
    positions.ts            # fractional ordering (new)
    positions.test.ts       # unit (new)
    projects.ts             # project queries (new)
    columns.ts              # column queries + seeding (new)
    tasks.ts                # task queries (new)
    validation.ts           # + project/task/column validators (modify)
    *.integration.test.ts   # per-domain DB integration (new)
  lib/
    activity.ts             # logActivity() + verb type (new)
  pages/
    projects/
      index.tsx             # list + create + archive (new)
      [id]/
        _layout.tsx         # project chrome + Board/Activity tabs (new)
        board.tsx           # columns + task cards + all board actions (new)
        activity.tsx        # activity feed (new)
    tasks/
      [id].tsx              # task detail + edit action (new)
  tests/
    crud.integration.test.ts # spawns app; end-to-end route + action checks (new)
```

---

### Task 1: Fractional ordering helper (`db/positions.ts`)

**Files:**
- Create: `apps/jags-list/db/positions.ts`
- Test: `apps/jags-list/db/positions.test.ts`

**Interfaces:**
- Produces: `positionAtEnd(positions: number[]): number` — next position after the current max (or `1024` when empty). `positionBetween(before: number | null, after: number | null): number` — midpoint; `before+1024` when `after` null, `after-1024` when `before` null, `1024` when both null. `needsRebalance(sorted: number[]): boolean` — true if any adjacent gap `< 1e-6`. `rebalance(count: number): number[]` — evenly spaced positions `1024, 2048, …` for `count` items.

- [ ] **Step 1: Write the failing test**

`apps/jags-list/db/positions.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { positionAtEnd, positionBetween, needsRebalance, rebalance } from './positions.js';

describe('fractional positions', () => {
  it('positionAtEnd returns 1024 for an empty column and max+1024 otherwise', () => {
    expect(positionAtEnd([])).toBe(1024);
    expect(positionAtEnd([1024])).toBe(2048);
    expect(positionAtEnd([1024, 3000, 2048])).toBe(4024); // max is 3000
  });

  it('positionBetween returns the midpoint, or an end offset when a side is null', () => {
    expect(positionBetween(1024, 2048)).toBe(1536);
    expect(positionBetween(null, 2048)).toBe(1024); // before the first
    expect(positionBetween(1024, null)).toBe(2048); // after the last
    expect(positionBetween(null, null)).toBe(1024); // empty
  });

  it('needsRebalance flags a collapsed gap', () => {
    expect(needsRebalance([1024, 2048, 3072])).toBe(false);
    expect(needsRebalance([1.0, 1.0000001])).toBe(true); // gap < 1e-6
    expect(needsRebalance([5])).toBe(false);
    expect(needsRebalance([])).toBe(false);
  });

  it('rebalance produces evenly spaced positions', () => {
    expect(rebalance(0)).toEqual([]);
    expect(rebalance(3)).toEqual([1024, 2048, 3072]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/jags-list/`): `bun test db/positions.test.ts`
Expected: FAIL — cannot resolve `./positions.js`.

- [ ] **Step 3: Implement `db/positions.ts`**

```ts
/** Fractional ordering: items carry a `double precision` position; inserting
 * between two neighbours takes their midpoint, so a move rewrites one row.
 * When midpoints collapse below EPSILON, the caller rebalances the group. */
const STEP = 1024;
const EPSILON = 1e-6;

export function positionAtEnd(positions: number[]): number {
  if (positions.length === 0) return STEP;
  return Math.max(...positions) + STEP;
}

export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return STEP;
  if (before === null) return after! - STEP;
  if (after === null) return before + STEP;
  return (before + after) / 2;
}

export function needsRebalance(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < EPSILON) return true;
  }
  return false;
}

export function rebalance(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * STEP);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test db/positions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/jags-list/db/positions.ts apps/jags-list/db/positions.test.ts
git commit -m "feat(jags-list): fractional ordering helper for columns and tasks"
```

---

### Task 2: Validation additions + activity helper

**Files:**
- Modify: `apps/jags-list/db/validation.ts`
- Create: `apps/jags-list/lib/activity.ts`
- Test: `apps/jags-list/db/validation.test.ts` (extend)
- Test: `apps/jags-list/lib/activity.integration.test.ts`

**Interfaces:**
- Consumes: `sql` (`db/client.ts`), `SessionUser` (`lib/session.ts`).
- Produces:
  - `validProjectName(v: string): boolean` (1–120 chars trimmed), `validTaskTitle(v: string): boolean` (1–200), `validColumnName(v: string): boolean` (1–60), `parsePriority(v: unknown): 0|1|2|3` (clamps/defaults 0), `parseDueDate(v: unknown): string | null` (accepts `YYYY-MM-DD` or empty → null).
  - `type ActivityVerb = 'project.created' | 'project.archived' | 'column.created' | 'column.renamed' | 'column.deleted' | 'task.created' | 'task.moved' | 'task.assigned' | 'task.completed' | 'task.updated'`.
  - `logActivity(input: { projectId: number; taskId?: number | null; actorId: string; verb: ActivityVerb; payload?: Record<string, unknown> }): Promise<void>`.

- [ ] **Step 1: Extend the validation unit test**

Append to `apps/jags-list/db/validation.test.ts`:

```ts
import { validProjectName, validTaskTitle, validColumnName, parsePriority, parseDueDate } from './validation.js';

describe('crud validation', () => {
  it('validates project name, task title, column name lengths', () => {
    expect(validProjectName('Roadmap')).toBe(true);
    expect(validProjectName('   ')).toBe(false);
    expect(validProjectName('x'.repeat(121))).toBe(false);
    expect(validTaskTitle('Ship it')).toBe(true);
    expect(validTaskTitle('')).toBe(false);
    expect(validColumnName('In Progress')).toBe(true);
    expect(validColumnName('x'.repeat(61))).toBe(false);
  });

  it('parsePriority clamps to 0..3 and defaults to 0', () => {
    expect(parsePriority('2')).toBe(2);
    expect(parsePriority('9')).toBe(0);
    expect(parsePriority(undefined)).toBe(0);
    expect(parsePriority('-1')).toBe(0);
  });

  it('parseDueDate accepts YYYY-MM-DD or empty', () => {
    expect(parseDueDate('2026-08-01')).toBe('2026-08-01');
    expect(parseDueDate('')).toBeNull();
    expect(parseDueDate('not-a-date')).toBeNull();
    expect(parseDueDate(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test db/validation.test.ts`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Add validators to `db/validation.ts`**

Append:

```ts
export function validProjectName(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= 120;
}

export function validTaskTitle(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= 200;
}

export function validColumnName(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= 60;
}

export function parsePriority(v: unknown): 0 | 1 | 2 | 3 {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function parseDueDate(v: unknown): string | null {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : v;
}
```

- [ ] **Step 4: Run validation test to pass**

Run: `bun test db/validation.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Write the activity integration test**

`apps/jags-list/lib/activity.integration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from '../db/client.js';
import { logActivity } from './activity.js';

describe.skipIf(!process.env.DATABASE_URL)('logActivity', () => {
  let projectId = 0;
  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql.close();
  });

  it('inserts an activity row with verb + jsonb payload', async () => {
    const [p] = await sql`INSERT INTO projects (name, created_by) VALUES ('act-itest', 'u1') RETURNING id`;
    projectId = p.id;
    await logActivity({ projectId, actorId: 'u1', verb: 'project.created', payload: { name: 'act-itest' } });
    const rows = await sql`SELECT verb, actor_id, payload FROM activity WHERE project_id = ${projectId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].verb).toBe('project.created');
    expect(rows[0].actor_id).toBe('u1');
    expect(rows[0].payload).toEqual({ name: 'act-itest' });
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun --env-file=.env test lib/activity.integration.test.ts`
Expected: FAIL — `./activity.js` missing.

- [ ] **Step 7: Implement `lib/activity.ts`**

```ts
import { sql } from '../db/client.js';

export type ActivityVerb =
  | 'project.created'
  | 'project.archived'
  | 'column.created'
  | 'column.renamed'
  | 'column.deleted'
  | 'task.created'
  | 'task.moved'
  | 'task.assigned'
  | 'task.completed'
  | 'task.updated';

/** Append a row to the activity feed. The AFTER INSERT trigger on `activity`
 * emits `activity:project_id=<pid>` (Plan 1 migration), so Plan 3's live feed
 * updates automatically — no extra work here. */
export async function logActivity(input: {
  projectId: number;
  taskId?: number | null;
  actorId: string;
  verb: ActivityVerb;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO activity (project_id, task_id, actor_id, verb, payload)
    VALUES (${input.projectId}, ${input.taskId ?? null}, ${input.actorId}, ${input.verb},
            ${JSON.stringify(input.payload ?? {})}::jsonb)`;
}
```

- [ ] **Step 8: Run activity test to pass**

Run: `bun --env-file=.env test lib/activity.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add apps/jags-list/db/validation.ts apps/jags-list/db/validation.test.ts apps/jags-list/lib/activity.ts apps/jags-list/lib/activity.integration.test.ts
git commit -m "feat(jags-list): crud validators + activity logging helper"
```

---

### Task 3: Project & column query modules (with column seeding)

**Files:**
- Create: `apps/jags-list/db/projects.ts`
- Create: `apps/jags-list/db/columns.ts`
- Test: `apps/jags-list/db/projects.integration.test.ts`

**Interfaces:**
- Consumes: `sql`, `positionAtEnd`/`positionBetween` (`db/positions.ts`).
- Produces:
  - `db/columns.ts`: `type Column = { id: number; project_id: number; name: string; position: number; is_terminal: boolean }`; `seedDefaultColumns(projectId: number): Promise<void>` (inserts Backlog@1024, In Progress@2048, Done@3072 with `is_terminal=true`); `listColumns(projectId: number): Promise<Column[]>` (ordered by position); `createColumn(projectId, name): Promise<Column>` (position at end); `renameColumn(id, name): Promise<void>`; `deleteColumn(id): Promise<void>`; `columnById(id): Promise<Column | null>`.
  - `db/projects.ts`: `type Project = { id: number; name: string; description: string; archived_at: Date | null; created_by: string }`; `listActiveProjects(): Promise<Array<Project & { open_task_count: number }>>`; `projectById(id): Promise<Project | null>`; `createProject(name, description, createdBy): Promise<Project>` (also calls `seedDefaultColumns`); `archiveProject(id): Promise<void>`.

- [ ] **Step 1: Write the failing integration test**

`apps/jags-list/db/projects.integration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from './client.js';
import { createProject, listActiveProjects, projectById, archiveProject } from './projects.js';
import { listColumns } from './columns.js';

describe.skipIf(!process.env.DATABASE_URL)('projects + columns', () => {
  let projectId = 0;
  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql.close();
  });

  it('createProject seeds Backlog / In Progress / Done (Done terminal)', async () => {
    const p = await createProject('proj-itest', 'desc', 'u1');
    projectId = p.id;
    const cols = await listColumns(projectId);
    expect(cols.map((c) => c.name)).toEqual(['Backlog', 'In Progress', 'Done']);
    expect(cols[2].is_terminal).toBe(true);
    expect(cols[0].is_terminal).toBe(false);
    expect(cols[0].position).toBeLessThan(cols[1].position);
  });

  it('listActiveProjects returns open task counts and hides archived', async () => {
    const before = await listActiveProjects();
    expect(before.find((p) => p.id === projectId)?.open_task_count).toBe(0);
    await archiveProject(projectId);
    const after = await listActiveProjects();
    expect(after.find((p) => p.id === projectId)).toBeUndefined();
    expect((await projectById(projectId))?.archived_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --env-file=.env test db/projects.integration.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `db/columns.ts`**

```ts
import { sql } from './client.js';
import { positionAtEnd } from './positions.js';

export interface Column {
  id: number;
  project_id: number;
  name: string;
  position: number;
  is_terminal: boolean;
}

export async function seedDefaultColumns(projectId: number): Promise<void> {
  await sql`
    INSERT INTO columns (project_id, name, position, is_terminal) VALUES
      (${projectId}, 'Backlog', 1024, false),
      (${projectId}, 'In Progress', 2048, false),
      (${projectId}, 'Done', 3072, true)`;
}

export async function listColumns(projectId: number): Promise<Column[]> {
  return (await sql`
    SELECT id, project_id, name, position, is_terminal
    FROM columns WHERE project_id = ${projectId} ORDER BY position ASC`) as Column[];
}

export async function columnById(id: number): Promise<Column | null> {
  const [c] = await sql`
    SELECT id, project_id, name, position, is_terminal FROM columns WHERE id = ${id}`;
  return (c as Column) ?? null;
}

export async function createColumn(projectId: number, name: string): Promise<Column> {
  const existing = await listColumns(projectId);
  const position = positionAtEnd(existing.map((c) => c.position));
  const [c] = await sql`
    INSERT INTO columns (project_id, name, position) VALUES (${projectId}, ${name}, ${position})
    RETURNING id, project_id, name, position, is_terminal`;
  return c as Column;
}

export async function renameColumn(id: number, name: string): Promise<void> {
  await sql`UPDATE columns SET name = ${name} WHERE id = ${id}`;
}

export async function deleteColumn(id: number): Promise<void> {
  await sql`DELETE FROM columns WHERE id = ${id}`;
}
```

- [ ] **Step 4: Implement `db/projects.ts`**

```ts
import { sql } from './client.js';
import { seedDefaultColumns } from './columns.js';

export interface Project {
  id: number;
  name: string;
  description: string;
  archived_at: Date | null;
  created_by: string;
}

export async function listActiveProjects(): Promise<Array<Project & { open_task_count: number }>> {
  // Open = task not in a terminal column. LEFT JOIN so empty projects show 0.
  return (await sql`
    SELECT p.id, p.name, p.description, p.archived_at, p.created_by,
           COUNT(t.id) FILTER (WHERE c.is_terminal = false)::int AS open_task_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    LEFT JOIN columns c ON c.id = t.column_id
    WHERE p.archived_at IS NULL
    GROUP BY p.id
    ORDER BY p.created_at DESC`) as Array<Project & { open_task_count: number }>;
}

export async function projectById(id: number): Promise<Project | null> {
  const [p] = await sql`
    SELECT id, name, description, archived_at, created_by FROM projects WHERE id = ${id}`;
  return (p as Project) ?? null;
}

export async function createProject(name: string, description: string, createdBy: string): Promise<Project> {
  const [p] = await sql`
    INSERT INTO projects (name, description, created_by) VALUES (${name}, ${description}, ${createdBy})
    RETURNING id, name, description, archived_at, created_by`;
  await seedDefaultColumns(p.id);
  return p as Project;
}

export async function archiveProject(id: number): Promise<void> {
  await sql`UPDATE projects SET archived_at = NOW() WHERE id = ${id}`;
}
```

- [ ] **Step 5: Run to pass**

Run: `bun --env-file=.env test db/projects.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/jags-list/db/columns.ts apps/jags-list/db/projects.ts apps/jags-list/db/projects.integration.test.ts
git commit -m "feat(jags-list): project + column query modules with default seeding"
```

---

### Task 4: Task query module

**Files:**
- Create: `apps/jags-list/db/tasks.ts`
- Test: `apps/jags-list/db/tasks.integration.test.ts`

**Interfaces:**
- Consumes: `sql`, `positionAtEnd`/`positionBetween`/`needsRebalance`/`rebalance` (`db/positions.ts`), `Column` (`db/columns.ts`).
- Produces: `type Task = { id: number; project_id: number; column_id: number; title: string; description: string; assignee_id: string | null; priority: 0|1|2|3; due_date: string | null; position: number; version: number; created_by: string }`; `listTasksByProject(projectId): Promise<Task[]>` (ordered column then position); `taskById(id): Promise<Task | null>`; `createTask(input: { projectId, columnId, title, createdBy }): Promise<Task>` (position at end of column); `updateTaskFields(id, fields: { title?; description?; assigneeId?: string | null; priority?: 0|1|2|3; dueDate?: string | null }): Promise<Task>` (bumps `version`); `moveTask(id, toColumnId, position): Promise<Task>` (bumps `version`); `positionForEndOfColumn(columnId): Promise<number>`.

- [ ] **Step 1: Write the failing integration test**

`apps/jags-list/db/tasks.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from './client.js';
import { createProject } from './projects.js';
import { listColumns } from './columns.js';
import { createTask, listTasksByProject, taskById, updateTaskFields, moveTask } from './tasks.js';

describe.skipIf(!process.env.DATABASE_URL)('tasks', () => {
  let projectId = 0;
  let cols: Awaited<ReturnType<typeof listColumns>> = [];
  beforeAll(async () => {
    const p = await createProject('tasks-itest', '', 'u1');
    projectId = p.id;
    cols = await listColumns(projectId);
  });
  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql.close();
  });

  it('createTask appends to the end of its column and starts at version 1', async () => {
    const a = await createTask({ projectId, columnId: cols[0].id, title: 'A', createdBy: 'u1' });
    const b = await createTask({ projectId, columnId: cols[0].id, title: 'B', createdBy: 'u1' });
    expect(a.version).toBe(1);
    expect(b.position).toBeGreaterThan(a.position);
    const all = await listTasksByProject(projectId);
    expect(all.map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('updateTaskFields sets fields and bumps version', async () => {
    const [t] = await listTasksByProject(projectId);
    const updated = await updateTaskFields(t.id, { assigneeId: 'u2', priority: 3, dueDate: '2026-09-01' });
    expect(updated.assignee_id).toBe('u2');
    expect(updated.priority).toBe(3);
    expect(updated.due_date).toBe('2026-09-01');
    expect(updated.version).toBe(t.version + 1);
  });

  it('moveTask changes column + position and bumps version', async () => {
    const [t] = await listTasksByProject(projectId);
    const moved = await moveTask(t.id, cols[1].id, 5000);
    expect(moved.column_id).toBe(cols[1].id);
    expect(moved.position).toBe(5000);
    expect(moved.version).toBe(t.version + 1);
    expect((await taskById(t.id))?.column_id).toBe(cols[1].id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --env-file=.env test db/tasks.integration.test.ts`
Expected: FAIL — `./tasks.js` missing.

- [ ] **Step 3: Implement `db/tasks.ts`**

```ts
import { sql } from './client.js';
import { positionAtEnd } from './positions.js';

export interface Task {
  id: number;
  project_id: number;
  column_id: number;
  title: string;
  description: string;
  assignee_id: string | null;
  priority: 0 | 1 | 2 | 3;
  due_date: string | null;
  position: number;
  version: number;
  created_by: string;
}

// NOTE: bun's SQL does not support embedding a `sql\`\`` fragment as a value
// (`${frag}` binds as a parameter, not raw SQL), so the column list is inlined
// per query. `due_date` is a DATE — emit it as an ISO string so Task.due_date
// is always `string | null`, never a Date.

export async function listTasksByProject(projectId: number): Promise<Task[]> {
  return (await sql`
    SELECT id, project_id, column_id, title, description, assignee_id, priority,
           to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by
    FROM tasks WHERE project_id = ${projectId}
    ORDER BY column_id ASC, position ASC`) as Task[];
}

export async function taskById(id: number): Promise<Task | null> {
  const [t] = await sql`
    SELECT id, project_id, column_id, title, description, assignee_id, priority,
           to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by
    FROM tasks WHERE id = ${id}`;
  return (t as Task) ?? null;
}

export async function positionForEndOfColumn(columnId: number): Promise<number> {
  const rows = await sql`SELECT position FROM tasks WHERE column_id = ${columnId}`;
  return positionAtEnd(rows.map((r: any) => r.position as number));
}

export async function createTask(input: {
  projectId: number;
  columnId: number;
  title: string;
  createdBy: string;
}): Promise<Task> {
  const position = await positionForEndOfColumn(input.columnId);
  const [t] = await sql`
    INSERT INTO tasks (project_id, column_id, title, position, created_by)
    VALUES (${input.projectId}, ${input.columnId}, ${input.title}, ${position}, ${input.createdBy})
    RETURNING id, project_id, column_id, title, description, assignee_id, priority,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return t as Task;
}

export async function updateTaskFields(
  id: number,
  fields: {
    title?: string;
    description?: string;
    assigneeId?: string | null;
    priority?: 0 | 1 | 2 | 3;
    dueDate?: string | null;
  },
): Promise<Task> {
  // COALESCE keeps the existing value when a field isn't supplied (undefined →
  // null bind → COALESCE falls through). assignee/due are explicitly nullable,
  // so they use a sentinel: pass the current row through when omitted.
  const current = await taskById(id);
  if (!current) throw new Error(`task ${id} not found`);
  const [t] = await sql`
    UPDATE tasks SET
      title = ${fields.title ?? current.title},
      description = ${fields.description ?? current.description},
      assignee_id = ${fields.assigneeId === undefined ? current.assignee_id : fields.assigneeId},
      priority = ${fields.priority ?? current.priority},
      due_date = ${fields.dueDate === undefined ? current.due_date : fields.dueDate},
      version = version + 1
    WHERE id = ${id}
    RETURNING id, project_id, column_id, title, description, assignee_id, priority,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return t as Task;
}

export async function moveTask(id: number, toColumnId: number, position: number): Promise<Task> {
  const [t] = await sql`
    UPDATE tasks SET column_id = ${toColumnId}, position = ${position}, version = version + 1
    WHERE id = ${id}
    RETURNING id, project_id, column_id, title, description, assignee_id, priority,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return t as Task;
}
```

- [ ] **Step 4: Run to pass**

Run: `bun --env-file=.env test db/tasks.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/jags-list/db/tasks.ts apps/jags-list/db/tasks.integration.test.ts
git commit -m "feat(jags-list): task query module (create/list/update/move, version bumps)"
```

---

### Task 5: Projects list page — list, create, archive

**Files:**
- Create: `apps/jags-list/pages/projects/index.tsx`
- Modify: `apps/jags-list/styles/app.css` (append board/list styles)
- Test: `apps/jags-list/tests/crud.integration.test.ts` (new; extended in later tasks)

**Interfaces:**
- Consumes: `requireUser`/`requireAdmin` (`lib/session.ts`), `listActiveProjects`/`createProject`/`archiveProject`/`projectById` (`db/projects.ts`), `validProjectName` (`db/validation.ts`), `logActivity` (`lib/activity.ts`), `AppError` (`@kiln/core`).
- Produces: route `/projects` with actions `?/create` (any member) and `?/archive` (admin only). Members see the list + create form; the archive control shows only for admins.

- [ ] **Step 1: Write the failing spawn test**

`apps/jags-list/tests/crud.integration.test.ts` (this harness is reused and extended by Tasks 6–7; it logs in a real member and admin and drives form POSTs):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../db/client.js';
import { createAppUser } from '../lib/auth.js';
import { auth } from '../lib/auth.js';

const PORT = 3298;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { email: 'crud-admin@example.com', password: 'password-123', handle: 'crudadmin' };
const MEMBER = { email: 'crud-member@example.com', password: 'password-123', handle: 'crudmember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let adminCookie = '';
let memberCookie = '';
const createdProjectIds: number[] = [];

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe.skipIf(!run)('crud routes', () => {
  beforeAll(async () => {
    for (const u of [ADMIN, MEMBER]) await sql`DELETE FROM "user" WHERE email = ${u.email}`;
    await createAppUser({ ...ADMIN, name: 'Crud Admin', role: 'admin' });
    await createAppUser({ ...MEMBER, name: 'Crud Member', role: 'user' });
    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit', stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(200);
    }
    adminCookie = await cookieFor(ADMIN.email, ADMIN.password);
    memberCookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    for (const id of createdProjectIds) await sql`DELETE FROM projects WHERE id = ${id}`;
    for (const u of [ADMIN, MEMBER]) await sql`DELETE FROM "user" WHERE email = ${u.email}`;
    await sql.close();
  });

  async function post(path: string, cookie: string, form: Record<string, string>) {
    return fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body: new URLSearchParams(form),
      redirect: 'manual',
    });
  }

  it('a member can create a project; it appears on /projects with a 0 open-task count', async () => {
    const res = await post('/projects?/create', memberCookie, { name: 'Q3 Roadmap', description: '' });
    expect(res.status).toBe(303);
    const [row] = await sql`SELECT id FROM projects WHERE name = 'Q3 Roadmap' ORDER BY id DESC LIMIT 1`;
    createdProjectIds.push(row.id);
    const list = await fetch(BASE + '/projects', { headers: { cookie: memberCookie } });
    const html = await list.text();
    expect(html).toContain('Q3 Roadmap');
  });

  it('rejects a blank project name with a validation redirect', async () => {
    const res = await post('/projects?/create', memberCookie, { name: '   ', description: '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/projects?error=name');
  });

  it('a member cannot archive; an admin can', async () => {
    const id = createdProjectIds[0];
    const denied = await post('/projects?/archive', memberCookie, { id: String(id) });
    expect(denied.status).toBe(401);
    const ok = await post('/projects?/archive', adminCookie, { id: String(id) });
    expect(ok.status).toBe(303);
    const [p] = await sql`SELECT archived_at FROM projects WHERE id = ${id}`;
    expect(p.archived_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --env-file=.env run test:app` won't cover this file yet; run it directly:
`RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts`
Expected: FAIL — `/projects` 404 (page missing) / assertions fail.

- [ ] **Step 3: Create `pages/projects/index.tsx`**

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireAdmin, requireUser } from '../../lib/session.js';
import { listActiveProjects, createProject, archiveProject, projectById } from '../../db/projects.js';
import { validProjectName } from '../../db/validation.js';
import { logActivity } from '../../lib/activity.js';

export const promote_after = false;

export async function load(req: KilnRequest) {
  const me = requireUser(req);
  const projects = await listActiveProjects();
  return { me, projects, error: req.query.error ?? null };
}

export const actions = {
  async create(req: KilnRequest) {
    const me = requireUser(req);
    const form = await req.formData();
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    if (!validProjectName(name)) throw AppError.redirect('/projects?error=name');
    const project = await createProject(name, description, me.id);
    await logActivity({ projectId: project.id, actorId: me.id, verb: 'project.created', payload: { name } });
    throw AppError.redirect(`/projects/${project.id}/board`);
  },

  async archive(req: KilnRequest) {
    const me = requireAdmin(req);
    const form = await req.formData();
    const id = Number(form.get('id'));
    const project = await projectById(id);
    if (!project) throw AppError.notFound('Project not found');
    await archiveProject(id);
    await logActivity({ projectId: id, actorId: me.id, verb: 'project.archived', payload: { name: project.name } });
    throw AppError.redirect('/projects');
  },
};

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  open_task_count: number;
}

export default function ProjectsPage({
  me,
  projects,
  error,
}: {
  me: { role: 'superadmin' | 'admin' | 'user' };
  projects: ProjectRow[];
  error: string | null;
}) {
  const isAdmin = me.role === 'admin' || me.role === 'superadmin';
  return (
    <section>
      <h1>Projects</h1>
      {error === 'name' && <p className="error">Enter a project name (1–120 characters).</p>}
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id} className="project-card">
            <a href={`/projects/${p.id}/board`}>
              <strong>{p.name}</strong>
            </a>
            <span className="muted">{`${p.open_task_count} open`}</span>
            {p.description && <p className="muted">{p.description}</p>}
            {isAdmin && (
              <form method="post" action="?/archive" className="inline-form">
                <input type="hidden" name="id" value={p.id} />
                <button type="submit" className="link-danger">Archive</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form method="post" action="?/create" className="create-form">
        <h2>New project</h2>
        <label>Name<input name="name" required maxLength={120} /></label>
        <label>Description<input name="description" maxLength={500} /></label>
        <button type="submit">Create project</button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Append list/board styles to `styles/app.css`**

```css
.project-list { list-style: none; padding: 0; display: grid; gap: 0.75rem; }
.project-card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1rem; }
.project-card a { color: var(--ink); text-decoration: none; }
.muted { color: var(--muted); font-size: 0.9rem; }
.inline-form { margin-left: auto; }
.link-danger { background: none; border: 0; color: var(--danger); cursor: pointer; padding: 0; }
.create-form, .task-form { display: grid; gap: 0.75rem; margin-top: 2rem; max-width: 32rem; }
.board { display: flex; gap: 1rem; align-items: flex-start; overflow-x: auto; padding-bottom: 1rem; }
.board-column { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.75rem; min-width: 16rem; flex: 0 0 auto; }
.board-column h3 { margin: 0 0 0.5rem; font-size: 0.95rem; }
.task-card { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 0.5rem 0.65rem; margin-bottom: 0.5rem; }
.task-card a { color: var(--ink); text-decoration: none; }
.prio-3 { border-left: 3px solid var(--danger); }
.prio-2 { border-left: 3px solid #c98a00; }
.tabs { display: flex; gap: 1rem; margin: 0.5rem 0 1.5rem; }
.tabs a { color: var(--muted); text-decoration: none; }
.tabs a.active { color: var(--accent); font-weight: 600; }
.activity-feed { list-style: none; padding: 0; display: grid; gap: 0.4rem; }
.activity-feed li { border-bottom: 1px solid var(--line); padding: 0.4rem 0; font-size: 0.9rem; }
```

- [ ] **Step 5: Run the spawn test to pass**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/jags-list/pages/projects/index.tsx apps/jags-list/styles/app.css apps/jags-list/tests/crud.integration.test.ts
git commit -m "feat(jags-list): projects list with create (member) and archive (admin)"
```

---

### Task 6: Board page — columns + tasks + all board actions

**Files:**
- Create: `apps/jags-list/pages/projects/[id]/_layout.tsx`
- Create: `apps/jags-list/pages/projects/[id]/board.tsx`
- Test: `apps/jags-list/tests/crud.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `requireUser`/`requireAdmin`, `projectById`, `listColumns`/`createColumn`/`renameColumn`/`deleteColumn`/`columnById`, `listTasksByProject`/`createTask`/`moveTask`, `positionForEndOfColumn` (`db/tasks.ts`), `validColumnName`/`validTaskTitle`, `logActivity`.
- Produces: route `/projects/:id/board`; a project `_layout` with Board/Activity tabs; board actions `?/createTask` & `?/createColumn` & `?/renameColumn` (members) and `?/deleteColumn` (admin), `?/moveTask` (member; form-based in Plan 2). Terminal-column moves log `task.completed`.

- [ ] **Step 1: Extend the spawn test**

Append inside the `describe` in `tests/crud.integration.test.ts` (after the archive test):

```ts
  it('board shows seeded columns; a member adds a task that lands in Backlog', async () => {
    const create = await post('/projects?/create', memberCookie, { name: 'Board Proj', description: '' });
    expect(create.status).toBe(303);
    const [proj] = await sql`SELECT id FROM projects WHERE name = 'Board Proj' ORDER BY id DESC LIMIT 1`;
    createdProjectIds.push(proj.id);

    const board = await (await fetch(`${BASE}/projects/${proj.id}/board`, { headers: { cookie: memberCookie } })).text();
    expect(board).toContain('Backlog');
    expect(board).toContain('In Progress');
    expect(board).toContain('Done');

    const [backlog] = await sql`SELECT id FROM columns WHERE project_id = ${proj.id} AND name = 'Backlog'`;
    const add = await post(`/projects/${proj.id}/board?/createTask`, memberCookie, {
      column_id: String(backlog.id), title: 'First task',
    });
    expect(add.status).toBe(303);
    const [task] = await sql`SELECT id, column_id FROM tasks WHERE title = 'First task'`;
    expect(task.column_id).toBe(backlog.id);
  });

  it('moving a task into the terminal column logs task.completed', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const [task] = await sql`SELECT id FROM tasks WHERE title = 'First task'`;
    const [done] = await sql`SELECT id FROM columns WHERE project_id = ${proj} AND name = 'Done'`;
    const res = await post(`/projects/${proj}/board?/moveTask`, memberCookie, {
      task_id: String(task.id), column_id: String(done.id),
    });
    expect(res.status).toBe(303);
    const [moved] = await sql`SELECT column_id FROM tasks WHERE id = ${task.id}`;
    expect(moved.column_id).toBe(done.id);
    const acts = await sql`SELECT verb FROM activity WHERE project_id = ${proj} AND verb = 'task.completed'`;
    expect(acts.length).toBeGreaterThanOrEqual(1);
  });

  it('only an admin can delete a column', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const [col] = await sql`
      INSERT INTO columns (project_id, name, position) VALUES (${proj}, 'Scratch', 9000) RETURNING id`;
    const denied = await post(`/projects/${proj}/board?/deleteColumn`, memberCookie, { column_id: String(col.id) });
    expect(denied.status).toBe(401);
    const ok = await post(`/projects/${proj}/board?/deleteColumn`, adminCookie, { column_id: String(col.id) });
    expect(ok.status).toBe(303);
    expect(await sql`SELECT id FROM columns WHERE id = ${col.id}`).toHaveLength(0);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts`
Expected: FAIL — board route 404.

- [ ] **Step 3: Create the project `_layout.tsx`**

`apps/jags-list/pages/projects/[id]/_layout.tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { projectById } from '../../../db/projects.js';

// Pure SSR chrome for a single project. Reads only its own :id param (ADR-011
// scoping rule); no per-user data here.
export const promote_after = false;

export async function load(req: KilnRequest) {
  const project = await projectById(Number(req.params.id));
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  return { project };
}

export default function ProjectLayout({
  project,
  children,
}: {
  project: { id: number; name: string };
  children: React.ReactNode;
}) {
  const base = `/projects/${project.id}`;
  return (
    <section>
      <h1>{project.name}</h1>
      <nav className="tabs">
        <a href={`${base}/board`}>Board</a>
        <a href={`${base}/activity`}>Activity</a>
      </nav>
      {children}
    </section>
  );
}
```

- [ ] **Step 4: Create `board.tsx`**

`apps/jags-list/pages/projects/[id]/board.tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireAdmin, requireUser } from '../../../lib/session.js';
import { projectById } from '../../../db/projects.js';
import { listColumns, createColumn, renameColumn, deleteColumn, columnById } from '../../../db/columns.js';
import { listTasksByProject, createTask, moveTask, positionForEndOfColumn, taskById } from '../../../db/tasks.js';
import { validColumnName, validTaskTitle } from '../../../db/validation.js';
import { logActivity } from '../../../lib/activity.js';

export const promote_after = false;

export async function load(req: KilnRequest) {
  requireUser(req);
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const columns = await listColumns(projectId);
  const tasks = await listTasksByProject(projectId);
  return { projectId, columns, tasks, error: req.query.error ?? null };
}

async function requireProjectId(req: KilnRequest): Promise<number> {
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  return projectId;
}

export const actions = {
  async createTask(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const form = await req.formData();
    const columnId = Number(form.get('column_id'));
    const title = String(form.get('title') ?? '').trim();
    const column = await columnById(columnId);
    if (!column || column.project_id !== projectId) throw AppError.notFound('Column not found');
    if (!validTaskTitle(title)) throw AppError.redirect(`/projects/${projectId}/board?error=title`);
    const task = await createTask({ projectId, columnId, title, createdBy: me.id });
    await logActivity({ projectId, taskId: task.id, actorId: me.id, verb: 'task.created', payload: { title } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async moveTask(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const form = await req.formData();
    const taskId = Number(form.get('task_id'));
    const toColumnId = Number(form.get('column_id'));
    const task = await taskById(taskId);
    const target = await columnById(toColumnId);
    if (!task || task.project_id !== projectId) throw AppError.notFound('Task not found');
    if (!target || target.project_id !== projectId) throw AppError.notFound('Column not found');
    const position = await positionForEndOfColumn(toColumnId);
    await moveTask(taskId, toColumnId, position);
    await logActivity({ projectId, taskId, actorId: me.id, verb: 'task.moved', payload: { to: target.name } });
    if (target.is_terminal) {
      await logActivity({ projectId, taskId, actorId: me.id, verb: 'task.completed', payload: { title: task.title } });
    }
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async createColumn(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const name = String((await req.formData()).get('name') ?? '').trim();
    if (!validColumnName(name)) throw AppError.redirect(`/projects/${projectId}/board?error=column`);
    const column = await createColumn(projectId, name);
    await logActivity({ projectId, actorId: me.id, verb: 'column.created', payload: { name } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async renameColumn(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const form = await req.formData();
    const columnId = Number(form.get('column_id'));
    const name = String(form.get('name') ?? '').trim();
    const column = await columnById(columnId);
    if (!column || column.project_id !== projectId) throw AppError.notFound('Column not found');
    if (!validColumnName(name)) throw AppError.redirect(`/projects/${projectId}/board?error=column`);
    await renameColumn(columnId, name);
    await logActivity({ projectId, actorId: me.id, verb: 'column.renamed', payload: { name } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async deleteColumn(req: KilnRequest) {
    const me = requireAdmin(req);
    const projectId = await requireProjectId(req);
    const columnId = Number((await req.formData()).get('column_id'));
    const column = await columnById(columnId);
    if (!column || column.project_id !== projectId) throw AppError.notFound('Column not found');
    await deleteColumn(columnId); // tasks reference columns ON DELETE RESTRICT — deleting a non-empty column errors; UI only offers it on empty ones
    await logActivity({ projectId, actorId: me.id, verb: 'column.deleted', payload: { name: column.name } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },
};

interface Col { id: number; name: string; is_terminal: boolean }
interface T { id: number; column_id: number; title: string; priority: number; assignee_id: string | null }

export default function BoardPage({
  projectId,
  columns,
  tasks,
  error,
}: {
  projectId: number;
  columns: Col[];
  tasks: T[];
  error: string | null;
}) {
  const byColumn = (cid: number) => tasks.filter((t) => t.column_id === cid);
  return (
    <>
      {error === 'title' && <p className="error">Enter a task title.</p>}
      {error === 'column' && <p className="error">Enter a column name (1–60 characters).</p>}
      <div className="board">
        {columns.map((col) => (
          <div key={col.id} className="board-column">
            <h3>{col.name}</h3>
            {byColumn(col.id).map((t) => (
              <div key={t.id} className={`task-card prio-${t.priority}`}>
                <a href={`/tasks/${t.id}`}>{t.title}</a>
                {/* JS-free move: pick a destination column and submit. */}
                <form method="post" action="?/moveTask" className="inline-form">
                  <input type="hidden" name="task_id" value={t.id} />
                  <select name="column_id" defaultValue={col.id} aria-label="Move to column">
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <button type="submit">Move</button>
                </form>
              </div>
            ))}
            <form method="post" action="?/createTask" className="inline-form">
              <input type="hidden" name="column_id" value={col.id} />
              <input name="title" placeholder="New task" required maxLength={200} />
              <button type="submit">Add</button>
            </form>
          </div>
        ))}
      </div>
      <form method="post" action="?/createColumn" className="create-form">
        <h2>Add column</h2>
        <label>Name<input name="name" required maxLength={60} /></label>
        <button type="submit">Add column</button>
      </form>
    </>
  );
}
```

- [ ] **Step 5: Run the spawn test to pass**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts`
Expected: PASS (6 tests — 3 from Task 5 + 3 new).

- [ ] **Step 6: Commit**

```bash
git add apps/jags-list/pages/projects
git commit -m "feat(jags-list): kanban board — columns, tasks, JS-free create/move/rename/delete"
```

---

### Task 7: Task detail + edit, and the activity feed page

**Files:**
- Create: `apps/jags-list/pages/tasks/[id].tsx`
- Create: `apps/jags-list/pages/projects/[id]/activity.tsx`
- Create: `apps/jags-list/db/members.ts` (assignee dropdown source)
- Test: `apps/jags-list/tests/crud.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `requireUser`, `taskById`/`updateTaskFields`, `projectById`, `parsePriority`/`parseDueDate`/`validTaskTitle`, `logActivity`.
- Produces: `db/members.ts` → `listMembers(): Promise<Array<{ id: string; name: string; handle: string | null }>>`. Route `/tasks/:id` with action `?/update` (title/description/assignee/priority/due; logs `task.assigned` when assignee changes, else `task.updated`). Route `/projects/:id/activity` (feed, newest first).

- [ ] **Step 1: Extend the spawn test**

Append inside the `describe`:

```ts
  it('editing a task assignee logs task.assigned and updates the row', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const [task] = await sql`SELECT id FROM tasks WHERE title = 'First task'`;
    const [member] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    const res = await post(`/tasks/${task.id}?/update`, memberCookie, {
      title: 'First task', description: 'now with detail', assignee_id: member.id, priority: '3', due_date: '2026-10-01',
    });
    expect(res.status).toBe(303);
    const [row] = await sql`SELECT assignee_id, priority, description FROM tasks WHERE id = ${task.id}`;
    expect(row.assignee_id).toBe(member.id);
    expect(row.priority).toBe(3);
    expect(row.description).toBe('now with detail');
    const assigned = await sql`SELECT verb FROM activity WHERE task_id = ${task.id} AND verb = 'task.assigned'`;
    expect(assigned.length).toBeGreaterThanOrEqual(1);
  });

  it('the activity feed lists recent events newest-first', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const html = await (await fetch(`${BASE}/projects/${proj}/activity`, { headers: { cookie: memberCookie } })).text();
    expect(html).toContain('task.created');
    expect(html).toContain('task.completed');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts`
Expected: FAIL — `/tasks/:id` 404.

- [ ] **Step 3: Create `db/members.ts`**

```ts
import { sql } from './client.js';

export async function listMembers(): Promise<Array<{ id: string; name: string; handle: string | null }>> {
  return (await sql`SELECT id, name, handle FROM "user" ORDER BY name ASC`) as Array<{
    id: string;
    name: string;
    handle: string | null;
  }>;
}
```

- [ ] **Step 4: Create `pages/tasks/[id].tsx`**

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireUser } from '../../lib/session.js';
import { taskById, updateTaskFields } from '../../db/tasks.js';
import { projectById } from '../../db/projects.js';
import { listMembers } from '../../db/members.js';
import { validTaskTitle, parsePriority, parseDueDate } from '../../db/validation.js';
import { logActivity } from '../../lib/activity.js';

export const promote_after = false;

export async function load(req: KilnRequest) {
  requireUser(req);
  const task = await taskById(Number(req.params.id));
  if (!task) throw AppError.notFound('Task not found');
  const project = await projectById(task.project_id);
  const members = await listMembers();
  return { task, projectName: project?.name ?? '', members, error: req.query.error ?? null };
}

export const actions = {
  async update(req: KilnRequest) {
    const me = requireUser(req);
    const task = await taskById(Number(req.params.id));
    if (!task) throw AppError.notFound('Task not found');
    const form = await req.formData();
    const title = String(form.get('title') ?? '').trim();
    if (!validTaskTitle(title)) throw AppError.redirect(`/tasks/${task.id}?error=title`);
    const description = String(form.get('description') ?? '').trim();
    const rawAssignee = String(form.get('assignee_id') ?? '');
    const assigneeId = rawAssignee === '' ? null : rawAssignee;
    const priority = parsePriority(form.get('priority'));
    const dueDate = parseDueDate(form.get('due_date'));

    await updateTaskFields(task.id, { title, description, assigneeId, priority, dueDate });
    const assigneeChanged = (task.assignee_id ?? '') !== (assigneeId ?? '');
    await logActivity({
      projectId: task.project_id,
      taskId: task.id,
      actorId: me.id,
      verb: assigneeChanged ? 'task.assigned' : 'task.updated',
      payload: assigneeChanged ? { assignee_id: assigneeId } : { title },
    });
    throw AppError.redirect(`/tasks/${task.id}`);
  },
};

interface Member { id: string; name: string; handle: string | null }
interface TaskT {
  id: number; project_id: number; title: string; description: string;
  assignee_id: string | null; priority: number; due_date: string | null;
}

export default function TaskDetail({
  task,
  projectName,
  members,
  error,
}: {
  task: TaskT;
  projectName: string;
  members: Member[];
  error: string | null;
}) {
  return (
    <section>
      <p className="muted">
        <a href={`/projects/${task.project_id}/board`}>{`← ${projectName}`}</a>
      </p>
      {error === 'title' && <p className="error">Enter a task title.</p>}
      <form method="post" action="?/update" className="task-form">
        <label>Title<input name="title" defaultValue={task.title} required maxLength={200} /></label>
        <label>Description<textarea name="description" defaultValue={task.description} rows={5} /></label>
        <label>
          Assignee
          <select name="assignee_id" defaultValue={task.assignee_id ?? ''}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select name="priority" defaultValue={String(task.priority)}>
            <option value="0">None</option>
            <option value="1">Low</option>
            <option value="2">Medium</option>
            <option value="3">High</option>
          </select>
        </label>
        <label>Due date<input type="date" name="due_date" defaultValue={task.due_date ?? ''} /></label>
        <button type="submit">Save</button>
      </form>
    </section>
  );
}
```

- [ ] **Step 5: Create `pages/projects/[id]/activity.tsx`**

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireUser } from '../../../lib/session.js';
import { projectById } from '../../../db/projects.js';
import { sql } from '../../../db/client.js';

export const promote_after = false;

interface ActivityRow {
  id: number;
  actor_name: string | null;
  verb: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function load(req: KilnRequest) {
  requireUser(req);
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const events = (await sql`
    SELECT a.id, u.name AS actor_name, a.verb, a.payload,
           to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
    FROM activity a
    LEFT JOIN "user" u ON u.id = a.actor_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100`) as ActivityRow[];
  return { events };
}

export default function ActivityPage({ events }: { events: ActivityRow[] }) {
  return (
    <ul className="activity-feed">
      {events.map((e) => (
        <li key={e.id}>
          <span className="muted">{e.created_at}</span> · {e.actor_name ?? 'someone'} ·{' '}
          <strong>{e.verb}</strong>
          {typeof e.payload?.name === 'string' && ` — ${e.payload.name}`}
          {typeof e.payload?.title === 'string' && ` — ${e.payload.title}`}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Run the spawn test to pass**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/jags-list/pages/tasks apps/jags-list/pages/projects/[id]/activity.tsx apps/jags-list/db/members.ts apps/jags-list/tests/crud.integration.test.ts
git commit -m "feat(jags-list): task detail + edit and per-project activity feed"
```

---

### Task 8: Wire nav, README, full verification

**Files:**
- Modify: `apps/jags-list/pages/_layout.tsx` (Projects link already present; confirm)
- Modify: `apps/jags-list/pages/index.tsx` (link home → /projects)
- Modify: `apps/jags-list/README.md`
- Modify: `apps/jags-list/package.json` (add crud tests to `test:db`)

**Interfaces:**
- Consumes: everything above.
- Produces: a documented, fully verified CRUD slice.

- [ ] **Step 1: Point the home page at Projects**

In `apps/jags-list/pages/index.tsx`, change the body copy line to link to the board list:

```tsx
      <p>
        <a href="/projects">Go to your projects</a>. My Tasks lands here in a later milestone.
      </p>
```

- [ ] **Step 2: Add the new DB tests to `test:db`**

In `apps/jags-list/package.json`, replace the `test:db` script value with:

```
bun --env-file=.env test db/schema.integration.test.ts && bun --env-file=.env test lib/auth.integration.test.ts && bun --env-file=.env test db/invites.integration.test.ts && bun --env-file=.env test lib/activity.integration.test.ts && bun --env-file=.env test db/projects.integration.test.ts && bun --env-file=.env test db/tasks.integration.test.ts
```

And update `test` to include positions:

```
bun test tests/smoke.test.ts db/validation.test.ts lib/roles.test.ts db/positions.test.ts
```

Add a `test:crud` script:

```
"test:crud": "RUN_APP_TESTS=1 bun --env-file=.env test tests/crud.integration.test.ts"
```

- [ ] **Step 3: Update the README**

Add a "Projects & tasks" section to `apps/jags-list/README.md` after the Roles section:

```markdown
## Projects, columns & tasks

- **/projects** — every member sees all active projects. Any member creates a
  project (auto-seeded with Backlog / In Progress / Done). Admins archive.
- **/projects/:id/board** — kanban. Add tasks to a column, move a task via the
  per-card column picker (JS-free), add/rename columns; admins delete empty
  columns. Moving a task into a terminal column ("Done") logs completion.
- **/tasks/:id** — edit title, description, assignee, priority, due date.
- **/projects/:id/activity** — the project's event feed, newest first.

All pages are server-rendered (`promote_after = false`). FSR promotion + live
updates and the drag-and-drop board island arrive in Plan 3.
```

- [ ] **Step 4: Full verification sequence**

Run (from `apps/jags-list/`, `.env` present, packages built):

```bash
bun run build          # tsc --noEmit — expect: no errors
bun run test           # unit: smoke, validation, roles, positions
bun run test:db        # all DB integration tiers
bun run test:crud      # spawns app; projects/board/task/activity end-to-end
```

Expected: all PASS. Then boot `bun --env-file=.env src/main.ts` and walk it once in a browser: sign in → **Projects** → create a project → board shows 3 columns → add a task → open the task, set assignee/priority/due → back to board, move it to Done → **Activity** shows `task.created`, `task.moved`, `task.completed`. Confirm a JS-disabled reload still creates/moves via form posts.

- [ ] **Step 5: Commit**

```bash
git add apps/jags-list/pages/index.tsx apps/jags-list/package.json apps/jags-list/README.md
git commit -m "docs(jags-list): wire projects nav, document CRUD, add crud test scripts"
```

---

## Post-plan notes for the executor

- **Terminal-column completion is logged, not enforced** — a task moved out of Done and back logs `task.completed` again. That's fine for an activity feed; if Plan 4 adds completion *state*, revisit.
- **`deleteColumn` relies on `ON DELETE RESTRICT`** — deleting a column with tasks throws a DB error surfaced as a 500. The board only offers delete on empty columns; a friendlier guard (count check → validation redirect) is a reasonable small follow-up if it bites.
- **No new Kiln findings expected** — this plan is pure app CRUD on existing primitives. If one surfaces, log an app issue in `apps/jags-list/.memory/bugs-active.md`, or — if it's a genuine framework defect — the repo-root `.memory/bugs-active.md` (spec §9 discipline).
- **Next:** Plan 3 flips the team-shared routes (`/projects`, board, task detail, activity) to `promote_after: 1` + `Live.list`/`LiveProp`, and adds the dnd-kit board island — where the predicted framework gaps (store-target `Live.list`, per-user live fields) get exercised.
