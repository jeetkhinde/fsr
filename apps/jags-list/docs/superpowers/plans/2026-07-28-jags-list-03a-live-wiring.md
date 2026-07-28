# Jag's List Plan 3a — Live Wiring (Activity Feed)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jag's List its first real live surface — a `Live.list` activity feed that updates without a reload — and in doing so prove Kiln's ADR-018 auto-deps pipeline end-to-end through a real page for the first time.

**Architecture:** The activity feed becomes bake-eligible by moving its auth gate out of `load()` and into the already-existing `hooks.ts` `handle` hook, then declares its `events` prop as a `Live.list` with an explicit table-level dependency. Row-level insert diffs flow Postgres trigger → `FsrWatcher` → Redis → SSE → DOM. No framework changes: everything runs on primitives that already ship.

**Tech Stack:** Kiln (`@kiln/core`, `@kiln/routekit`, `@kiln/engine`), React 19 SSR, Bun `SQL` via `createKilnSql`, Postgres LISTEN/NOTIFY, Redis pub/sub, bun:test.

## Global Constraints

- **Scope is the activity feed only.** The board island is Plan 3b; `/projects` and `/tasks/:id` are excluded for reasons recorded below. This is a deliberate reduction against design-spec §6 — read "Scope decisions" before assuming it is an oversight.
- **No framework package changes.** If a task appears to need one, stop and report; that is a Plan 3b signal, not a licence to edit `packages/`.
- **`config.fsr.watcher` must stay `'embedded'`.** `Live.list` throws under an external watcher (`assertEmbeddedLiveLists`, `packages/routekit/src/boot.ts`).
- **JS-free baseline holds.** Every mutation stays a plain form POST. Live updates are additive enhancement only.
- **Verify with a build.** `tsc --noEmit` and unit tests do not catch client-bundle breakage; run `bun run build` from the repo root before claiming done.
- **Worktree discipline.** `cd` explicitly into the worktree path in every Bash call — cwd resets between turns.
- **Ports 3296–3299 are taken** by the freshness/purity/crud/app suites. New suites here use 3294 and 3295.

---

## Critical background (read before Task 1)

All verified against source on 2026-07-28. An executor who does not know these will lose hours.

**1. `requireUser()` inside `load()` is fatal to a live page.** When the watcher re-runs a shared page's `load()` to recompute live values, it builds a stripped request via `makeLoaderRequest` (`packages/routekit/src/boot.ts:769`) with **`locals: {}`** — deliberately empty, so a shared cache entry can never embed one visitor's identity. `requireUser` reads `req.locals.user` and throws `AppError.unauthorized` when it is missing. A live page whose `load()` calls `requireUser` therefore fails on every refresh.

*The fix is not a workaround — it is the correct architecture.* `hooks.ts`'s `handle` already gates every non-public Kiln route (redirect to `/login`, or 401 for JSON clients) before `load()` ever runs. The gate belongs there. Task 1 removes the redundant call and adds a test proving nothing was lost.

**2. Reading identity in `load()` also blocks baking, and the demotion latches.** Under ADR-016 the classifier watches for identity access (`locals` / `headers` / `query`). Under the default `'auto'` mode an impure render sets `knownImpure = true` **for the life of the process** (`boot.ts:574`) and deletes any artifact a previous pure render left behind. One request carrying `?error=` permanently demotes that route until restart.

**3. `Live.list` does NOT get auto-deps. `LiveProp` does.** This asymmetry silently produces a list that never updates. Live *fields* union the request's observed tables into their deps (`boot.ts:695-701`). `registerLiveLists` passes `dependsOn: meta.dependsOn` straight through (`boot.ts:1500`) with no union. **Every `Live.list` must declare `dependsOn` explicitly.** Dep keys are **table-level** strings (e.g. `'activity'`), matching what `kiln sync-triggers` emits from `kiln.config.ts`'s `fsr.triggerTables` — not the old row-scoped `tasks:project_id=5` form, which `migrations/0000_init.sql` documents as retired.

