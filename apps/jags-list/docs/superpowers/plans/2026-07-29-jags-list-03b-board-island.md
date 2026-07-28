# Jag's List Plan 3b — Board Island (dnd-kit + store-target live state)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kanban board a hydrated React island with dnd-kit drag-drop and optimistic moves, whose live state arrives through the Silcrow store — so two members watching the same board see each other's moves without a reload.

**Architecture:** The board's whole task/column state is delivered as a **single object-valued `LiveProp` with `target: 'store'`**, read inside the island via `useLiveValue`. This deliberately bypasses `Live.list` entirely — see "Why not Live.list" below. Getting islands to work at all in this app requires replicating the CLI's client-asset serving inside its custom entry point, which is the riskiest task here.

**Tech Stack:** Kiln (`@kiln/core`, `@kiln/react`, `@kiln/routekit`, `@kiln/cli`), React 19, `@dnd-kit/core` + `@dnd-kit/sortable`, Vite (via `kiln build`), Bun `SQL`, Postgres LISTEN/NOTIFY, Redis, bun:test.

## Global Constraints

- **No framework package changes.** If a task appears to need one, stop and report.
- **JS-free baseline must survive.** The board's existing form-POST create/move/rename/delete keeps working with JS disabled; the island is additive. `tests/crud.integration.test.ts` exercises the JS-free path and must stay green.
- **Do not run `redis-cli FLUSHDB`** if another session may be working in a sibling worktree — Redis DB 3 is shared. Use fresh project ids for isolation instead.
- **Ports 3294–3299 are taken** (gate/live/freshness/purity/crud/app). New suites here use 3292 and 3293.
- **Verify with a build.** Root `bun run build` is mandatory; `tsc --noEmit` does not catch client-bundle breakage — and this plan is almost entirely client-bundle work.
- **Worktree discipline.** `cd` explicitly in every Bash call; cwd resets between turns.
- Plan 3a's two rules still apply: `Live.list` needs explicit `dependsOn`; a live page's `load()` must not call `requireUser` or read `req.query`.

---

## Critical background (read before Task 1)

Verified against source 2026-07-28/29.

**1. jags-list has NO client build pipeline.** Its scripts are `"dev": "bun --watch src/main.ts"` and `"build": "tsc --noEmit"`. There is no `vite.config.*`, no `islands/` directory, and `@kiln/react` is not a dependency. `test-app` — the only working island precedent — uses `"dev": "kiln dev"` / `"build": "kiln build"` instead.

**2. jags-list cannot simply adopt `kiln dev` / `kiln start`.** Those commands construct their own `ElysiaAdapter` and call `startKiln` themselves (`packages/cli/src/cli.ts`); they never load the app's `src/main.ts`. jags-list's entry mounts better-auth's `/api/auth/*` plus the raw `POST /auth/login` and `/auth/logout` Elysia routes, which exist because Kiln actions cannot set cookies (spec §9 gap 3). Switching to `kiln start` would delete authentication from the app.

*The seam that makes this work anyway:* `startKiln(adapter, config, pagesDir, { islandsManifestUrl })` already accepts a manifest URL — that is exactly how `kiln dev` points islands at Vite. And `kiln start` serves island chunks from `dist/client` under `/_kiln/client/*` in about twenty lines. So the app can keep its own entry, use `kiln build` purely as a *build* step, and replicate that static-serving block. **This is unproven in this app and is Task 2's whole job.**

**3. Islands are discovered by directory scan.** `listIslands(path.join(process.cwd(), 'islands'))` — an island's `name` must equal its file basename under `islands/`. The build keys chunks and the manifest by that name.

**4. Island contract (ADR-014).** Props are bake-time JSON via the seed codec. Live data reaches an island **only** through the store: declare the field `target: 'store'` and read it with `useLiveValue(field, fallback)`. Silcrow never patches DOM inside `[data-kiln-island]`. Pass the bake-time value as the `useLiveValue` fallback so SSR and first client render match. Working reference: `test-app/pages/islands-demo.tsx` + `test-app/islands/Counter.tsx`.

**5. Object-valued store fields arrive as objects, not strings.** Verified on both delivery paths: the live patch carries the raw value (`createWatcherPatch` → `createScalarPatch` → `toLegacySlotPatch` → `_publishLive`), and `fsrSnapshotHandler` reads the baked JSON snapshot (or re-executes the query), both yielding real objects. The `JSON.stringify` at `packages/engine/src/watcher.ts:591` populates only the Redis slot hash, which the client never reads. **No `JSON.parse` in the island.**

