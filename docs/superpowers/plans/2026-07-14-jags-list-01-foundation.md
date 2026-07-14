# Jag's List — Plan 1 of 4: Foundation & Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bootable Kiln app at `apps/jags-list` with schema + pg_notify triggers, better-auth sessions, an every-request auth gate, JS-free login/logout, and invite-only signup.

**Architecture:** The app mirrors `examples/address-book`: it owns the `ElysiaAdapter`, `FsrStore`, `FsrWatcher`, and pg_notify pipeline in `src/main.ts`, then calls `startKiln()`. better-auth handles credentials/sessions on `/api/auth/*` (raw Elysia routes); `hooks.ts onRequest` gates every other route via a public-path allowlist (verified: Elysia `onRequest` intercepts all routes regardless of registration order, and returning a `Response` short-circuits). Login/logout are raw Elysia POST routes because Kiln actions cannot set response headers.

**Tech Stack:** Bun, Kiln (`@kiln/*` workspace packages), Elysia, Postgres (app queries via `bun`'s `SQL`; better-auth via `pg` Pool), Redis, React 19 (SSR only in this plan), better-auth.

**Spec:** `docs/superpowers/specs/2026-07-14-jags-list-design.md` (read §3–§5 before starting). This plan is 1 of 4; later plans cover CRUD+live, the board island, and collaboration features.

## Global Constraints

- App path: `apps/jags-list/` in the Kiln monorepo; Kiln deps are `workspace:*`.
- New third-party deps in this plan: `better-auth` and `pg` ONLY (`pg` is already in the monorepo tree via `@kiln/engine`).
- All app tables: `created_at`/`updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, plus pg_notify triggers emitting `{"depKey": "<key>", "op": "<OP>"}` on channel `kiln_invalidate`. Dep-key matching is EXACT string equality (`WHERE depKey = ANY(depends_on)`), so triggers emit full key strings like `tasks:project_id=5`.
- `op: 'DELETE'` in a notify payload tombstones routes — emit it ONLY for entity-page keys (`projects:id=`, `tasks:id=`); list-scoped keys always emit `op: 'UPDATE'`.
- User ids are TEXT columns with NO foreign key to better-auth's `"user"` table (avoids migration-order coupling; better-auth's own migration runs separately).
- Page option exports are snake_case (`promote_after`, `json_first`). Every page in this plan is pure SSR: export NO `promote_after`.
- Public path allowlist (exact, from spec §4): `/api/auth/`, `/auth/login`, `/auth/logout`, `/login`, `/invite/`, `/_silcrow/`, `/_kiln/`, `/assets/`, `/favicon.ico`. Nothing else — `/__kiln/fsr` stays gated.
- Handle format: `^[a-z0-9-]{2,32}$`, unique case-insensitively. Password: 8–128 chars. Roles: `'admin' | 'member'`.
- Env vars: `DATABASE_URL`, `REDIS_URL`, `PORT` (default 3200), `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.
- Run all app commands from `apps/jags-list/` unless stated otherwise. Bun auto-loads `.env` from the cwd.
- Work on branch `feat/jags-list-foundation` in its own worktree (create via the using-git-worktrees skill at execution start). Never commit to `main`.

## Prerequisites (execution machine)

- Postgres and Redis running locally (they are — see `test-app/.env` for the pattern).
- Create the database once: `createdb jagslist` (or `psql -c 'CREATE DATABASE jagslist'`).
- Copy `.env.example` → `.env` in `apps/jags-list/` and set `DATABASE_URL` to your local Postgres (this machine uses a `jagjeet` role, e.g. `postgresql://jagjeet:<password>@localhost:5432/jagslist`).

---

### Task 1: Workspace scaffold — bootable app serving a placeholder page

**Files:**
- Modify: `pnpm-workspace.yaml` (repo root)
- Modify: `package.json` (repo root, `workspaces` array)
- Create: `apps/jags-list/package.json`
- Create: `apps/jags-list/tsconfig.json`
- Create: `apps/jags-list/kiln.config.ts`
- Create: `apps/jags-list/db/client.ts`
- Create: `apps/jags-list/src/main.ts`
- Create: `apps/jags-list/pages/_layout.tsx`
- Create: `apps/jags-list/pages/index.tsx`
- Create: `apps/jags-list/styles/app.css`
- Create: `apps/jags-list/.env.example`
- Create: `apps/jags-list/.gitignore`
- Test: `apps/jags-list/tests/smoke.test.ts`

**Interfaces:**
- Consumes: `@kiln/*` workspace packages (patterns copied from `examples/address-book/src/main.ts`).
- Produces: `sql` (Bun `SQL` instance) from `db/client.ts`; default-export config from `kiln.config.ts`; a `main()` boot that later tasks extend. Port 3200.

- [ ] **Step 1: Add `apps/*` to both workspace configs**

In `pnpm-workspace.yaml`, add one line under `packages:`:

```yaml
packages:
  - 'packages/*'
  - 'test-app'
  - 'examples/*'
  - 'apps/*'
```

In root `package.json`, change the workspaces line to:

```json
  "workspaces": ["packages/*", "examples/*", "test-app", "apps/*"]
```

- [ ] **Step 2: Write the failing smoke test**

`apps/jags-list/tests/smoke.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import config from '../kiln.config.js';

describe('jags-list scaffold', () => {
  it('loads the kiln config with FSR wiring', () => {
    expect(config.pagesDir).toBe('./pages');
    expect(config.fsr?.redisUrl).toBeTruthy();
    expect(config.fsr?.postgresUrl).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `apps/jags-list/`): `bun test tests/smoke.test.ts`
Expected: FAIL — cannot resolve `../kiln.config.js`.

- [ ] **Step 4: Create the package manifest and tsconfig**

`apps/jags-list/package.json`:

```json
{
  "name": "@kiln-app/jags-list",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/main.ts",
    "build": "tsc --noEmit",
    "db:migrate": "bun scripts/migrate.ts",
    "auth:migrate": "bunx @better-auth/cli@latest migrate -y",
    "bootstrap-admin": "bun scripts/bootstrap-admin.ts",
    "test": "bun test tests/smoke.test.ts",
    "test:db": "bun --env-file=.env test db/schema.integration.test.ts lib/auth.integration.test.ts db/invites.integration.test.ts",
    "test:app": "RUN_APP_TESTS=1 bun --env-file=.env test tests/app.integration.test.ts"
  },
  "dependencies": {
    "@kiln/adapter-elysia": "workspace:*",
    "@kiln/core": "workspace:*",
    "@kiln/engine": "workspace:*",
    "@kiln/routekit": "workspace:*",
    "better-auth": "^1.7.0",
    "elysia": "^1.0.12",
    "pg": "^8.11.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "@types/node": "^20.12.7",
    "@types/pg": "^8.11.10",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.4.5"
  }
}
```

(`better-auth` and `pg` are used from Task 3 on; installing once now avoids repeated lockfile churn. If `better-auth@^1.7.0` doesn't resolve, use the latest stable ≥1.6 and note the version in the commit message.)

`apps/jags-list/tsconfig.json` (copied from address-book, includes adjusted):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": [
    "db/**/*",
    "lib/**/*",
    "pages/**/*",
    "scripts/**/*",
    "src/**/*",
    "tests/**/*",
    "hooks.ts",
    "kiln.config.ts"
  ]
}
```