**4. `Live.list` markup requirements are strict.** `applyLiveListMarkers` (`packages/routekit/src/live-list-render.ts`) locates rows by scanning for `<li>` elements (`:131`) inside the nearest preceding `<ul>`/`<ol>` (`:90`), matching a row to an `<li>` by requiring that **every string-valued field** of the row object appears in that `<li>`'s HTML (`:134`). A row that fails to match makes `registerLiveLists` throw `Live.list "<name>" did not render keyed HTML for row "<key>"`. The activity feed already satisfies this — **do not restructure its markup.**

**5. Schema facts the tests depend on** (`migrations/0000_init.sql`): `projects.created_by`, `tasks.created_by`, and `activity.actor_id` are all `TEXT NOT NULL` — every fixture insert must supply a real user id. `tasks.priority` is `SMALLINT CHECK (priority BETWEEN 0 AND 3)`, not a string.

---

## Scope decisions

Design-spec §6 lists four team-shared live surfaces. Only one is actually ready. Recording why, so the next planner does not re-derive this.

**`/projects` — excluded (needs design work).** `load()` returns `me` and the component renders an Archive button only when `me.role` is admin/superadmin (`pages/projects/index.tsx:55,68`). Baking one shared artifact would serve whichever role rendered first to everyone — leaking an admin control to members, or hiding it from admins. Making it live requires restructuring that authorization boundary out of the baked shell. That is real design work, not a mechanical conversion.

**`/tasks/:id` — excluded (nothing to patch yet).** The spec envisions task detail as a display view with description, subtasks, labels and comments, carrying `LiveProp` scalars. The page as built in Plan 2 is a **bare edit form**: every field is an `<input>`/`<select>`/`<textarea>` with `defaultValue` and there is no display text at all. Live-patching it would be actively harmful — silcrow's `_setText` sets `textContent`, which does nothing useful on an `<input>` and would destroy a `<select>`'s options, and patching form controls under someone mid-edit discards their unsaved work. Task detail gets live fields when it gains a display view, which is the comments/subtasks work in **Plan 4**.

**`/projects/:id/board` — Plan 3b**, blocked on the store-target `Live.list` gap (spec §9 gap 1).

That leaves the activity feed: gate-only identity read, already `<ul>`/`<li>`, append-only, and its `activity` trigger is already configured in `kiln.config.ts` with `events: ['insert']`. It is the one surface that is a clean conversion — and it is sufficient to deliver the ADR-018 proof, which is the highest-value outcome here.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `pages/projects/[id]/activity.tsx` | Modify | Drop `requireUser` from `load()`; convert `events` to `Live.list` with `dependsOn: 'activity'` |
| `tests/gate.integration.test.ts` | Create | Proves `hooks.ts` still gates the route anonymously after `requireUser` leaves `load()`; asserts list markers |
| `tests/live.integration.test.ts` | Create | End-to-end live drill: real row insert → trigger → watcher → SSE patch |
| `package.json` | Modify | Add `test:live` and `test:gate` scripts |
| `.memory/active-work.md` | Modify | Record Plan 3a state |
| `README.md` | Modify | Document the live surface and the `dependsOn` rule |

---

### Task 1: Activity feed becomes identity-free and bakes

**Files:**
- Modify: `pages/projects/[id]/activity.tsx:16-18`
- Create: `tests/gate.integration.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `handle` from `hooks.ts` (already present); `projectById` from `db/projects.js`; `createAppUser` and `auth` from `lib/auth.js`
- Produces: `/projects/:id/activity` renders with an identity-free `load()`; baked artifact under `.kiln-cache/projects/<id>/activity/`

- [ ] **Step 1: Write the gate test**

Create `tests/gate.integration.test.ts`. This is the safety net for removing `requireUser` — it asserts the `handle` hook still refuses anonymous access.

```ts
// Plan 3a Task 1: `requireUser` moved out of the activity feed's load() so
// the watcher can re-run it with empty locals (boot.ts makeLoaderRequest).
// The gate now lives ONLY in hooks.ts `handle`. This suite is the proof that
// removing it lost no protection.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { auth, createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