**6. `moveTask` has no optimistic-concurrency check.** `db/tasks.ts` `moveTask(id, toColumnId, position)` unconditionally bumps `version`. The `?/moveTask` action does not compare an expected version. That is new work (Task 3).

**7. A conflict CANNOT be signalled as 409 — use 422.** Spec §7 asks for a 409, but two things block it and neither is worth a framework change here. `AppError`'s `type` is a closed union — `'NotFound' | 'Unauthorized' | 'Forbidden' | 'Validation' | 'Internal' | 'Redirect'` — with no conflict member, so `new AppError('Conflict', …, 409)` does not typecheck. And actions are invoked as `actions[name](req)` with no `res` (spec §9 gap 3), so an action cannot set a status directly either. Task 3 therefore signals conflicts with `AppError.validation` (**422**), and the island treats any non-ok response as "someone moved it first" — which is all it actually needs. Getting a true 409 would require adding a conflict type to `@kiln/core`; that is a separate framework PR, not this plan.

**8. The board page carries both Plan 3a blockers.** `pages/projects/[id]/board.tsx` `load()` calls gate-only `requireUser(req)` (return discarded) and reads `req.query.error` twice. It cannot bake today. Task 1 fixes both.

### Why not `Live.list`

The board renders `div.board > div.board-column > div.task-card` — **no `<ul>`/`<li>` anywhere**. `applyLiveListMarkers` locates rows by scanning for `<li>` inside the nearest preceding `<ul>`/`<ol>`, so it cannot mark this markup at all, entirely independent of islands. On top of that, `_patchList` early-returns when the list is inside an island and never publishes to the store, and `LiveListOptions` has no `target` field.

So `Live.list` would need framework work at three layers (API, marker, client) to serve this board. The single object-valued store field needs none. The tradeoff accepted here is whole-board payloads instead of row-level diffs — fine at this app's scale, and revisitable if a board ever grows large enough to care.

---

## Scope decisions

**In:** board page bakes; island asset pipeline for a custom-entry app; optimistic-concurrency `moveTask`; store-target board state; dnd-kit island; two-client live drill.

**Out:** `/projects` role-shell restructure (still deferred — renders an admin-only Archive button off `me.role`). Task-detail live fields (Plan 4, needs the display view). Notification bell (Plan 4). Row-level list diffs for the board (would need the framework work described above).

**Natural split point:** Task 2 is infrastructure with real unknowns, and it produces independently valuable, testable software (a trivial island hydrating in jags-list). If it proves harder than expected — particularly if `kiln build` cannot be run without adopting `kiln start` — **stop there and ship Tasks 1–2 as their own PR**, then re-plan the rest. Do not let a stuck pipeline task block the board work indefinitely; report instead.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `pages/projects/[id]/board.tsx` | Modify | Drop gate-only `requireUser`; remove both `req.query.error` reads; later, store-target board state + island mount |
| `islands/BoardIsland.tsx` | Create | dnd-kit board; reads live state via `useLiveValue`; optimistic moves + conflict reconciliation |
| `islands/HelloIsland.tsx` | Create | Trivial island proving the pipeline (Task 2); deleted in Task 6 |
| `src/main.ts` | Modify | Serve `/_kiln/client/*` from `dist/client`; pass `islandsManifestUrl` to `startKiln` |
| `db/tasks.ts` | Modify | `moveTask` gains an `expectedVersion` parameter and returns null on mismatch |
| `pages/projects/[id]/board.tsx` (actions) | Modify | `?/moveTask` validates expected version; 422 on conflict |
| `package.json` | Modify | Add `@kiln/react`, `@dnd-kit/*`; add `build:client`, `test:board` scripts |
| `tests/island.integration.test.ts` | Create | Island hydration + asset serving (Task 2) |
| `tests/board.integration.test.ts` | Create | Version conflict → 422; store-field markers; two-client live drill |
| `README.md`, `.memory/active-work.md` | Modify | Document the island pipeline and the store-target pattern |

---

### Task 1: Board page bakes (drop identity + query reads)