- [ ] **Step 5: Create config, DB client, env files**

`apps/jags-list/kiln.config.ts`:

```ts
import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: Number(process.env.PORT ?? 3200),
  pagesDir: './pages',
  fsr: {
    watcher: 'embedded',
    promoteAfterHits: 2,
    patchDebounceSecs: 5,
    revalidateSeconds: 300,
    purgeAfterSeconds: 2_592_000,
    purgeSweepSeconds: 3_600,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    postgresUrl:
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist',
  },
});
```

`apps/jags-list/db/client.ts`:

```ts
import { SQL } from 'bun';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist';

export const sql = new SQL(databaseUrl);
```

`apps/jags-list/.env.example`:

```
DATABASE_URL=postgresql://localhost:5432/jagslist
REDIS_URL=redis://localhost:6379
PORT=3200
BETTER_AUTH_URL=http://localhost:3200
BETTER_AUTH_SECRET=generate-a-long-random-string
```

`apps/jags-list/.gitignore`:

```
.env
node_modules/
.kiln-cache/
```

- [ ] **Step 6: Create the boot file, layout, placeholder page, styles**

`apps/jags-list/src/main.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import {
  FsrStore,
  FsrWatcher,
  RedisCache,
  startDbNotificationPipeline,
} from '@kiln/engine';
import { startKiln } from '@kiln/routekit';
import config from '../kiln.config.js';
import { sql } from '../db/client.js';

async function main() {
  const adapter = new ElysiaAdapter();
  const store = new FsrStore(sql);
  const fsrConfig = config.fsr;
  const redis = fsrConfig.redisUrl
    ? new RedisCache(fsrConfig.redisUrl).withArtifactTtl(
        fsrConfig.artifactTtlSecs,
      )
    : null;
  if (process.env.NODE_ENV === 'production' && (!fsrConfig.postgresUrl || !redis)) {
    throw new Error('Jag\'s List production requires reachable PostgreSQL and Redis');
  }
  await store.initialize();
  if (redis) await redis.getClient().send('PING', []);
  const watcher = new FsrWatcher(store, redis, {
    pollIntervalMs: fsrConfig.pollIntervalMs,
    promoteAfterHits: fsrConfig.promoteAfterHits,
    patchDebounceSecs: fsrConfig.patchDebounceSecs,
    purgeAfterSeconds: fsrConfig.purgeAfterSeconds,
    purgeSweepSeconds: fsrConfig.purgeSweepSeconds,
    revalidateSeconds: fsrConfig.revalidateSeconds,
    scheduledInvalidations: [],
  });

  await watcher.start();
  await startDbNotificationPipeline(fsrConfig.postgresUrl!, store, watcher);

  adapter.registerAsset(
    '/assets/app.css',
    fileURLToPath(new URL('../styles/app.css', import.meta.url)),
  );

  await startKiln(adapter, config, './pages', {
    fsr: true,
    store,
    watcher,
    redis: redis ?? undefined,
  });
  await adapter.listen(config.port ?? 3200, (address) => {
    console.log(`Jag's List running at ${address}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

`apps/jags-list/pages/_layout.tsx`:

```tsx
import React from 'react';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Jag's List</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/_silcrow/silcrow.js" defer />
      </head>
      <body>
        <header className="topnav">
          <a href="/" className="brand">Jag's List</a>
          <nav>
            <a href="/projects">Projects</a>
            <a href="/team">Team</a>
          </nav>
          <form method="post" action="/auth/logout" className="logout-form">
            <button type="submit">Sign out</button>
          </form>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

(ADR-011 note: this layout has no `load()` and reads NO per-user data — it is pattern-cached and shared. The `/projects` and `/team` links 404 until later tasks/plans; that's expected.)

`apps/jags-list/pages/index.tsx` (placeholder — Task 5 replaces it with the signed-in home):

```tsx
import React from 'react';