// 3296-3299 are claimed by the freshness/purity/crud/app suites.
const PORT = 3294;
const BASE = `http://localhost:${PORT}`;
const MEMBER = { email: 'gate-member@example.com', password: 'password-123', handle: 'gatemember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let projectId = 0;
let memberId = '';
let memberCookie = '';

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe.skipIf(!run)('auth gate holds without requireUser in load()', () => {
  beforeAll(async () => {
    // Seed this suite's own user — never depend on another suite's fixtures.
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await createAppUser({
      email: MEMBER.email,
      password: MEMBER.password,
      name: 'Gate Member',
      role: 'user',
      handle: MEMBER.handle,
    });
    const [u] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    memberId = u.id;

    // projects.created_by is TEXT NOT NULL — supply a real user id.
    const [p] = await sql`
      INSERT INTO projects (name, description, created_by)
      VALUES ('Gate Test Project', '', ${memberId}) RETURNING id::int`;
    projectId = p.id;

    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT) } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(100);
    }
    memberCookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await sql.close();
  });

  it('redirects an anonymous browser away from the activity feed', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/activity`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('401s an anonymous JSON client instead of redirecting', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/activity`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('still serves the feed to an authenticated member', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/activity`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Add the test scripts**

In `package.json` `scripts`, add:

```json
"test:gate": "RUN_APP_TESTS=1 bun --env-file=.env test tests/gate.integration.test.ts",
"test:live": "RUN_APP_TESTS=1 bun --env-file=.env test tests/live.integration.test.ts"
```

- [ ] **Step 3: Run the gate test — it should PASS already**

```bash
cd apps/jags-list && bun run test:gate
```

Expected: PASS. `requireUser` is still in `load()`, so both layers are active. This run establishes the baseline the change must preserve. If it fails now, stop — the harness is wrong, not the code.

- [ ] **Step 4: Remove `requireUser` from the activity feed's load()**

In `pages/projects/[id]/activity.tsx`, delete the `requireUser(req);` call and its now-unused import (`AppError` and `KilnRequest` are still needed).

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { projectById } from '../../../db/projects.js';
import { sql } from '../../../db/client.js';
```

```tsx
export async function load(req: KilnRequest) {
  // No requireUser here: hooks.ts `handle` gates this route before load()
  // runs, and the watcher re-runs this loader with empty locals — reading
  // identity here would both throw on refresh and block baking (ADR-016).
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const rows = (await sql`
    SELECT a.id::int, u.name AS actor_name, a.verb, a.payload,
           to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
    FROM activity a
    LEFT JOIN "user" u ON u.id = a.actor_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100`) as Array<Omit<ActivityRow, 'payload'> & { payload: string }>;
  const events: ActivityRow[] = rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
  }));
  return { events };
}
```

- [ ] **Step 5: Re-run the gate test to prove the gate survived**

```bash
cd apps/jags-list && bun run test:gate
```

Expected: PASS, identically. This is the point of the task — the gate now rests solely on `hooks.ts` and still holds.

- [ ] **Step 6: Verify the route now bakes**

```bash
cd apps/jags-list && rm -rf .kiln-cache && bun run test:gate && ls -R .kiln-cache/projects 2>/dev/null | head -20
```

Expected: a baked `activity/index.html` under `.kiln-cache/projects/<id>/`. Before this task it would not exist, because the identity read demoted the route. If nothing appears, check the server log for the ADR-016 demotion warning naming this route.

- [ ] **Step 7: Commit**

```bash
git add pages/projects/\[id\]/activity.tsx tests/gate.integration.test.ts package.json
git commit -m "feat(jags-list): activity feed gates via hooks.ts so it can bake"
```

---

### Task 2: Activity feed becomes a Live.list

**Files:**
- Modify: `pages/projects/[id]/activity.tsx`
- Modify: `tests/gate.integration.test.ts`

**Interfaces:**
- Consumes: `Live` from `@kiln/core` (exported via `packages/core/src/live-prop.ts`)
- Produces: `events` registered as a live list under slot name `events` on route `/projects/<id>/activity`, depending on table `activity`

- [ ] **Step 1: Write the failing marker test**

Append this case to `tests/gate.integration.test.ts` — the harness, cookie and fixtures are already there from Task 1.

```ts
  it('marks the activity feed as a live list in the served HTML', async () => {
    // Seed one row so the list is non-empty: an empty Live.list takes the
    // markEmptyListSubscriptions path (body-level data-kiln-live-lists)
    // instead of marking a <ul>. activity.actor_id is TEXT NOT NULL.
    await sql`
      INSERT INTO activity (project_id, actor_id, verb, payload)
      VALUES (${projectId}, ${memberId}, 'plan3a.marker', '{}'::jsonb)`;
    const html = await (await fetch(`${BASE}/projects/${projectId}/activity`, {
      headers: { cookie: memberCookie },
    })).text();
    expect(html).toContain('data-kiln-list="events"');
    expect(html).toMatch(/data-kiln-key="\d+"/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/jags-list && bun run test:gate
```

Expected: FAIL — `expect(html).toContain('data-kiln-list="events"')` finds nothing, because `events` is still a plain array.

- [ ] **Step 3: Convert `events` to a Live.list**

Extract the query into a reusable function and wrap the result. `dependsOn: 'activity'` is **required** — see Critical background #3.

```tsx
import React from 'react';
import { AppError, Live, type KilnRequest } from '@kiln/core';
import { projectById } from '../../../db/projects.js';
import { sql } from '../../../db/client.js';

interface ActivityRow {
  id: number;
  actor_name: string | null;
  verb: string;
  payload: Record<string, unknown>;
  created_at: string;
}

async function activityRows(projectId: number): Promise<ActivityRow[]> {
  const rows = (await sql`
    SELECT a.id::int, u.name AS actor_name, a.verb, a.payload,
           to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
    FROM activity a
    LEFT JOIN "user" u ON u.id = a.actor_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100`) as Array<Omit<ActivityRow, 'payload'> & { payload: string }>;
  // bun returns jsonb as JSON text — parse each payload to an object.
  return rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
  }));
}

export async function load(req: KilnRequest) {
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  return {
    // dependsOn is MANDATORY here: unlike LiveProp, Live.list does not union
    // auto-deps (boot.ts registerLiveLists passes meta.dependsOn straight
    // through). 'activity' is the table-level dep key kiln sync-triggers
    // emits for this table per kiln.config.ts fsr.triggerTables.
    events: Live.list<ActivityRow>({
      key: (row) => row.id,
      dependsOn: 'activity',
      initial: await activityRows(projectId),
      query: () => activityRows(projectId),
    }),
  };
}
```

Leave the component body exactly as it is. Its `<ul className="activity-feed">` + `<li>` structure is what the marker pass requires; changing it breaks row matching.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/jags-list && bun run test:gate
```

Expected: PASS, all four cases. If you instead see `Live.list "events" did not render keyed HTML for row "<id>"`, a row failed the `<li>` match — check that every string-valued field of `ActivityRow` still renders inside its `<li>` (Critical background #4).

- [ ] **Step 5: Commit**

```bash
git add pages/projects/\[id\]/activity.tsx tests/gate.integration.test.ts
git commit -m "feat(jags-list): activity feed as Live.list with explicit activity dep"
```

---

### Task 3: End-to-end live drill (the ADR-018 proof)

This is the task the framework has been waiting for. `.memory/bugs-active.md` records that auto-deps is proven at the capture/trigger/watcher layer but **never end-to-end through a page with live fields**, and that two of the six defects fixed on 2026-07-27 would have surfaced immediately from one real live page. This is that page.

**Files:**
- Create: `tests/live.integration.test.ts`

**Interfaces:**
- Consumes: the `Live.list` registration from Task 2
- Produces: proof that a real `INSERT INTO activity` reaches a subscribed SSE client as a patch

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// The ADR-018 end-to-end proof: a real INSERT, through the real
// kiln_emit_event trigger installed by `kiln sync-triggers`, over real
// LISTEN/NOTIFY to the running app's embedded FsrWatcher, out to a real
// subscribed SSE client — with NO manual dep wiring beyond the list's own
// dependsOn: 'activity'.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { auth, createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

const PORT = 3295;
const BASE = `http://localhost:${PORT}`;
const MEMBER = { email: 'live-member@example.com', password: 'password-123', handle: 'livemember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let projectId = 0;
let memberId = '';
let cookie = '';

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Reads SSE frames until `match` is satisfied or the deadline passes. */
async function waitForSseFrame(
  url: string,
  match: (chunk: string) => boolean,
  timeoutMs = 15_000,
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      if (match(buffer)) return buffer;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!run)('live drill — activity insert reaches an SSE subscriber', () => {
  beforeAll(async () => {
    // sync-triggers is idempotent; run it so this suite is self-contained.
    const cliPath = fileURLToPath(new URL('../../../packages/cli/dist/cli.js', import.meta.url));
    const appDir = fileURLToPath(new URL('..', import.meta.url));
    const sync = Bun.spawnSync(['bun', cliPath, 'sync-triggers'], {
      cwd: appDir,
      env: process.env as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (sync.exitCode !== 0) throw new Error(`kiln sync-triggers exited ${sync.exitCode}`);

    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await createAppUser({
      email: MEMBER.email,
      password: MEMBER.password,
      name: 'Live Member',
      role: 'user',
      handle: MEMBER.handle,
    });
    const [u] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    memberId = u.id;

    const [p] = await sql`
      INSERT INTO projects (name, description, created_by)
      VALUES ('Live Drill Project', '', ${memberId}) RETURNING id::int`;
    projectId = p.id;
    // Seed one row so the list marks a <ul> rather than taking the empty path.
    await sql`
      INSERT INTO activity (project_id, actor_id, verb, payload)
      VALUES (${projectId}, ${memberId}, 'plan3a.seed', '{}'::jsonb)`;

    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: appDir,
      env: { ...process.env, PORT: String(PORT) } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(100);
    }
    cookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 60_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await sql.close();
  });

  it('delivers a patch for a row inserted after the page was baked', async () => {
    const route = `/projects/${projectId}/activity`;
    // 1. Render once so the route bakes and its Live.list registers.
    const first = await fetch(BASE + route, { headers: { cookie } });
    expect(await first.text()).toContain('data-kiln-list="events"');

    // 2. Subscribe, THEN write — so the patch cannot land before we listen.
    const sseUrl = `${BASE}/__kiln/fsr?route=${encodeURIComponent(route)}&slots=events`;
    const framePromise = waitForSseFrame(sseUrl, (buf) => buf.includes('plan3a.livedrill'));

    await Bun.sleep(500); // let the subscription establish
    await sql`
      INSERT INTO activity (project_id, actor_id, verb, payload)
      VALUES (${projectId}, ${memberId}, 'plan3a.livedrill', '{}'::jsonb)`;

    const frame = await framePromise;
    expect(frame).not.toBeNull();
  }, 40_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/jags-list && bun run test:live
```

Expected: FAIL — `expect(frame).not.toBeNull()`, because no patch arrives yet. **Note the debounce:** `kiln.config.ts` sets `patchDebounceSecs: 5`, so a legitimate patch can take ~5s. The 40s test timeout and 15s frame timeout account for this; do not shorten them.

- [ ] **Step 3: Diagnose and fix until it passes**

There is no "minimal implementation" step — Tasks 1 and 2 already wrote the production code. This task's work is proving the pipeline and fixing what it exposes. Work the layers in order:

1. **Trigger firing?** Run `psql $DATABASE_URL -c "LISTEN kiln_invalidate;"` in one shell, insert in another, confirm a payload with `"depKey":"activity"` arrives.
2. **Slot registered?** `SELECT route, slot, depends_on, stale FROM kiln_fsr WHERE route = '/projects/<id>/activity'`. `depends_on` must contain `activity`. Empty means the `dependsOn` from Task 2 did not take.
3. **Watcher marking stale?** Re-query after the insert; `stale` should flip true.
4. **SSE scoped right?** The route must be shared, not `bake='user'` — `sseUserKey` resolves to `''` for shared routes (`boot.ts:1279`), which is what we want.

If the fault is inside `packages/`, **stop and report.** That is a framework defect and a Plan 3b conversation, not something to patch inline — and it is exactly the signal this task exists to surface.

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/jags-list && bun run test:live
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/live.integration.test.ts
git commit -m "test(jags-list): end-to-end live drill proves ADR-018 auto-deps through a real page"
```

---

### Task 4: Documentation, memory, and full regression

**Files:**
- Modify: `README.md`
- Modify: `.memory/active-work.md`

- [ ] **Step 1: Document the live surface in README.md**

Add a "Live surfaces" section recording what is live and the two rules most likely to be got wrong next time:

```markdown
## Live surfaces

| Route | Mechanism | Dep |
|---|---|---|
| `/projects/:id/activity` | `Live.list` on `events` | `activity` (explicit — required) |

**Rule:** `Live.list` does NOT receive auto-deps — always pass `dependsOn`.
`LiveProp` does. Dep keys are table-level (`'activity'`), matching
`kiln.config.ts`'s `fsr.triggerTables`.

**Rule:** a live page's `load()` must not call `requireUser` or read
`req.query`. The auth gate lives in `hooks.ts`; the watcher re-runs loaders
with empty locals, and any identity read blocks baking (and the demotion
latches for the whole process).

Run the drills: `bun run test:gate`, `bun run test:live`.
```

- [ ] **Step 2: Update `.memory/active-work.md`**

Move Plan 3a into Current State with what shipped. Narrow "Next" to: Plan 3b (board island + the store-target `Live.list` spike), the deferred `/projects` role-shell restructure, and task detail's live fields riding along with the Plan 4 display view.

- [ ] **Step 3: Full regression from the repo root**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && bun run --filter '@kiln/*' build && bun run build
```

Then the app suites:

```bash
cd apps/jags-list && bun run build && bun test && bun run test:db && bun run test:app && bun run test:purity && bun run test:crud && bun run test:freshness && bun run test:gate && bun run test:live
```

Expected: all green. The root `bun run build` is mandatory — `tsc --noEmit` does not catch client-bundle breakage.

- [ ] **Step 4: Commit**

```bash
git add README.md .memory/active-work.md
git commit -m "docs(jags-list): document Plan 3a live surface and the dependsOn rule"
```

---

## Self-review notes

**Spec coverage.** This plan implements design-spec §12 step 4 for one of its four surfaces, with the other three excluded for recorded reasons (see "Scope decisions"). That is a conscious reduction, and §6's "team-shared live surfaces" table should be treated as aspirational rather than current until those blockers are addressed.

**Deferred, with destinations:**
- Store-target `Live.list` (spec §9 gap 1) → Plan 3b, spike first.
- `/projects` role-varying shell restructure → own plan.
- Task detail live fields → Plan 4, alongside the display view.
- Per-user live fields (spec §9 gap 2) → not needed until the Plan 4 notification bell; v1 works around it by design.

**Risk to watch.** Task 3 is the only task that can fail for reasons outside this app. It is positioned after the two code tasks deliberately, so that when it fails the app-side variables are already settled and any remaining fault is framework-side — precisely the ADR-018 signal the framework has been missing.