**Files:**
- Modify: `pages/projects/[id]/board.tsx`
- Create: `tests/board.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `handle` from `hooks.ts`; `createAppUser`/`auth` from `lib/auth.js`
- Produces: `/projects/:id/board` renders with an identity-free, query-free `load()`; artifact under `.kiln-cache/projects/<id>/board/`

- [ ] **Step 1: Write the failing test**

Create `tests/board.integration.test.ts`:

```ts
// Plan 3b Task 1: the board page must bake, which means load() reads neither
// identity (req.locals) nor req.query — both mark the render impure, and
// under ADR-016 'auto' the demotion LATCHES for the process lifetime.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { auth, createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

const PORT = 3292;
const BASE = `http://localhost:${PORT}`;
const MEMBER = { email: 'board-member@example.com', password: 'password-123', handle: 'boardmember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let projectId = 0;
let columnId = 0;
let taskId = 0;
let memberId = '';
let cookie = '';

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe.skipIf(!run)('board page — bakeable, versioned moves, live state', () => {
  beforeAll(async () => {
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await createAppUser({
      email: MEMBER.email, password: MEMBER.password,
      name: 'Board Member', role: 'user', handle: MEMBER.handle,
    });
    const [u] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    memberId = u.id;

    const [p] = await sql`INSERT INTO projects (name, description, created_by)
      VALUES ('Board Island Project', '', ${memberId}) RETURNING id::int`;
    projectId = p.id;
    const [c] = await sql`INSERT INTO columns (project_id, name, position)
      VALUES (${projectId}, 'Todo', 1000) RETURNING id::int`;
    columnId = c.id;
    const [t] = await sql`INSERT INTO tasks (project_id, column_id, title, position, created_by)
      VALUES (${projectId}, ${columnId}, 'Drag me', 1000, ${memberId}) RETURNING id::int`;
    taskId = t.id;

    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT) } as Record<string, string>,
      stdout: 'inherit', stderr: 'inherit',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(100);
    }
    cookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await sql.close();
  });

  it('still gates anonymous access to the board', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/board`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('serves an identical artifact with and without ?error', async () => {
    const plain = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    const withErr = await (await fetch(`${BASE}/projects/${projectId}/board?error=title`,
      { headers: { cookie } })).text();
    expect(withErr).toBe(plain);
    expect(plain).toContain('data-form-error');
  });
});
```

Add to `package.json` scripts:

```json
"test:board": "RUN_APP_TESTS=1 bun --env-file=.env test tests/board.integration.test.ts",
"test:island": "RUN_APP_TESTS=1 bun --env-file=.env test tests/island.integration.test.ts"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/jags-list && bun run test:board
```

Expected: the `?error` case FAILS — the two responses differ because `load()` branches on `req.query.error`.

- [ ] **Step 3: Remove the identity and query reads**

In `pages/projects/[id]/board.tsx`, change `load()` and drop `requireUser` from the import (keep `requireAdmin` — the actions still use it):

```tsx
export async function load(req: KilnRequest) {
  // No requireUser and no req.query read: hooks.ts `handle` gates this route,
  // the watcher re-runs loaders with empty locals, and either read marks the
  // render impure — which under 'auto' latches the demotion for the whole
  // process. The validation banner is rendered client-side instead.
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const columns = await listColumns(projectId);
  const tasks = await listTasksByProject(projectId);
  return { projectId, columns, tasks };
}
```

Leave every action untouched — `requireUser` inside an action is correct; actions run on real requests with real locals.

- [ ] **Step 4: Render the banner client-side**

Replace the two `error === '…'` conditionals with one always-present container plus an inline script, and drop `error` from the component's props type and signature:

```tsx
      <p className="error" data-form-error hidden />
      <script
        dangerouslySetInnerHTML={{
          __html:
            "(function(){var e=new URLSearchParams(location.search).get('error');" +
            "if(!e)return;var n=document.querySelector('[data-form-error]');if(!n)return;" +
            "n.textContent=e==='title'?'Enter a task title.':" +
            "e==='column'?'Enter a column name (1-60 characters).':'Could not save your changes.';" +
            "n.hidden=false;})();",
        }}
      />
```

Tradeoff, stated plainly: with JS disabled the banner no longer appears. The forms still work and still reject bad input. This is the narrowest degradation that keeps one shared artifact.

- [ ] **Step 5: Run to verify it passes**

```bash
cd apps/jags-list && bun run test:board && bun run test:crud
```

Expected: both PASS. `test:crud` matters — it drives the JS-free board flow that still redirects with `?error=`.

- [ ] **Step 6: Verify the board bakes**

```bash
cd apps/jags-list && rm -rf .kiln-cache && bun run test:board && find .kiln-cache/projects -name "*.html" | grep board
```

Expected: a baked `board/index.html`. Nothing means the route is still demoted — check the server log for the ADR-016 warning.

- [ ] **Step 7: Commit**

```bash
git add 'pages/projects/[id]/board.tsx' tests/board.integration.test.ts package.json
git commit -m "feat(jags-list): board page bakes — gate via hooks.ts, client-side validation banner"
```

---

### Task 2: Island asset pipeline in a custom-entry app (RISKIEST)

This task exists because jags-list owns its `src/main.ts` for auth and therefore cannot adopt `kiln start`. It proves a trivial island hydrates before any dnd-kit work depends on it.

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `islands/HelloIsland.tsx`
- Modify: `src/main.ts`
- Modify: `pages/projects/[id]/board.tsx` (temporary mount)
- Create: `tests/island.integration.test.ts`

**Interfaces:**
- Consumes: `island` from `@kiln/react`; `kiln build`'s `dist/client` output + islands manifest
- Produces: `/_kiln/client/*` served by the app; `startKiln` receiving `islandsManifestUrl`; a hydrating island

- [ ] **Step 1: Add dependencies**

```bash
cd apps/jags-list && bun add @kiln/react@workspace:* && bun add @dnd-kit/core @dnd-kit/sortable
```

If the dnd-kit install fails (no network), **stop and report** — Tasks 5 onward need it, but Tasks 2–4 do not, so the pipeline work can still proceed while that is resolved.

- [ ] **Step 2: Create the trivial island**

`islands/HelloIsland.tsx` — the filename basename is the island name, which is how the manifest keys its chunk:

```tsx
import React, { useState } from 'react';
import { useLiveValue } from '@kiln/react';

/**
 * Temporary pipeline probe (Plan 3b Task 2). Proves three things at once:
 * the chunk is built and served, hydration runs, and a store-target live
 * field reaches the island. Deleted in Task 6.
 */
export default function HelloIsland({ seed }: { seed: number }) {
  const [n, setN] = useState(seed);
  const live = useLiveValue<number>('pipelineProbe', seed);
  return (
    <div data-island-alive="1">
      <button type="button" onClick={() => setN(n + 1)}>clicked {n}</button>
      <span data-live-probe>{String(live)}</span>
    </div>
  );
}
```

- [ ] **Step 3: Mount it temporarily on the board page**

At the top of `pages/projects/[id]/board.tsx`:

```tsx
import { island } from '@kiln/react';
import HelloIsland from '../../../islands/HelloIsland.js';

const Hello = island(HelloIsland, 'HelloIsland');
```

In `load()`'s return, add a store-target probe field:

```tsx
    pipelineProbe: Live.value<number>(Date.now() % 1000, ['tasks'], { target: 'store' }),
```

(Add `Live` to the `@kiln/core` import.) In the component, render `<Hello seed={1} />` just inside the fragment, and accept `pipelineProbe` in props without rendering it directly — it reaches the island through the store.

- [ ] **Step 4: Write the failing pipeline test**

`tests/island.integration.test.ts` — same harness shape as Task 1 (port 3293, own seeded user and project; copy the `beforeAll`/`afterAll`/`cookieFor` structure verbatim from `tests/board.integration.test.ts`, changing `PORT` to `3293` and `MEMBER.email` to `island-member@example.com`). The cases:

```ts
  it('serves the island chunk referenced by the manifest', async () => {
    const html = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    // The island marker must be in the baked HTML.
    expect(html).toContain('data-kiln-island="HelloIsland"');
    // And the client bootstrap must be able to resolve its chunk.
    const manifest = await fetch(`${BASE}/_kiln/client/kiln-islands.json`);
    expect(manifest.status).toBe(200);
    const entries = await manifest.json();
    expect(Object.keys(entries)).toContain('HelloIsland');
  });

  it('SSRs the island content so the JS-free baseline still renders', async () => {
    const html = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    expect(html).toContain('data-island-alive="1"');
  });
```

- [ ] **Step 5: Run it to verify it fails**

```bash
cd apps/jags-list && bun run build:client 2>/dev/null; bun run test:island
```

Expected: FAIL — there is no `build:client` script yet and no `/_kiln/client/*` route, so the manifest 404s.

- [ ] **Step 6: Add the client build step**

In `package.json`:

```json
"build:client": "bun ../../packages/cli/dist/cli.js build"
```

Run it and inspect what lands:

```bash
cd apps/jags-list && bun run build:client && find dist/client -maxdepth 2 | head -20
```

Expected: `dist/client/` containing hashed island chunks and `kiln-islands.json`. **If `kiln build` refuses to run for this app** (for example because it expects to own the server), stop and report — that is the framework gap this task exists to discover, and it changes the plan.

- [ ] **Step 7: Serve the assets and wire the manifest**

In `src/main.ts`, before `startKiln`, add the static route — this mirrors `kiln start` in `packages/cli/src/cli.ts`, including its path-traversal guard:

```ts
import path from 'node:path';

const clientDir = path.resolve(process.cwd(), 'dist/client');
adapter.app.get('/_kiln/client/*', async (ctx) => {
  const rel = decodeURIComponent(new URL(ctx.request.url).pathname.slice('/_kiln/client/'.length));
  const filePath = path.resolve(clientDir, rel);
  // Traversal guard: resolved path must stay inside clientDir.
  if (filePath !== clientDir && !filePath.startsWith(clientDir + path.sep)) {
    return new Response('Not found', { status: 404 });
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response('Not found', { status: 404 });
  return new Response(file);
});
```

Then pass the manifest to `startKiln`, alongside the existing options:

```ts
  islandsManifestUrl: '/_kiln/client/kiln-islands.json',
```

Add `/_kiln/` to `PUBLIC_PREFIXES` in `hooks.ts` if it is not already covered — it is listed there today, so verify rather than assume.

- [ ] **Step 8: Run to verify it passes**

```bash
cd apps/jags-list && bun run build:client && bun run test:island
```

Expected: PASS. If the manifest resolves but hydration is untestable headlessly, that is acceptable at this step — the browser check happens in Task 6's drill.

- [ ] **Step 9: Commit**

```bash
git add package.json islands/HelloIsland.tsx src/main.ts 'pages/projects/[id]/board.tsx' tests/island.integration.test.ts
git commit -m "feat(jags-list): island asset pipeline for a custom-entry app"
```

---

### Task 3: Optimistic concurrency on moveTask

**Files:**
- Modify: `db/tasks.ts`
- Modify: `pages/projects/[id]/board.tsx` (actions)
- Modify: `tests/board.integration.test.ts`

**Interfaces:**
- Produces: `moveTask(id, toColumnId, position, expectedVersion?)` returning `Task | null` (null = version conflict); `?/moveTask` returning **422** to fetch clients on conflict (see Critical background #7 — 409 is not reachable from an action)

- [ ] **Step 1: Write the failing test**

Append to `tests/board.integration.test.ts`:

```ts
  it('rejects a move carrying a stale expected version', async () => {
    const [before] = await sql`SELECT version FROM tasks WHERE id = ${taskId}`;
    const stale = Number(before.version) - 1;
    const res = await fetch(`${BASE}/projects/${projectId}/board?/moveTask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        origin: BASE,
        cookie,
      },
      body: new URLSearchParams({
        task_id: String(taskId),
        column_id: String(columnId),
        expected_version: String(stale),
      }).toString(),
      redirect: 'manual',
    });
    // 422, not 409 — see Critical background #7. What the island needs is
    // simply "not ok"; the exact code is a framework limitation, not a choice.
    expect(res.status).toBe(422);
  });

  it('accepts a move carrying the current version', async () => {
    const [cur] = await sql`SELECT version FROM tasks WHERE id = ${taskId}`;
    const res = await fetch(`${BASE}/projects/${projectId}/board?/moveTask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        origin: BASE,
        cookie,
      },
      body: new URLSearchParams({
        task_id: String(taskId),
        column_id: String(columnId),
        expected_version: String(cur.version),
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBeLessThan(400);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/jags-list && bun run test:board
```

Expected: the conflict case FAILS — the action ignores `expected_version` and returns a redirect.

- [ ] **Step 3: Add the version guard to the query**

In `db/tasks.ts`:

```ts
export async function moveTask(
  id: number,
  toColumnId: number,
  position: number,
  expectedVersion?: number,
): Promise<Task | null> {
  // Optimistic concurrency: when the caller states the version it saw, the
  // UPDATE only lands if the row still carries it. A null return means
  // someone else moved this task first — the island refetches and reconciles.
  const rows = expectedVersion === undefined
    ? await sql`
        UPDATE tasks SET column_id = ${toColumnId}, position = ${position}, version = version + 1
        WHERE id = ${id}
        RETURNING id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
                  to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`
    : await sql`
        UPDATE tasks SET column_id = ${toColumnId}, position = ${position}, version = version + 1
        WHERE id = ${id} AND version = ${expectedVersion}
        RETURNING id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
                  to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return (rows[0] as Task) ?? null;
}
```

- [ ] **Step 4: Honour it in the action**

In the `moveTask` action, after the existing task/column ownership checks:

```tsx
    const rawExpected = form.get('expected_version');
    const expectedVersion = rawExpected === null ? undefined : Number(rawExpected);
    const position = await positionForEndOfColumn(toColumnId);
    const moved = await moveTask(taskId, toColumnId, position, expectedVersion);
    if (!moved) {
      // Someone else moved it first. Fetch clients reconcile off the non-ok
      // status; a JS-free form post just re-renders with current state.
      // AppError.validation is 422 — AppError has no conflict/409 member and
      // actions cannot set a status themselves (Critical background #7).
      const wantsJson = (req.headers.get('accept') ?? '').includes('application/json');
      if (wantsJson) throw AppError.validation('Task was moved by someone else');
      throw AppError.redirect(`/projects/${projectId}/board`);
    }
```

`AppError.validation` is the real API (`packages/core/src/errors.ts`, status 422). Do **not** reach for `AppError.conflict` — it does not exist, and `AppError`'s `type` union has no conflict member, so constructing one directly will not typecheck.

- [ ] **Step 5: Run to verify it passes**

```bash
cd apps/jags-list && bun run test:board && bun run test:crud && bun run test:db
```

Expected: all PASS. `test:db` covers `db/tasks.integration.test.ts`, whose existing `moveTask` callers must still work with the now-optional fourth parameter.

- [ ] **Step 6: Commit**

```bash
git add db/tasks.ts 'pages/projects/[id]/board.tsx' tests/board.integration.test.ts
git commit -m "feat(jags-list): optimistic concurrency on moveTask with 422 conflict signalling"
```

---

### Task 4: Board state as a store-target object LiveProp

**Files:**
- Modify: `pages/projects/[id]/board.tsx`
- Modify: `tests/board.integration.test.ts`

**Interfaces:**
- Produces: `boardState: LiveProp<{ columns: Col[]; tasks: T[] }>` with `target: 'store'`, dep `['tasks', 'columns']`

- [ ] **Step 1: Write the failing test**

```ts
  it('declares board state as a store-target field with no DOM slot', async () => {
    const html = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    // Store-target fields deliberately have NO s-live slot (boot.ts skips
    // them in applyLivePropMarkers) — their names ride on the page wrapper
    // so the SSE subscription still covers them.
    expect(html).not.toContain('s-live="boardState"');
    expect(html).toContain('data-kiln-live-store');
    expect(html).toContain('boardState');
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/jags-list && bun run test:board
```

Expected: FAIL — no `data-kiln-live-store` attribute, because no store-target field is declared yet (the Task 2 probe field is removed in Task 6; if it is still present this assertion may pass for the wrong reason — assert on `boardState` specifically, as written).

- [ ] **Step 3: Declare the field**

In `load()`:

```tsx
  const columns = await listColumns(projectId);
  const tasks = await listTasksByProject(projectId);
  return {
    projectId,
    columns,
    tasks,
    // Whole-board live state for the island. A single object-valued field
    // rather than Live.list: the board is divs, and applyLiveListMarkers
    // only marks <li> inside <ul>/<ol> — plus list patches are dropped
    // inside islands and never reach the store. Object values survive both
    // the patch path and the snapshot path intact, so the island receives a
    // real object (no JSON.parse).
    boardState: Live.value<{ columns: typeof columns; tasks: typeof tasks }>(
      { columns, tasks },
      ['tasks', 'columns'],
      { target: 'store' },
    ),
  };
```

The `columns`/`tasks` props stay for the SSR/JS-free render; `boardState` is what the island reads.

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/jags-list && bun run test:board
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'pages/projects/[id]/board.tsx' tests/board.integration.test.ts
git commit -m "feat(jags-list): whole-board live state as a store-target object field"
```

---

### Task 5: The dnd-kit board island

**Files:**
- Create: `islands/BoardIsland.tsx`
- Modify: `pages/projects/[id]/board.tsx`

**Interfaces:**
- Consumes: `boardState` via `useLiveValue`; `?/moveTask` with `expected_version`
- Produces: a hydrated, drag-droppable board that reconciles on conflict

- [ ] **Step 1: Write the island**

```tsx
import React, { useState } from 'react';
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useLiveValue } from '@kiln/react';

interface Col { id: number; name: string; is_terminal: boolean }
interface T { id: number; column_id: number; title: string; priority: number; version: number }
interface BoardState { columns: Col[]; tasks: T[] }

export default function BoardIsland({
  projectId,
  initialState,
}: {
  projectId: number;
  initialState: BoardState;
}) {
  // Live board state arrives through the Silcrow store (ADR-014): silcrow
  // never patches DOM inside an island. The bake-time value is the fallback
  // so SSR and the first client render match exactly.
  const live = useLiveValue<BoardState>('boardState', initialState);
  // Optimistic overlay: taskId -> columnId, cleared once live state agrees.
  const [pending, setPending] = useState<Record<number, number>>({});
  const sensors = useSensors(useSensor(PointerSensor));

  const columnOf = (t: T) => pending[t.id] ?? t.column_id;

  async function onDragEnd(ev: DragEndEvent) {
    const taskId = Number(ev.active.id);
    const toColumn = ev.over ? Number(ev.over.id) : null;
    if (toColumn === null) return;
    const task = live.tasks.find((t) => t.id === taskId);
    if (!task || task.column_id === toColumn) return;

    setPending((p) => ({ ...p, [taskId]: toColumn }));
    const res = await fetch(`/projects/${projectId}/board?/moveTask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        task_id: String(taskId),
        column_id: String(toColumn),
        expected_version: String(task.version),
      }).toString(),
    });
    // A non-ok response (422) means someone moved it first: drop the
    // the next store patch supply the truth.
    if (!res.ok) setPending((p) => { const n = { ...p }; delete n[taskId]; return n; });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="board">
        {live.columns.map((col) => (
          <div key={col.id} className="board-column" data-droppable-id={col.id}>
            <h3>{col.name}</h3>
            {live.tasks.filter((t) => columnOf(t) === col.id).map((t) => (
              <div key={t.id} className={`task-card prio-${t.priority}`} data-draggable-id={t.id}>
                <a href={`/tasks/${t.id}`}>{t.title}</a>
              </div>
            ))}
          </div>
        ))}
      </div>
    </DndContext>
  );
}
```

Wire dnd-kit's `useDroppable` on each column and `useDraggable` on each card to the `data-*` ids shown — consult the installed `@dnd-kit/core` version's own API rather than guessing hook signatures, and keep the rendered class names (`board`, `board-column`, `task-card`, `prio-*`) identical to the SSR markup so existing CSS applies unchanged.

- [ ] **Step 2: Mount it, keeping the JS-free board as the SSR body**

Replace the temporary `<Hello />` with the real island, passing bake-time props:

```tsx
const Board = island(BoardIsland, 'BoardIsland');
```

Render `<Board projectId={projectId} initialState={{ columns, tasks }} />`. The island's SSR output becomes the board markup; the existing JS-free move forms must remain reachable — keep them rendered **outside** the island (below it) so a JS-disabled client still has working controls, per the Global Constraints.

- [ ] **Step 3: Build and verify hydration**

```bash
cd apps/jags-list && bun run build:client && bun run test:island && bun run test:board && bun run test:crud
```

Expected: all PASS, with `test:crud`'s JS-free flow still green — that suite is the guard against the island swallowing the no-JS path.

- [ ] **Step 4: Commit**

```bash
git add islands/BoardIsland.tsx 'pages/projects/[id]/board.tsx'
git commit -m "feat(jags-list): dnd-kit board island with optimistic moves and conflict reconciliation"
```

---

### Task 6: Two-client live drill, cleanup, docs, regression

**Files:**
- Modify: `tests/board.integration.test.ts`
- Delete: `islands/HelloIsland.tsx`
- Modify: `pages/projects/[id]/board.tsx` (remove the probe field)
- Modify: `README.md`, `.memory/active-work.md`

- [ ] **Step 1: Write the two-client drill**

Mirror `tests/live.integration.test.ts`'s SSE approach from Plan 3a — subscribe **before** writing, then assert the patch carries the moved task:

```ts
  it('pushes board state to a subscriber when another client moves a task', async () => {
    const route = `/projects/${projectId}/board`;
    await fetch(BASE + route, { headers: { cookie } }); // bake + register
    const sseUrl = `${BASE}/__kiln/fsr?route=${encodeURIComponent(route)}&slots=boardState`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const framePromise = (async () => {
      try {
        const res = await fetch(sseUrl, {
          headers: { cookie, accept: 'text/event-stream' }, signal: ac.signal,
        });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return null;
          buf += dec.decode(value, { stream: true });
          if (buf.includes('boardState')) return buf;
        }
      } catch { return null; } finally { clearTimeout(timer); }
    })();

    await Bun.sleep(500);
    const [c2] = await sql`INSERT INTO columns (project_id, name, position)
      VALUES (${projectId}, 'Doing', 2000) RETURNING id::int`;
    await sql`UPDATE tasks SET column_id = ${c2.id}, version = version + 1 WHERE id = ${taskId}`;

    expect(await framePromise).not.toBeNull();
  }, 45_000);