export default function HomePage() {
  return (
    <section>
      <h1>Jag's List</h1>
      <p>Foundation scaffold is up.</p>
    </section>
  );
}
```

`apps/jags-list/styles/app.css`:

```css
:root {
  --bg: #f6f7f9; --card: #ffffff; --ink: #1c2733; --muted: #5b6b7b;
  --accent: #2456d6; --danger: #b3261e; --ok: #1a7f4b; --line: #dde3ea;
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
.topnav { display: flex; align-items: center; gap: 1.5rem; padding: 0.75rem 1.5rem; background: var(--card); border-bottom: 1px solid var(--line); }
.topnav .brand { font-weight: 700; color: var(--ink); text-decoration: none; }
.topnav nav { display: flex; gap: 1rem; flex: 1; }
.topnav nav a { color: var(--muted); text-decoration: none; }
.topnav nav a:hover { color: var(--accent); }
.logout-form button { background: none; border: 1px solid var(--line); border-radius: 6px; padding: 0.3rem 0.8rem; cursor: pointer; color: var(--muted); }
main { max-width: 60rem; margin: 2rem auto; padding: 0 1.5rem; }
.auth-card { max-width: 24rem; margin: 4rem auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 2rem; }
.auth-card form, .invite-form { display: grid; gap: 0.9rem; margin-top: 1rem; }
label { display: grid; gap: 0.25rem; font-size: 0.9rem; color: var(--muted); }
input, select { padding: 0.5rem 0.65rem; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
button[type='submit'] { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 0.55rem 1rem; font: inherit; cursor: pointer; }
.error { color: var(--danger); background: #fdeceb; border: 1px solid #f5c6c2; border-radius: 6px; padding: 0.5rem 0.75rem; }
.notice { color: var(--ok); background: #e8f5ee; border: 1px solid #bfe3cf; border-radius: 6px; padding: 0.5rem 0.75rem; }
.members { list-style: none; padding: 0; display: grid; gap: 0.5rem; }
.members li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 1rem; }
.handle { color: var(--muted); font-weight: 400; }
code { background: #eef1f5; padding: 0.1rem 0.4rem; border-radius: 4px; }
```

- [ ] **Step 7: Install and run the smoke test**

Run (from repo root): `bun install`
Then (from `apps/jags-list/`): `bun test tests/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Boot the app and verify by hand**

Prereq: `createdb jagslist` (once), `.env` copied from `.env.example` with a valid `DATABASE_URL`.

Run (from `apps/jags-list/`): `bun src/main.ts` (in background or second terminal)
Then: `curl -s http://localhost:3200/ | grep -c "Jag's List"`
Expected: server logs `Jag's List running at ...`; curl output ≥ 1. Stop the server.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json apps/jags-list
git commit -m "feat(jags-list): scaffold app workspace, config, boot, placeholder page"
```

---

### Task 2: App schema — tables, updated_at touch, pg_notify triggers

**Files:**
- Create: `apps/jags-list/migrations/0000_init.sql`
- Create: `apps/jags-list/scripts/migrate.ts`
- Test: `apps/jags-list/db/schema.integration.test.ts`

**Interfaces:**
- Consumes: `sql` from `db/client.ts` (Task 1).
- Produces: all app tables from spec §5; notify contract `{"depKey","op"}` on `kiln_invalidate`; `bun run db:migrate` idempotent runner. Later tasks use tables `invites` and `"user"` (the latter created by Task 3's auth migration — NOT here).

- [ ] **Step 1: Write the failing integration test**

`apps/jags-list/db/schema.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { sql } from './client.js';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('jags-list schema', () => {
  const listener = new pg.Client({ connectionString: url });
  const payloads: Array<{ depKey: string; op: string }> = [];
  let projectId = 0;

  beforeAll(async () => {
    await listener.connect();
    await listener.query('LISTEN kiln_invalidate');
    listener.on('notification', (msg) => {
      if (msg.payload) payloads.push(JSON.parse(msg.payload));
    });
  });

  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await listener.end();
    await sql.close();
  });

  it('creates a project/column/task and fires exact dep-key notifications', async () => {
    const [project] = await sql`
      INSERT INTO projects (name, created_by) VALUES ('itest-project', 'itest-user') RETURNING id`;
    projectId = project.id;
    const [column] = await sql`
      INSERT INTO columns (project_id, name, position) VALUES (${projectId}, 'Backlog', 1) RETURNING id`;
    const [task] = await sql`
      INSERT INTO tasks (project_id, column_id, title, position, created_by)
      VALUES (${projectId}, ${column.id}, 'itest task', 1, 'itest-user') RETURNING id, created_at, updated_at`;

    await Bun.sleep(300); // let LISTEN deliver

    const keys = payloads.map((p) => `${p.depKey}|${p.op}`);
    expect(keys).toContain(`projects:all|UPDATE`);
    expect(keys).toContain(`projects:id=${projectId}|INSERT`);
    expect(keys).toContain(`columns:project_id=${projectId}|UPDATE`);
    expect(keys).toContain(`tasks:project_id=${projectId}|UPDATE`);
    expect(keys).toContain(`tasks:id=${task.id}|INSERT`);
  });

  it('bumps updated_at on update and emits DELETE op only for the id key', async () => {
    const [task] = await sql`SELECT id, updated_at FROM tasks WHERE project_id = ${projectId}`;
    await Bun.sleep(50);
    await sql`UPDATE tasks SET title = 'renamed' WHERE id = ${task.id}`;
    const [after] = await sql`SELECT updated_at FROM tasks WHERE id = ${task.id}`;
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(task.updated_at).getTime());

    payloads.length = 0;
    await sql`DELETE FROM tasks WHERE id = ${task.id}`;
    await Bun.sleep(300);
    const keys = payloads.map((p) => `${p.depKey}|${p.op}`);
    expect(keys).toContain(`tasks:project_id=${projectId}|UPDATE`); // list key: change, never tombstone
    expect(keys).toContain(`tasks:id=${task.id}|DELETE`);           // entity key: tombstone
  });

  it('has the tasks search tsvector with GIN index', async () => {
    const [idx] = await sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'tasks_search_idx'`;
    expect(idx?.indexname).toBe('tasks_search_idx');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/jags-list/`): `bun --env-file=.env test db/schema.integration.test.ts`
Expected: FAIL — relation "projects" does not exist.

- [ ] **Step 3: Write the migration**

`apps/jags-list/migrations/0000_init.sql`:

```sql
-- Jag's List app schema. better-auth tables ("user", "session", "account",
-- "verification") are managed by `bun run auth:migrate` — user ids here are
-- TEXT with no FK so the two migrations are order-independent.

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS columns (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position DOUBLE PRECISION NOT NULL,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS columns_project_idx ON columns(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id BIGINT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT,
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  due_date DATE,
  position DOUBLE PRECISION NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks(column_id);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS tasks_search_idx ON tasks USING GIN (search);

CREATE TABLE IF NOT EXISTS labels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#8899aa',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE IF NOT EXISTS subtasks (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  position DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subtasks_task_idx ON subtasks(task_id);

CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comments_task_idx ON comments(task_id);

CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL,
  verb TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_project_idx ON activity(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('assigned', 'mentioned', 'commented')),
  task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS invites (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- updated_at touch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jags_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_touch ON projects;
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS columns_touch ON columns;
CREATE TRIGGER columns_touch BEFORE UPDATE ON columns FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS tasks_touch ON tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS labels_touch ON labels;
CREATE TRIGGER labels_touch BEFORE UPDATE ON labels FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS subtasks_touch ON subtasks;
CREATE TRIGGER subtasks_touch BEFORE UPDATE ON subtasks FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS comments_touch ON comments;
CREATE TRIGGER comments_touch BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS invites_touch ON invites;
CREATE TRIGGER invites_touch BEFORE UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();

-- ---------------------------------------------------------------------------
-- kiln_invalidate notifications. Contract (packages/engine/src/db-notify.ts):
-- payload {"depKey": string, "op": string}; op='DELETE' tombstones dependent
-- routes, anything else invalidates them. Dep-key matching is EXACT, so we
-- emit full key strings. List-scoped keys always use op 'UPDATE'; only
-- entity-page keys (projects:id=, tasks:id=) pass TG_OP through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jags_notify(dep_key TEXT, op TEXT) RETURNS void AS $$
BEGIN
  PERFORM pg_notify('kiln_invalidate', json_build_object('depKey', dep_key, 'op', op)::text);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_projects() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('projects:all', 'UPDATE');
  PERFORM jags_notify('projects:id=' || r.id, TG_OP);
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_columns() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('columns:project_id=' || r.project_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_tasks() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('tasks:project_id=' || r.project_id, 'UPDATE');
  PERFORM jags_notify('tasks:id=' || r.id, TG_OP);
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_subtasks() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('subtasks:task_id=' || r.task_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_comments() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('comments:task_id=' || r.task_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_labels() RETURNS trigger AS $$
BEGIN
  PERFORM jags_notify('labels:all', 'UPDATE');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_task_labels() RETURNS trigger AS $$
DECLARE r RECORD; pid BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT project_id INTO pid FROM tasks WHERE id = r.task_id;
  PERFORM jags_notify('tasks:id=' || r.task_id, 'UPDATE');
  IF pid IS NOT NULL THEN
    PERFORM jags_notify('tasks:project_id=' || pid, 'UPDATE');
  END IF;
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_activity() RETURNS trigger AS $$
BEGIN
  PERFORM jags_notify('activity:project_id=' || NEW.project_id, 'UPDATE');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_notifications() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('notifications:user_id=' || r.user_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_kiln_invalidate ON projects;
CREATE TRIGGER projects_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION jags_notify_projects();

DROP TRIGGER IF EXISTS columns_kiln_invalidate ON columns;
CREATE TRIGGER columns_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON columns
FOR EACH ROW EXECUTE FUNCTION jags_notify_columns();

DROP TRIGGER IF EXISTS tasks_kiln_invalidate ON tasks;
CREATE TRIGGER tasks_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION jags_notify_tasks();

DROP TRIGGER IF EXISTS subtasks_kiln_invalidate ON subtasks;
CREATE TRIGGER subtasks_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON subtasks
FOR EACH ROW EXECUTE FUNCTION jags_notify_subtasks();

DROP TRIGGER IF EXISTS comments_kiln_invalidate ON comments;
CREATE TRIGGER comments_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON comments
FOR EACH ROW EXECUTE FUNCTION jags_notify_comments();

DROP TRIGGER IF EXISTS labels_kiln_invalidate ON labels;
CREATE TRIGGER labels_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON labels
FOR EACH ROW EXECUTE FUNCTION jags_notify_labels();

DROP TRIGGER IF EXISTS task_labels_kiln_invalidate ON task_labels;
CREATE TRIGGER task_labels_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON task_labels
FOR EACH ROW EXECUTE FUNCTION jags_notify_task_labels();

DROP TRIGGER IF EXISTS activity_kiln_invalidate ON activity;
CREATE TRIGGER activity_kiln_invalidate AFTER INSERT ON activity
FOR EACH ROW EXECUTE FUNCTION jags_notify_activity();

DROP TRIGGER IF EXISTS notifications_kiln_invalidate ON notifications;
CREATE TRIGGER notifications_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON notifications
FOR EACH ROW EXECUTE FUNCTION jags_notify_notifications();
```

- [ ] **Step 4: Write the migration runner**

`apps/jags-list/scripts/migrate.ts`:

```ts
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from '../db/client.js';

try {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(fileURLToPath(dir)))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const text = await Bun.file(new URL(file, dir)).text();
    await sql.unsafe(text);
    console.log(`migrated: ${file}`);
  }
} finally {
  await sql.close();
}
```

- [ ] **Step 5: Run migration, then the test**

Run (from `apps/jags-list/`):
`bun run db:migrate` — expected: `migrated: 0000_init.sql`
`bun --env-file=.env test db/schema.integration.test.ts` — expected: PASS (3 tests).

Run `bun run db:migrate` a second time — expected: same output, no errors (idempotence).

- [ ] **Step 6: Commit**

```bash
git add apps/jags-list/migrations apps/jags-list/scripts/migrate.ts apps/jags-list/db/schema.integration.test.ts
git commit -m "feat(jags-list): app schema with exact-key pg_notify triggers"
```

---

### Task 3: better-auth — instance, HTTP mount, auth schema, bootstrap-admin

**Files:**
- Create: `apps/jags-list/lib/auth.ts`
- Modify: `apps/jags-list/src/main.ts` (register `/api/auth/*`)
- Create: `apps/jags-list/migrations/0001_user_handle_unique.sql`
- Create: `apps/jags-list/scripts/bootstrap-admin.ts`
- Test: `apps/jags-list/lib/auth.integration.test.ts`

**Interfaces:**
- Consumes: env vars `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `DATABASE_URL`.
- Produces: `auth` (better-auth instance) from `lib/auth.ts`. Later tasks call `auth.api.getSession({ headers })`, `auth.api.createUser({ body: { email, password, name, role, data: { handle } } })`, `auth.api.signInEmail({ body, asResponse: true })`, `auth.api.signOut({ headers, asResponse: true })`. HTTP surface `/api/auth/*`.

- [ ] **Step 1: Write the failing integration test**

`apps/jags-list/lib/auth.integration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'bun:test';
import { auth } from './auth.js';
import { sql } from '../db/client.js';

const EMAIL = 'auth-itest@example.com';

describe.skipIf(!process.env.DATABASE_URL)('better-auth integration', () => {
  afterAll(async () => {
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await sql.close();
  });

  it('creates a user with role + handle, signs in, resolves the session', async () => {
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await auth.api.createUser({
      body: {
        email: EMAIL,
        password: 'itest-password-1',
        name: 'ITest',
        role: 'member',
        data: { handle: 'itest' },
      },
    });

    const res = await auth.api.signInEmail({
      body: { email: EMAIL, password: 'itest-password-1' },
      asResponse: true,
    });
    expect(res.status).toBe(200);
    const cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookies).toContain('better-auth');

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies }),
    });
    expect(session?.user.email).toBe(EMAIL);
    expect((session?.user as any).handle).toBe('itest');
    expect((session?.user as any).role).toBe('member');
  });

  it('rejects public sign-up (disableSignUp)', async () => {
    const res = await auth.handler(
      new Request('http://localhost:3200/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'signup-blocked@example.com',
          password: 'whatever-123',
          name: 'Blocked',
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/jags-list/`): `bun --env-file=.env test lib/auth.integration.test.ts`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Create the better-auth instance**

`apps/jags-list/lib/auth.ts`:

```ts
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { Pool } from 'pg';

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3200',
  secret: process.env.BETTER_AUTH_SECRET ?? 'dev-secret-change-me',
  database: new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist',
  }),
  emailAndPassword: {
    enabled: true,
    // Invite-only: users are created server-side via auth.api.createUser
    // (bootstrap script + invite acceptance). Public sign-up stays closed.
    disableSignUp: true,
  },
  session: {
    // hooks.ts checks the session on every request; the signed cookie cache
    // avoids a DB round-trip per request.
    cookieCache: { enabled: true, maxAge: 300 },
  },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'member', input: false },
      handle: { type: 'string', required: false, input: false },
    },
  },
  plugins: [admin()],
});
```

(If `createUser`'s `data: { handle }` does not persist the handle — assert via the test — fall back to setting it right after creation: `await sql\`UPDATE "user" SET handle = ${handle} WHERE id = ${created.user.id}\``, and note it as a finding.)

- [ ] **Step 4: Generate better-auth's schema and the handle index**

Run (from `apps/jags-list/`): `bun run auth:migrate`
Expected: CLI reports the created tables (`user`, `session`, `account`, `verification`). If `-y` is rejected by the CLI version, run `bunx @better-auth/cli@latest migrate` interactively and confirm.

`apps/jags-list/migrations/0001_user_handle_unique.sql`:

```sql
-- Requires better-auth's migration to have created "user" (bun run auth:migrate).
CREATE UNIQUE INDEX IF NOT EXISTS user_handle_unique
  ON "user" (lower(handle))
  WHERE handle IS NOT NULL;
```

Run: `bun run db:migrate`
Expected: `migrated: 0000_init.sql`, `migrated: 0001_user_handle_unique.sql`.

- [ ] **Step 5: Register the auth HTTP surface in main.ts**

In `apps/jags-list/src/main.ts`, add the import and register the route immediately after `const adapter = new ElysiaAdapter();`:

```ts
import { auth } from '../lib/auth.js';
```

```ts
  const adapter = new ElysiaAdapter();
  // better-auth endpoints (sign-in/out, session). NOTE: these are public via
  // the hooks.ts allowlist — Elysia onRequest intercepts every route
  // regardless of registration order (verified 2026-07-14).
  adapter.app.all('/api/auth/*', (ctx: any) => auth.handler(ctx.request));
```

- [ ] **Step 6: Create the bootstrap script**

`apps/jags-list/scripts/bootstrap-admin.ts`:

```ts
import { auth } from '../lib/auth.js';

const [email, password, name, handle] = process.argv.slice(2);
if (!email || !password || !name || !handle) {
  console.error('usage: bun scripts/bootstrap-admin.ts <email> <password> <name> <handle>');
  process.exit(1);
}
if (!/^[a-z0-9-]{2,32}$/.test(handle)) {
  console.error('handle must match ^[a-z0-9-]{2,32}$');
  process.exit(1);
}

const created = await auth.api.createUser({
  body: { email, password, name, role: 'admin', data: { handle } },
});
console.log(`admin created: ${created.user.email} (@${handle})`);
process.exit(0);
```

- [ ] **Step 7: Run the tests**

Run (from `apps/jags-list/`): `bun --env-file=.env test lib/auth.integration.test.ts`
Expected: PASS (2 tests).

Then verify the bootstrap script end-to-end:
`bun scripts/bootstrap-admin.ts admin@example.com admin-password-1 "Jagjeet" jag`
Expected: `admin created: admin@example.com (@jag)`.

- [ ] **Step 8: Commit**

```bash
git add apps/jags-list/lib/auth.ts apps/jags-list/lib/auth.integration.test.ts apps/jags-list/src/main.ts apps/jags-list/migrations/0001_user_handle_unique.sql apps/jags-list/scripts/bootstrap-admin.ts
git commit -m "feat(jags-list): better-auth instance, /api/auth surface, bootstrap-admin"
```

---

### Task 4: Session gate — lib/session.ts + hooks.ts

**Files:**
- Create: `apps/jags-list/lib/session.ts`
- Create: `apps/jags-list/hooks.ts`
- Test: `apps/jags-list/tests/app.integration.test.ts` (gate cases; Task 5 extends it)

**Interfaces:**
- Consumes: `auth` from `lib/auth.ts` (Task 3); `AppError`, `KilnRequest` from `@kiln/core`.
- Produces: `SessionUser { id, email, name, handle, role }`; `getSessionUser(headers: Headers): Promise<SessionUser | null>`; `requireUser(req: KilnRequest): Promise<SessionUser>`; `requireAdmin(req: KilnRequest): Promise<SessionUser>`. `hooks.ts` exports `onRequest` (loaded automatically by `startKiln` from the app root).

- [ ] **Step 1: Write the failing gate test**

`apps/jags-list/tests/app.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { auth } from '../lib/auth.js';
import { sql } from '../db/client.js';

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const EMAIL = 'gate-itest@example.com';
const PASSWORD = 'itest-password-1';
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;

describe.skipIf(!run)('app auth gate', () => {
  beforeAll(async () => {
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await auth.api.createUser({
      body: { email: EMAIL, password: PASSWORD, name: 'Gate Test', role: 'member', data: { handle: 'gatetest' } },
    });
    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try {
        const r = await fetch(`${BASE}/login`);
        if (r.status === 200) return;
      } catch {}
      await Bun.sleep(200);
    }
    throw new Error('app did not start on ' + BASE);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await sql.close();
  });

  it('redirects anonymous page requests to /login', async () => {
    const res = await fetch(BASE + '/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('returns 401 JSON for anonymous JSON requests', async () => {
    const res = await fetch(BASE + '/', {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('keeps the SSE endpoint gated', async () => {
    const res = await fetch(BASE + '/__kiln/fsr?route=/', { redirect: 'manual' });
    expect([302, 401]).toContain(res.status);
  });

  it('serves /login without a session', async () => {
    const res = await fetch(BASE + '/login');
    expect([200, 404]).toContain(res.status); // 404 until Task 5 adds the page; Task 5 tightens to 200 + content
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/jags-list/`): `RUN_APP_TESTS=1 bun --env-file=.env test tests/app.integration.test.ts`
Expected: FAIL — anonymous `/` returns 200 (no gate yet).

- [ ] **Step 3: Create lib/session.ts**

```ts
import { AppError, type KilnRequest } from '@kiln/core';
import { auth } from './auth.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  handle: string;
  role: 'admin' | 'member';
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const u = session.user as any;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle ?? '',
    role: u.role === 'admin' ? 'admin' : 'member',
  };
}

export async function requireUser(req: KilnRequest): Promise<SessionUser> {
  const user = await getSessionUser(req.headers);
  if (!user) throw AppError.unauthorized('Sign in required');
  return user;
}

export async function requireAdmin(req: KilnRequest): Promise<SessionUser> {
  const user = await requireUser(req);
  if (user.role !== 'admin') throw AppError.unauthorized('Admin access required');
  return user;
}
```

- [ ] **Step 4: Create hooks.ts**

`apps/jags-list/hooks.ts` (app root — `startKiln` loads it via `applyServerHooks`):

```ts
import { getSessionUser } from './lib/session.js';

// Paths reachable without a session (spec §4). Everything else — including
// promoted pages and /__kiln/fsr SSE — requires one. Elysia onRequest
// intercepts every route regardless of registration order (verified), so
// /api/auth/* and the login/logout form routes MUST be listed here.
const PUBLIC_PREFIXES = [
  '/api/auth/',
  '/auth/login',
  '/auth/logout',
  '/login',
  '/invite/',
  '/_silcrow/',
  '/_kiln/',
  '/assets/',
  '/favicon.ico',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export async function onRequest(ctx: any): Promise<Response | void> {
  const url = new URL(ctx.request.url);
  if (isPublic(url.pathname)) return;

  const user = await getSessionUser(ctx.request.headers);
  if (user) return;

  if (wantsJson(ctx.request)) {
    return new Response(JSON.stringify({ error: 'Unauthorized', status: 401 }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 302, headers: { location: '/login' } });
}
```

- [ ] **Step 5: Run the gate tests**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/app.integration.test.ts`
Expected: the three gate assertions PASS; the `/login` 200 assertion may still fail (page arrives in Task 5 — see Step 1 note; use `[200, 404]` temporarily if needed so this task ends green).

- [ ] **Step 6: Commit**

```bash
git add apps/jags-list/lib/session.ts apps/jags-list/hooks.ts apps/jags-list/tests/app.integration.test.ts
git commit -m "feat(jags-list): session gate via hooks.ts onRequest with public allowlist"
```

---

### Task 5: Login page, login/logout form routes, signed-in home

**Files:**
- Create: `apps/jags-list/pages/login.tsx`
- Modify: `apps/jags-list/src/main.ts` (add `/auth/login`, `/auth/logout` POST routes)
- Modify: `apps/jags-list/pages/index.tsx` (signed-in home)
- Test: extend `apps/jags-list/tests/app.integration.test.ts`

**Interfaces:**
- Consumes: `auth` (Task 3), `requireUser` (Task 4).
- Produces: `POST /auth/login` (form fields `email`, `password`; 303 → `/` with session cookies, or 303 → `/login?error=1`), `POST /auth/logout` (303 → `/login`, clears cookies). Home page `/` shows `@handle`.

- [ ] **Step 1: Extend the integration test with the login flow**

Replace the `/login` test in `tests/app.integration.test.ts` with a strict 200 + content assertion, and append the flow test:

```ts
  it('serves /login without a session', async () => {
    const res = await fetch(BASE + '/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in');
  });

  it('logs in via the form endpoint, loads home, logs out', async () => {
    const form = new URLSearchParams({ email: EMAIL, password: PASSWORD });
    const login = await fetch(BASE + '/auth/login', {
      method: 'POST',
      body: form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE, // Kiln CSRF middleware checks origin on form POSTs
      },
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/');
    const cookies = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookies).toContain('better-auth');

    const home = await fetch(BASE + '/', { headers: { cookie: cookies } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('@gatetest');

    const logout = await fetch(BASE + '/auth/logout', {
      method: 'POST',
      headers: { cookie: cookies, origin: BASE },
      redirect: 'manual',
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('location')).toBe('/login');
  });

  it('rejects a wrong password with a redirect back to /login', async () => {
    const form = new URLSearchParams({ email: EMAIL, password: 'wrong-password' });
    const res = await fetch(BASE + '/auth/login', {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login?error=1');
  });
```

- [ ] **Step 2: Run test to verify the new cases fail**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/app.integration.test.ts`
Expected: FAIL — `/login` 404, `/auth/login` 404.

- [ ] **Step 3: Create the login page**

`apps/jags-list/pages/login.tsx`:

```tsx
import React from 'react';
import type { KilnRequest } from '@kiln/core';

export async function load(req: KilnRequest) {
  return {
    error: req.query.error === '1',
    welcome: req.query.welcome === '1',
  };
}

export default function LoginPage({ error, welcome }: { error: boolean; welcome: boolean }) {
  return (
    <section className="auth-card">
      <h1>Sign in</h1>
      {welcome && <p className="notice">Account created — sign in to get started.</p>}
      {error && <p className="error">Wrong email or password.</p>}
      <form method="post" action="/auth/login">
        <label>
          Email
          <input type="email" name="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input type="password" name="password" required autoComplete="current-password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Add the login/logout routes to main.ts**

In `src/main.ts`, directly below the `/api/auth/*` registration:

```ts
  // Form-post login/logout. These are raw Elysia routes, NOT Kiln actions,
  // because actions receive only `req` and cannot set Set-Cookie headers
  // (spec §9 gap 3). Public via the hooks.ts allowlist.
  adapter.app.post('/auth/login', async (ctx: any) => {
    const form = await ctx.request.formData();
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    try {
      const res = await auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
      });
      if (!res.ok) {
        return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
      }
      const headers = new Headers({ location: '/' });
      for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
      return new Response(null, { status: 303, headers });
    } catch {
      return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
    }
  });

  adapter.app.post('/auth/logout', async (ctx: any) => {
    const headers = new Headers({ location: '/login' });
    try {
      const res = await auth.api.signOut({
        headers: ctx.request.headers,
        asResponse: true,
      });
      for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
    } catch {
      // no/invalid session — still land on /login
    }
    return new Response(null, { status: 303, headers });
  });
```

- [ ] **Step 5: Make the home page session-aware**

Replace `apps/jags-list/pages/index.tsx`:

```tsx
import React from 'react';
import type { KilnRequest } from '@kiln/core';
import { requireUser } from '../lib/session.js';

export async function load(req: KilnRequest) {
  const user = await requireUser(req);
  return { user };
}

export default function HomePage({
  user,
}: {
  user: { name: string; handle: string };
}) {
  return (
    <section>
      <h1>
        Welcome, {user.name} <span className="handle">@{user.handle}</span>
      </h1>
      <p>
        My Tasks lands here in a later milestone. For now:{' '}
        <a href="/team">manage your team</a>.
      </p>
    </section>
  );
}
```

- [ ] **Step 6: Run the full integration suite**

Run: `RUN_APP_TESTS=1 bun --env-file=.env test tests/app.integration.test.ts`
Expected: PASS (all cases, including the tightened `/login` 200).

- [ ] **Step 7: Commit**

```bash
git add apps/jags-list/pages/login.tsx apps/jags-list/pages/index.tsx apps/jags-list/src/main.ts apps/jags-list/tests/app.integration.test.ts
git commit -m "feat(jags-list): JS-free login/logout flow and signed-in home"
```

---

### Task 6: Invites — validation, /team page, /invite/:token acceptance

**Files:**
- Create: `apps/jags-list/db/validation.ts`
- Create: `apps/jags-list/db/invites.ts`
- Create: `apps/jags-list/pages/team.tsx`
- Create: `apps/jags-list/pages/invite/[token].tsx`
- Test: `apps/jags-list/db/validation.test.ts`
- Test: `apps/jags-list/db/invites.integration.test.ts`

**Interfaces:**
- Consumes: `sql`, `auth`, `requireUser`, `requireAdmin`.
- Produces: `validEmail(v: string): boolean`, `validHandle(v: string): boolean`, `validPassword(v: string): boolean`, `HANDLE_RE`; `createInvite(email: string, role: 'admin' | 'member', createdBy: string): Promise<Invite>`, `findValidInvite(token: string): Promise<Invite | null>`, `markInviteUsed(token: string): Promise<void>` where `Invite = { id, token, email, role, expires_at, used_at, created_by }`.

- [ ] **Step 1: Write the failing validation unit test**

`apps/jags-list/db/validation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { validEmail, validHandle, validPassword } from './validation.js';

describe('validation', () => {
  it('accepts valid and rejects invalid emails', () => {
    expect(validEmail('a@b.co')).toBe(true);
    expect(validEmail('not-an-email')).toBe(false);
    expect(validEmail('a b@c.co')).toBe(false);
  });

  it('enforces the handle format ^[a-z0-9-]{2,32}$', () => {
    expect(validHandle('jag')).toBe(true);
    expect(validHandle('a')).toBe(false);
    expect(validHandle('Uppercase')).toBe(false);
    expect(validHandle('has space')).toBe(false);
    expect(validHandle('x'.repeat(33))).toBe(false);
  });

  it('enforces password length 8..128', () => {
    expect(validPassword('12345678')).toBe(true);
    expect(validPassword('1234567')).toBe(false);
    expect(validPassword('x'.repeat(129))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then implement validation**

Run: `bun test db/validation.test.ts` — expected: FAIL (module missing).

`apps/jags-list/db/validation.ts`:

```ts
export const HANDLE_RE = /^[a-z0-9-]{2,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

export function validHandle(v: string): boolean {
  return HANDLE_RE.test(v);
}

export function validPassword(v: string): boolean {
  return v.length >= 8 && v.length <= 128;
}
```

Run: `bun test db/validation.test.ts` — expected: PASS (3 tests).

- [ ] **Step 3: Write the failing invites integration test**

`apps/jags-list/db/invites.integration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from './client.js';
import { createInvite, findValidInvite, markInviteUsed } from './invites.js';

const CLEANUP_EMAILS = ['invitee-itest@example.com', 'accept-itest@example.com'];

describe.skipIf(!process.env.DATABASE_URL)('invites', () => {
  afterAll(async () => {
    await sql`DELETE FROM invites WHERE email = ANY(${CLEANUP_EMAILS})`;
    await sql`DELETE FROM "user" WHERE email = ANY(${CLEANUP_EMAILS})`;
    await sql.close();
  });

  it('creates and resolves a valid invite', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    expect(invite.token.length).toBeGreaterThanOrEqual(24);
    const found = await findValidInvite(invite.token);
    expect(found?.email).toBe('invitee-itest@example.com');
    expect(found?.role).toBe('member');
  });

  it('a used invite stops resolving', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    await markInviteUsed(invite.token);
    expect(await findValidInvite(invite.token)).toBeNull();
  });

  it('an expired invite stops resolving', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    await sql`UPDATE invites SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = ${invite.token}`;
    expect(await findValidInvite(invite.token)).toBeNull();
  });

  it('accept action creates the user with the invite role and handle, single-use', async () => {
    const { actions } = await import('../pages/invite/[token].js');
    const invite = await createInvite('accept-itest@example.com', 'admin', 'itest-admin');

    const fakeReq = (form: Record<string, string>): any => ({
      path: `/invite/${invite.token}`,
      method: 'POST',
      params: { token: invite.token },
      query: {},
      headers: new Headers(),
      formData: async () => {
        const f = new FormData();
        for (const [k, v] of Object.entries(form)) f.set(k, v);
        return f;
      },
      json: async () => ({}),
      isEnhanced: false,
      layoutsPresent: [],
      prebakeNext: () => {},
    });

    // happy path redirects to /login?welcome=1
    await expect(
      actions.accept(fakeReq({ name: 'Accept Test', handle: 'accepttest', password: 'password-123' })),
    ).rejects.toMatchObject({ type: 'Redirect', message: '/login?welcome=1' });

    const [user] = await sql`SELECT role, handle FROM "user" WHERE email = 'accept-itest@example.com'`;
    expect(user.role).toBe('admin');
    expect(user.handle).toBe('accepttest');

    // second use: invite is spent → NotFound
    await expect(
      actions.accept(fakeReq({ name: 'X', handle: 'xz', password: 'password-123' })),
    ).rejects.toMatchObject({ type: 'NotFound' });
  });

  it('accept action redirects with error codes for bad input', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    const { actions } = await import('../pages/invite/[token].js');
    const fakeReq = (form: Record<string, string>): any => ({
      path: `/invite/${invite.token}`,
      method: 'POST',
      params: { token: invite.token },
      query: {},
      headers: new Headers(),
      formData: async () => {
        const f = new FormData();
        for (const [k, v] of Object.entries(form)) f.set(k, v);
        return f;
      },
      json: async () => ({}),
      isEnhanced: false,
      layoutsPresent: [],
      prebakeNext: () => {},
    });

    await expect(
      actions.accept(fakeReq({ name: '', handle: 'ok-handle', password: 'password-123' })),
    ).rejects.toMatchObject({ message: `/invite/${invite.token}?error=name` });
    await expect(
      actions.accept(fakeReq({ name: 'N', handle: 'BAD HANDLE', password: 'password-123' })),
    ).rejects.toMatchObject({ message: `/invite/${invite.token}?error=handle` });
    await expect(
      actions.accept(fakeReq({ name: 'N', handle: 'ok-handle', password: 'short' })),
    ).rejects.toMatchObject({ message: `/invite/${invite.token}?error=password` });
  });
});
```

(`AppError.redirect(path)` throws an error whose `type` is `'Redirect'` and whose `message` is the path — that is what `buildActionHandler` reads; `AppError.notFound()` throws `type: 'NotFound'`. If the `type` literals differ, check `packages/core/src/errors.ts` and match them — do not loosen the assertions.)

- [ ] **Step 4: Run test to verify it fails**

Run: `bun --env-file=.env test db/invites.integration.test.ts`
Expected: FAIL — `./invites.js` missing.

- [ ] **Step 5: Implement db/invites.ts**

```ts
import { randomBytes } from 'node:crypto';
import { sql } from './client.js';

export interface Invite {
  id: number;
  token: string;
  email: string;
  role: 'admin' | 'member';
  expires_at: Date;
  used_at: Date | null;
  created_by: string;
}

const INVITE_TTL_DAYS = 7;

export async function createInvite(
  email: string,
  role: 'admin' | 'member',
  createdBy: string,
): Promise<Invite> {
  const token = randomBytes(24).toString('base64url');
  const [invite] = await sql`
    INSERT INTO invites (token, email, role, expires_at, created_by)
    VALUES (${token}, ${email}, ${role}, NOW() + (${INVITE_TTL_DAYS} * INTERVAL '1 day'), ${createdBy})
    RETURNING *`;
  return invite as Invite;
}

export async function findValidInvite(token: string): Promise<Invite | null> {
  if (!token) return null;
  const [invite] = await sql`
    SELECT * FROM invites
    WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()`;
  return (invite as Invite) ?? null;
}

export async function markInviteUsed(token: string): Promise<void> {
  await sql`UPDATE invites SET used_at = NOW() WHERE token = ${token}`;
}
```

- [ ] **Step 6: Create the invite acceptance page**

`apps/jags-list/pages/invite/[token].tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { sql } from '../../db/client.js';
import { auth } from '../../lib/auth.js';
import { findValidInvite, markInviteUsed } from '../../db/invites.js';
import { validHandle, validPassword } from '../../db/validation.js';

export async function load(req: KilnRequest) {
  const invite = await findValidInvite(req.params.token ?? '');
  if (!invite) throw AppError.notFound('This invite link is invalid or has expired.');
  return { token: invite.token, email: invite.email, error: req.query.error ?? null };
}

export const actions = {
  async accept(req: KilnRequest) {
    const token = req.params.token ?? '';
    const invite = await findValidInvite(token);
    if (!invite) throw AppError.notFound('This invite link is invalid or has expired.');

    const form = await req.formData();
    const name = String(form.get('name') ?? '').trim();
    const handle = String(form.get('handle') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');

    if (!name) throw AppError.redirect(`/invite/${token}?error=name`);
    if (!validHandle(handle)) throw AppError.redirect(`/invite/${token}?error=handle`);
    if (!validPassword(password)) throw AppError.redirect(`/invite/${token}?error=password`);
    const [taken] = await sql`SELECT 1 AS x FROM "user" WHERE lower(handle) = ${handle}`;
    if (taken) throw AppError.redirect(`/invite/${token}?error=handle-taken`);

    await auth.api.createUser({
      body: { email: invite.email, password, name, role: invite.role, data: { handle } },
    });
    await markInviteUsed(token);
    throw AppError.redirect('/login?welcome=1');
  },
};

const ERRORS: Record<string, string> = {
  name: 'Enter your name.',
  handle: 'Handle must be 2–32 characters: a–z, 0–9, dashes.',
  'handle-taken': 'That handle is taken.',
  password: 'Password must be at least 8 characters.',
};

export default function InvitePage({
  email,
  error,
}: {
  token: string;
  email: string;
  error: string | null;
}) {
  return (
    <section className="auth-card">
      <h1>Join Jag's List</h1>
      <p>
        Creating an account for <strong>{email}</strong>.
      </p>
      {error && <p className="error">{ERRORS[error] ?? 'Something went wrong.'}</p>}
      <form method="post" action="?/accept">
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Handle
          <input name="handle" required pattern="[a-z0-9-]{2,32}" />
        </label>
        <label>
          Password
          <input type="password" name="password" required minLength={8} />
        </label>
        <button type="submit">Create account</button>
      </form>
    </section>
  );
}
```

- [ ] **Step 7: Create the team page**

`apps/jags-list/pages/team.tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { sql } from '../db/client.js';
import { createInvite } from '../db/invites.js';
import { requireAdmin, requireUser } from '../lib/session.js';
import { validEmail } from '../db/validation.js';

interface Member {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  role: string | null;
}

export async function load(req: KilnRequest) {
  const me = await requireUser(req);
  const members = (await sql`
    SELECT id, name, email, handle, role FROM "user" ORDER BY "createdAt" ASC`) as Member[];
  return {
    me,
    members,
    invited: req.query.invited ?? null,
    error: req.query.error ?? null,
  };
}

export const actions = {
  async createInvite(req: KilnRequest) {
    const me = await requireAdmin(req);
    const form = await req.formData();
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const role = form.get('role') === 'admin' ? 'admin' : 'member';
    if (!validEmail(email)) throw AppError.redirect('/team?error=email');
    const invite = await createInvite(email, role, me.id);
    throw AppError.redirect(`/team?invited=${invite.token}`);
  },
};

export default function TeamPage({
  me,
  members,
  invited,
  error,
}: {
  me: { role: string };
  members: Member[];
  invited: string | null;
  error: string | null;
}) {
  return (
    <section>
      <h1>Team</h1>
      {error === 'email' && <p className="error">Enter a valid email address.</p>}
      {invited && (
        <p className="notice">
          Invite created — share this link: <code>{`/invite/${invited}`}</code>
        </p>
      )}
      <ul className="members">
        {members.map((m) => (
          <li key={m.id}>
            <strong>{m.name}</strong> <span className="handle">@{m.handle}</span> · {m.email} ·{' '}
            {m.role ?? 'member'}
          </li>
        ))}
      </ul>
      {me.role === 'admin' && (
        <form method="post" action="?/createInvite" className="invite-form">
          <h2>Invite someone</h2>
          <label>
            Email
            <input type="email" name="email" required />
          </label>
          <label>
            Role
            <select name="role">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button type="submit">Create invite</button>
        </form>
      )}
    </section>
  );
}
```

(Note: better-auth's schema uses camelCase column names — `"createdAt"` must be quoted in SQL.)

- [ ] **Step 8: Run all Task 6 tests**

Run (from `apps/jags-list/`):
`bun test db/validation.test.ts` — expected: PASS.
`bun --env-file=.env test db/invites.integration.test.ts` — expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/jags-list/db/validation.ts apps/jags-list/db/validation.test.ts apps/jags-list/db/invites.ts apps/jags-list/db/invites.integration.test.ts apps/jags-list/pages/team.tsx apps/jags-list/pages/invite
git commit -m "feat(jags-list): invite-only signup — team page, invite acceptance"
```

---

### Task 7: README + full-flow verification

**Files:**
- Create: `apps/jags-list/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documented setup; a verified end-to-end auth flow.

- [ ] **Step 1: Write the README**

`apps/jags-list/README.md`:

```markdown
# Jag's List

Small-team project management on Kiln — the framework's flagship dogfood app.
Spec: `docs/superpowers/specs/2026-07-14-jags-list-design.md`.

## Setup

Requires local Postgres and Redis.

    createdb jagslist
    cp .env.example .env       # set DATABASE_URL and BETTER_AUTH_SECRET
    bun install                # from the repo root
    bun run auth:migrate       # better-auth tables (user/session/account/verification)
    bun run db:migrate         # app tables + pg_notify triggers
    bun run bootstrap-admin -- you@example.com <password> "Your Name" <handle>
    bun run dev                # http://localhost:3200

## Inviting teammates

Sign in as an admin → **Team** → create an invite → share `/invite/<token>`.
Public sign-up is disabled; invites are the only way in.

## Tests

    bun test tests/smoke.test.ts db/validation.test.ts   # unit, no infra
    bun run test:db                                       # needs Postgres
    bun run test:app                                      # spawns the app; needs Postgres + Redis

## Auth architecture (short version)

- better-auth owns `/api/auth/*`; `POST /auth/login` / `/auth/logout` are raw
  Elysia form routes (Kiln actions can't set cookies — spec §9 gap 3).
- `hooks.ts onRequest` gates every route not on the public allowlist,
  including promoted pages and the `/__kiln/fsr` SSE endpoint.
```

- [ ] **Step 2: Run the complete verification sequence**

From `apps/jags-list/`, with `.env` in place:

```bash
bun run build                     # tsc --noEmit — expect: no errors
bun test tests/smoke.test.ts db/validation.test.ts
bun run test:db
bun run test:app
```

Expected: all PASS. Then boot `bun src/main.ts` and walk the flow manually once (login as bootstrapped admin → home shows @handle → Team → create invite → open `/invite/<token>` in a private window → accept → sign in as the new member → Team shows both users). This is the address-book-style browser sanity pass; screenshot-level verification happens in the execution session.

- [ ] **Step 3: Commit**

```bash
git add apps/jags-list/README.md
git commit -m "docs(jags-list): setup and auth architecture README"
```

---

## Post-plan notes for the executor

- **Kiln findings log:** if `createUser`'s `data: { handle }` doesn't persist, if the CSRF middleware blocks the raw `/auth/login` route unexpectedly, or if hooks/`onRequest` behaves differently than documented here, record it in `.memory/bugs.md` and surface it — these feed the framework-improvement backlog (spec §9).
- **Next plan:** Plan 2 (projects/columns/tasks CRUD + Live wiring) gets written after this plan lands, incorporating anything learned here.