```

- [ ] **Step 2: Run it**

```bash
cd apps/jags-list && bun run test:board
```

Expected: PASS. Note `patchDebounceSecs: 5` — the timeouts allow for it; do not shorten them. If no frame arrives, check that `boardState`'s deps (`tasks`, `columns`) are both in `kiln_fsr.depends_on` for this route.

- [ ] **Step 3: Remove the Task 2 probe**

Delete `islands/HelloIsland.tsx`, its import and `const Hello = …`, its render site, and the `pipelineProbe` field from `load()`. Re-run `bun run test:island` — update its assertions to target `BoardIsland` instead of `HelloIsland`, since the pipeline it proves is now carrying the real island.

- [ ] **Step 4: Document**

In `README.md`, extend the "Live surfaces" table added in Plan 3a and add an islands section:

```markdown
| `/projects/:id/board` | store-target `LiveProp` on `boardState` | `tasks`, `columns` |

## Islands

This app owns its `src/main.ts` (better-auth needs raw Elysia routes), so it
cannot use `kiln dev` / `kiln start` — those build their own adapter and never
load our entry. Instead `bun run build:client` runs `kiln build` purely as a
build step, and `src/main.ts` serves `dist/client` under `/_kiln/client/*` and
passes `islandsManifestUrl` to `startKiln`. Island names must equal their file
basename under `islands/`.

Live data reaches an island ONLY through the store (`target: 'store'` +
`useLiveValue`) — silcrow never patches DOM inside `[data-kiln-island]`.
Object-valued store fields arrive as real objects on both the patch and
snapshot paths; no JSON.parse needed.

The board deliberately uses one object-valued field rather than `Live.list`:
the board is divs, and list markers only attach to `<li>` inside `<ul>`/`<ol>`
— and list patches are dropped inside islands anyway.
```

- [ ] **Step 5: Update `.memory/active-work.md`**

Move Plan 3b into Current State; narrow "Next" to the `/projects` restructure and Plan 4.

- [ ] **Step 6: Full regression**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && bun run --filter '@kiln/*' build && bun run build
```

```bash
cd apps/jags-list && bun run build && bun run build:client && bun test && bun run test:db && bun run test:app && bun run test:purity && bun run test:crud && bun run test:freshness && bun run test:gate && bun run test:live && bun run test:board && bun run test:island
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(jags-list): document the island pipeline and store-target board state"
```

---

## Self-review notes

**Spec coverage.** Implements design-spec §12 step 5 and the §7 kanban-move flow (optimistic move, expected version, conflict, reconcile) — with one deliberate deviation: the conflict is signalled **422, not the spec's 409**, because `AppError` has no conflict member and actions cannot set a status (Critical background #7). Closes §9 gap 1 **by routing around it** rather than fixing it: store-target `Live.list` remains unimplemented in the framework, and this plan demonstrates it is not needed for this board.

**Biggest risk is Task 2, by a wide margin.** Everything from Task 4 onward assumes `kiln build` can produce island assets for an app that does not use `kiln start`. That is the one genuinely unproven assumption here — Tasks 1 and 3 are independent of it and would survive intact if it fails. The task says stop-and-report rather than improvise, and Tasks 1–2 are a shippable PR on their own.

**Second risk: dnd-kit's API.** Task 5's hook wiring is deliberately described rather than fully specified, because the exact `useDraggable`/`useDroppable` signatures depend on the version that installs. Read the installed package rather than trusting the sketch — that is the one place this plan knowingly stops short of copy-paste-ready code.

**Deferred, with destinations:** `/projects` role-shell restructure (own plan); task-detail live fields and the notification bell (Plan 4); row-level board diffs (needs framework work at three layers).
