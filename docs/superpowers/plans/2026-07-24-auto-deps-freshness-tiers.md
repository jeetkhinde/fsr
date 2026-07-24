# Auto-Dependencies + Freshness Tiers (Plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop making developers wire cache dependencies by hand, and make per-user FSR scale: `load()` derives its own `depends_on` by observing the SQL it runs; a `kiln sync-triggers` CLI installs the Postgres invalidation triggers; an `owner` value on each invalidation targets one user's snapshots instead of every user's; and an active/dormant freshness split stops the per-user snapshot fan-out (Plan 2) from melting the revalidation loop.

**Architecture:** An opt-in instrumented SQL client (`createKilnSql`) records, per `AsyncLocalStorage` scope, the tables a query reads. `buildPageHandler` runs `load()` inside that scope and unions the observed tables into the slot's `depends_on` — so `Live.value(x)` needs no manual dep-key list. `kiln sync-triggers` introspects the app's tables and idempotently attaches `<table>_kiln_invalidate` triggers (replacing hand-written migration SQL), optionally naming an `owner` column whose value rides the `pg_notify` payload; `invalidateDepKey(depKey, owner?)` then marks only the shared row and that owner's per-user rows stale. Freshness gains two tiers: a snapshot that is SSE-subscribed or was read within `activeWindowSecs` is **active** (eagerly revalidated as today); everything else is **dormant** — invalidation only flips `stale = TRUE`, and the next read rebuilds it lazily. Two Plan-2 review regressions are fixed in-band (SSE/snapshot scoping must apply the identity key only to `bake='user'` routes; the cached-JSON fast path must patch `pageData` alongside `data`).

**Tech Stack:** Bun, TypeScript, Postgres (bun-sql), Redis, bun:test, citty (CLI). No new dependencies (`AsyncLocalStorage` from `node:async_hooks` is built in).

## Global Constraints

- Builds on ADR-016 (PR #12, bake classes) and ADR-017 (PR #13, per-user artifacts). The purity classifier and the `user_key` PK dimension stay authoritative and untouched in shape; this plan only adds columns/params with defaults.
- **Backward compatible by default.** Every new store param is trailing with a default (`owner?` / `activeWindowSecs` etc.); every new config field is optional; auto-deps is additive (observed tables are *unioned* with explicit deps, never replace them); `createKilnSql` is opt-in (apps keeping `new SQL(url)` lose auto-deps but keep manual `Live.value(x, ['tasks'])`, which must keep working unchanged).
- Every task ends `bunx tsc --noEmit`-clean in every touched package with that package's tests passing. Commit per task, messages ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Execution on a fresh worktree (superpowers:using-git-worktrees at execution start); **cd into the worktree explicitly in every Bash call** ([[feedback-worktree-cwd-discipline]]); **rebuild `@kiln/*` dists before any app-level verification** — apps run against `dist`, not `src` (Plan 1 & 2 lesson). jags-list integration test files run as **separate `bun` invocations** (each `afterAll` closes the shared sql client — Plan 1 lesson).
- Schema changes are applied at boot by `FsrStore.initialize()` running `KILN_FSR_SCHEMA_SQL`; every statement in that string must be idempotent and cheap on re-run (Plan 2 review finding #3: the current PK swap is not — see Task 5 for the guarded-migration pattern to reuse).
- Dep keys are the existing `table` (route-wide) and `table:column=value` (row) strings from `depToString` (`packages/core/src/live-prop.ts`). Auto-deps in this plan derives **table-level** keys only; row-level keys stay a manual opt-in via `Live.value(x, [{table,column,value}])`.

**Existing behavior that must NOT change:** `auto`/`'shared'`/`'static'`/`'user'`/`false` bake semantics; the zero-Postgres cached read path for *active* snapshots; `cache_key` variants (still no live registration); tombstones; manual `Live.value(x, ['tasks'])` dep declaration; the LISTEN/NOTIFY reconnect/cursor pipeline (`db-notify.ts`).

**Out of scope (a future Plan 4, stated so no task drifts into them):** shared-shell dedup (one immutable shell + per-user JSON — requires live-marking *every* user-varying field, a separate rendering-split subsystem); eager actor re-materialization after actions (Plan 2 keeps delete-on-write); row-level auto-deps via WHERE-clause parsing; auto-`owner` inference (owner column is declared, not detected). Plan-2 review findings #4 (`loaderTargets` unbounded) and #5 (`RedisCache.slotKey` ignores `variant`) are tracked separately — #4 is folded into Task 7 because dormancy gives it a natural eviction hook; #5 is a one-line dead-param cleanup done in Task 8.

---

## File / Interface Map

- `packages/core/src/sql.ts` **(new)** — `createKilnSql(url)`, the `AsyncLocalStorage` dep-capture scope, `withDepCapture`/`collectDeps` helpers. Exported from `@kiln/core`.
- `packages/core/src/config.ts` — `FsrConfig` gains `autoDeps?`, `activeWindowSecs?`; new `TriggerTableConfig`.
- `packages/engine/src/schema.ts` — `kiln_emit_event` emits `owner`; `kiln_fsr` gains `last_active_at`; guarded-migration helper.
- `packages/engine/src/db-notify.ts` — thread `owner` from payload to `notifyChange/notifyDelete`.
- `packages/engine/src/store.ts` — `invalidateDepKey(depKey, owner?)`; `fetchStaleSlots({ activeWindowSecs })` active-only; `markActive(route, userKey)`; `fetchDormantStaleSlot(route, userKey)`.
- `packages/engine/src/watcher.ts` — `notifyChange/notifyDelete(depKey, owner?)`; revalidation loop passes `activeWindowSecs`.
- `packages/routekit/src/boot.ts` — run `load()` in `withDepCapture`; union observed tables into `upsertSlot` deps; lazy rebuild-on-read for dormant stale snapshots; SSE/snapshot scoping gated on `bake='user'`; `pageData` patched with `data`.
- `packages/cli/src/cli.ts` + `packages/cli/src/sync-triggers.ts` **(new)** — `kiln sync-triggers [--check]`.
- `apps/jags-list/*` — adopt `createKilnSql`, drop manual triggers + dep keys, prove freshness tiers.

---

### Task 1: `owner` on the invalidation payload — schema function, db-notify, store

Foundational for per-user targeting: a trigger may name an owner column; its value rides `pg_notify`; `invalidateDepKey` then scopes the stale-marking to the shared row (`user_key = ''`) plus that owner's per-user rows.

**Files:**
- Modify: `packages/engine/src/schema.ts` — `kiln_emit_event()` reads `TG_ARGV[1]` (owner column name) and adds `owner` to both the events row and the `pg_notify` JSON.
- Modify: `packages/engine/src/db-notify.ts` — parse `owner`, pass to `notifyChange`/`notifyDelete`.
- Modify: `packages/engine/src/watcher.ts` — `notifyChange(depKey, owner?)`, `notifyDelete(depKey, owner?)` forward `owner` to the store.
- Modify: `packages/engine/src/store.ts` — `invalidateDepKey(depKey: string, owner?: string)`.
- Test: `packages/engine/src/store.test.ts`.

**Interfaces:**
- Consumes: existing `kiln_fsr` (`depends_on TEXT[]`, `user_key`, `stale`, `version`), `FsrListStore.invalidateDependency`.
- Produces: `FsrStore.invalidateDepKey(depKey, owner?)` — with `owner` undefined it behaves exactly as today (all `user_key`s); with `owner` set it marks stale only rows where `user_key = ''` OR `user_key = owner`. `FsrWatcher.notifyChange(depKey, owner?)` / `notifyDelete(depKey, owner?)`. Trigger arg contract: `EXECUTE FUNCTION kiln_emit_event('<depKey>' [, '<ownerColumn>'])`. Task 2 (CLI) writes triggers using this contract; Task 5+ rely on per-owner stale-marking.

- [ ] **Step 1: Write the failing test** (append to `store.test.ts`, after the existing `user_key` scoping block ~line 930):

```ts
    // owner-scoped invalidation (ADR-018): a depKey change with an owner marks
    // only that user's per-user row + the shared row stale, not other users'.
    console.log('Testing owner-scoped invalidation...');
    await store.ensureRouteRow('/owned', 300, 3600, 'json');            // shared
    await store.ensureRouteRow('/owned', 300, 3600, 'json', 'u1');
    await store.ensureRouteRow('/owned', 300, 3600, 'json', 'u2');
    await store.upsertSlot('/owned', 'feed', null, [], ['posts'], 0, null, '');   // shared slot
    await store.upsertSlot('/owned', 'feed', null, [], ['posts'], 0, null, 'u1'); // u1 slot
    await store.upsertSlot('/owned', 'feed', null, [], ['posts'], 0, null, 'u2'); // u2 slot
    await store.invalidateDepKey('posts', 'u1');
    const inspect = await store.fetchAllForInspect();
    const slotOf = (uk: string) => inspect.find(r => r.route === '/owned' && r.slot === 'feed' && r.userKey === uk);
    assert.equal(slotOf('')?.stale, true);   // shared always invalidated
    assert.equal(slotOf('u1')?.stale, true);  // owner invalidated
    assert.equal(slotOf('u2')?.stale, false); // other user untouched
```

- [ ] **Step 2: Run to verify failure** — `cd .worktrees/<wt> && bun --env-file=test-app/.env packages/engine/src/store.test.ts` → FAIL (`u2` slot also stale: today's `invalidateDepKey` ignores `owner` and marks every `user_key`).

- [ ] **Step 3: Implement the store.** Replace `invalidateDepKey` (`store.ts:170`) with an owner-aware WHERE:

```ts
  async invalidateDepKey(depKey: string, owner?: string): Promise<string[]> {
    // owner undefined → every user_key (route-wide change, today's behavior).
    // owner set → the shared row ('') plus that one user's rows only, so a
    // per-user snapshot fan-out doesn't invalidate on another user's write.
    const rows = owner === undefined
      ? await this.sql`
          UPDATE kiln_fsr SET stale = TRUE, version = version + 1
          WHERE ${depKey} = ANY(depends_on) AND slot != '' RETURNING route`
      : await this.sql`
          UPDATE kiln_fsr SET stale = TRUE, version = version + 1
          WHERE ${depKey} = ANY(depends_on) AND slot != ''
            AND (user_key = '' OR user_key = ${owner}) RETURNING route`;
    const listRoutes = await this.lists.invalidateDependency(depKey);
    const routes = Array.from(new Set([
      ...rows.map((r: any) => String(r.route)),
      ...listRoutes,
    ])).sort();
    if (this.redis) {
      await Promise.all(routes.map((route) =>
        this.redis!.publishInvalidate({ route, slots: [], deps: [depKey] }).catch(() => {})));
    }
    return routes;
  }
```

- [ ] **Step 4: Implement the schema function.** In `schema.ts`, in `kiln_emit_event()`, after `record_id` is set, resolve the owner value when a second trigger arg is present, and add it to both sinks:

```sql
  IF TG_NARGS > 1 THEN
    IF TG_OP = 'DELETE' THEN
      EXECUTE format('SELECT ($1).%I::text', TG_ARGV[1]) INTO owner_val USING OLD;
    ELSE
      EXECUTE format('SELECT ($1).%I::text', TG_ARGV[1]) INTO owner_val USING NEW;
    END IF;
  END IF;
```

Declare `owner_val TEXT;` in the `DECLARE` block, add `'owner', owner_val` to the `jsonb_build_object` for the events row and to `json_build_object` for `pg_notify`. `CREATE OR REPLACE FUNCTION` makes this a no-op-safe redeploy.

- [ ] **Step 5: Implement db-notify + watcher.** In `db-notify.ts` `wireClient`, destructure `owner` from the payload and pass it through:

```ts
        const { depKey, id, op, eventId, owner } = payload;
        const work: Promise<void>[] = [];
        if (op === 'DELETE') {
          if (depKey) work.push(watcher.notifyDelete(depKey, owner));
          if (depKey && id != null) work.push(watcher.notifyDelete(`${depKey}:${id}`, owner));
        } else {
          if (depKey) work.push(watcher.notifyChange(depKey, owner));
          if (depKey && id != null) work.push(watcher.notifyChange(`${depKey}:${id}`, owner));
        }
```

In `watcher.ts`, extend the two methods (currently ~line 215/231):

```ts
  notifyChange(depKey: string, owner?: string): Promise<void> {
    return this.store.invalidateDepKey(depKey, owner)
      .then(() => {}).catch((e: any) =>
        console.warn(`FSR watcher: notifyChange failed for ${depKey}:`, e.message));
  }
  notifyDelete(depKey: string, owner?: string): Promise<void> {
    return this.store.invalidateDepKey(depKey, owner)
      .then(() => {}).catch((e: any) =>
        console.warn(`FSR watcher: notifyDelete failed for ${depKey}:`, e.message));
  }
```

(Keep the exact body shape these methods already have — only the `owner` param + forwarding is new.) The internal `catchUpFromCursor` path (`store.invalidateDepKey(depKey)` at watcher.ts:275) can stay owner-less: the events table doesn't yet persist `owner` in a queryable column, so cursor catch-up conservatively invalidates route-wide. Note this in a code comment.

- [ ] **Step 6: Verify** — store test PASSES; `bun run test:integration` green (the DB-notify pipeline suite still passes with the enriched payload — `owner` is absent for triggers created without the 2nd arg, and `undefined` destructures cleanly); engine tsc clean; rebuild engine dist.
- [ ] **Step 7: Commit** — `feat(engine): owner-scoped invalidation — kiln_emit_event emits owner, invalidateDepKey targets it`

---

### Task 2: `kiln sync-triggers` CLI

Introspect the app's tables and idempotently install `<table>_kiln_invalidate` triggers calling `kiln_emit_event('<depKey>' [, '<ownerColumn>'])`, replacing hand-written migration trigger SQL. `--check` exits non-zero if any table is missing its trigger (CI guard).

**Files:**
- Modify: `packages/core/src/config.ts` — add `TriggerTableConfig` and `FsrConfig.triggerTables?`.
- Create: `packages/cli/src/sync-triggers.ts` — introspection + DDL.
- Modify: `packages/cli/src/cli.ts` — register `syncTriggersCommand`.
- Test: `packages/cli/src/sync-triggers.test.ts` **(new)**.

**Interfaces:**
- Consumes: `kiln_emit_event` (Task 1). `config.fsr.postgresUrl`.
- Produces: `syncTriggers(sql, tables, { check }): Promise<{ table: string; action: 'created'|'exists'|'missing' }[]>` where `tables: TriggerTableConfig[]`. `TriggerTableConfig = { table: string; depKey?: string; ownerColumn?: string; events?: ('insert'|'update'|'delete')[] }` (`depKey` defaults to `table`; `events` defaults to all three). CLI command `kiln sync-triggers [--check]`.

- [ ] **Step 1: Write the failing test** (`sync-triggers.test.ts` — uses the live test DB like `store.test.ts`):

```ts
import assert from 'node:assert';
import { SQL } from 'bun';
import { syncTriggers, triggerName } from './sync-triggers.js';

const sql = new SQL(process.env.DATABASE_URL!);
await sql`DROP TABLE IF EXISTS synctrig_demo CASCADE`;
await sql`CREATE TABLE synctrig_demo (id BIGSERIAL PRIMARY KEY, owner_id TEXT)`;
// kiln_emit_event must exist — apply the engine schema first in real runs;
// here assume the shared test DB already has it (store.test.ts initializes it).

// 1. create
let res = await syncTriggers(sql, [{ table: 'synctrig_demo', ownerColumn: 'owner_id' }], { check: false });
assert.equal(res[0].action, 'created');
const exists = await sql`
  SELECT 1 FROM pg_trigger WHERE tgname = ${triggerName('synctrig_demo')} AND NOT tgisinternal`;
assert.equal(exists.length, 1);

// 2. idempotent
res = await syncTriggers(sql, [{ table: 'synctrig_demo', ownerColumn: 'owner_id' }], { check: false });
assert.equal(res[0].action, 'exists');

// 3. --check on a table WITHOUT a trigger reports missing, creates nothing
await sql`DROP TABLE IF EXISTS synctrig_bare CASCADE`;
await sql`CREATE TABLE synctrig_bare (id BIGSERIAL PRIMARY KEY)`;
res = await syncTriggers(sql, [{ table: 'synctrig_bare' }], { check: true });
assert.equal(res[0].action, 'missing');
const bare = await sql`SELECT 1 FROM pg_trigger WHERE tgname = ${triggerName('synctrig_bare')} AND NOT tgisinternal`;
assert.equal(bare.length, 0);

await sql`DROP TABLE IF EXISTS synctrig_demo CASCADE`;
await sql`DROP TABLE IF EXISTS synctrig_bare CASCADE`;
await sql.end();
console.log('sync-triggers tests passed');
```

- [ ] **Step 2: Run → FAIL** — `cd .worktrees/<wt> && bun --env-file=test-app/.env packages/cli/src/sync-triggers.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `sync-triggers.ts`:**

```ts
import type { SQL } from 'bun';
import type { TriggerTableConfig } from '@kiln/core';

export const triggerName = (table: string) => `${table}_kiln_invalidate`;

export interface SyncResult { table: string; action: 'created' | 'exists' | 'missing'; }

/** Idempotently attach the kiln_invalidate trigger to each configured table.
 * check:true never writes — it reports which tables lack the trigger (CI). */
export async function syncTriggers(
  sql: SQL,
  tables: TriggerTableConfig[],
  opts: { check: boolean },
): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const t of tables) {
    const name = triggerName(t.table);
    const existing = await sql`
      SELECT 1 FROM pg_trigger WHERE tgname = ${name} AND NOT tgisinternal`;
    if (existing.length > 0) { out.push({ table: t.table, action: 'exists' }); continue; }
    if (opts.check) { out.push({ table: t.table, action: 'missing' }); continue; }

    const depKey = t.depKey ?? t.table;
    const events = (t.events ?? ['insert', 'update', 'delete'])
      .map((e) => e.toUpperCase()).join(' OR ');
    // Trigger args are string literals: depKey, then the optional owner column.
    // Identifiers (table/trigger name) are validated below, never interpolated raw.
    assertIdent(t.table); assertIdent(name);
    if (t.ownerColumn) assertIdent(t.ownerColumn);
    const args = t.ownerColumn
      ? `'${depKey.replace(/'/g, "''")}', '${t.ownerColumn}'`
      : `'${depKey.replace(/'/g, "''")}'`;
    await sql.unsafe(
      `CREATE TRIGGER ${name} AFTER ${events} ON ${t.table} ` +
      `FOR EACH ROW EXECUTE FUNCTION kiln_emit_event(${args})`);
    out.push({ table: t.table, action: 'created' });
  }
  return out;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdent(s: string): void {
  if (!IDENT.test(s)) throw new Error(`[kiln] unsafe SQL identifier: ${JSON.stringify(s)}`);
}
```

Add to `config.ts`:

```ts
export interface TriggerTableConfig {
  table: string;
  /** Dep key emitted on change; defaults to the table name. */
  depKey?: string;
  /** Column whose value scopes per-user invalidation (owner in the payload). */
  ownerColumn?: string;
  events?: ('insert' | 'update' | 'delete')[];
}
```
and `triggerTables?: TriggerTableConfig[];` on `FsrConfig`.

- [ ] **Step 4: Register the CLI command** in `cli.ts`:

```ts
const syncTriggersCommand = defineCommand({
  meta: { name: 'sync-triggers', description: 'Install/verify Postgres invalidation triggers' },
  args: { check: { type: 'boolean', description: 'Report missing triggers, write nothing', default: false } },
  async run({ args }) {
    const config = await loadKilnConfig();
    if (!config.fsr?.postgresUrl) { consola.error('fsr.postgresUrl required'); process.exit(1); }
    const tables = config.fsr.triggerTables ?? [];
    if (tables.length === 0) { consola.warn('No fsr.triggerTables configured; nothing to do.'); return; }
    const sql = new SQL(config.fsr.postgresUrl);
    const store = new FsrStore(sql);
    await store.initialize(); // ensures kiln_emit_event exists before we reference it
    const { syncTriggers } = await import('./sync-triggers.js');
    const results = await syncTriggers(sql, tables, { check: args.check });
    for (const r of results) consola.info(`  ${r.table}: ${r.action}`);
    sql.close();
    if (args.check && results.some((r) => r.action === 'missing')) {
      consola.error('Missing triggers (run without --check to install).'); process.exit(1);
    }
    consola.success(args.check ? 'All triggers present.' : 'Triggers synced.');
  },
});
```

Add `'sync-triggers': syncTriggersCommand` to `mainCommand.subCommands`.

- [ ] **Step 5: Verify** — sync-triggers test PASSES; `bunx tsc --noEmit` clean in `core` (rebuild core dist first) and `cli`; `kiln --help` lists `sync-triggers`.
- [ ] **Step 6: Commit** — `feat(cli,core): kiln sync-triggers installs/verifies invalidation triggers`

---

### Task 3: Instrumented SQL client — per-`load()` table capture

`createKilnSql(url)` wraps bun's `SQL` tagged-template so each executed query records the table names it references into the current `AsyncLocalStorage` dep-capture scope. No scope active → zero overhead, behaves as a plain client.

**Files:**
- Create: `packages/core/src/sql.ts`.
- Modify: `packages/core/src/index.ts` — export `createKilnSql`, `withDepCapture`, `collectDeps`.
- Test: `packages/core/src/sql.test.ts` **(new)**.

**Interfaces:**
- Produces: `createKilnSql(url: string): SQL` (same call shape as `new SQL(url)` for tagged-template queries). `withDepCapture<T>(fn: () => Promise<T>): Promise<{ result: T; tables: Set<string> }>` runs `fn` in a fresh capture scope and returns the tables observed. `collectDeps(): Set<string> | null` returns the active scope's set (or null). Task 4 wraps `load()` in `withDepCapture`.

- [ ] **Step 1: Write the failing test** (`sql.test.ts`):

```ts
import assert from 'node:assert';
import { createKilnSql, withDepCapture } from './sql.js';

const sql = createKilnSql(process.env.DATABASE_URL!);
await sql`DROP TABLE IF EXISTS captest CASCADE`;
await sql`CREATE TABLE captest (id INT)`;
await sql`INSERT INTO captest VALUES (1)`;

// inside a capture scope, a SELECT records its table
const { result, tables } = await withDepCapture(async () => {
  return await sql`SELECT id FROM captest WHERE id = 1`;
});
assert.equal(result[0].id, 1);
assert.ok(tables.has('captest'), `expected captest in ${[...tables]}`);

// join captures both tables
await sql`DROP TABLE IF EXISTS captest2 CASCADE`;
await sql`CREATE TABLE captest2 (id INT)`;
const { tables: joined } = await withDepCapture(async () => {
  return await sql`SELECT a.id FROM captest a JOIN captest2 b ON a.id = b.id`;
});
assert.ok(joined.has('captest') && joined.has('captest2'), [...joined].join(','));

// no scope → no throw, query still works
const rows = await sql`SELECT id FROM captest`;
assert.equal(rows[0].id, 1);

await sql`DROP TABLE IF EXISTS captest CASCADE`;
await sql`DROP TABLE IF EXISTS captest2 CASCADE`;
await sql.end();
console.log('createKilnSql capture tests passed');
```

- [ ] **Step 2: Run → FAIL** — `cd .worktrees/<wt> && bun --env-file=test-app/.env packages/core/src/sql.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `sql.ts`:**

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { SQL } from 'bun';

const depScope = new AsyncLocalStorage<Set<string>>();

/** Tables named after FROM / JOIN / INTO / UPDATE in a SQL string. Best-effort
 * and case-insensitive; schema-qualified names keep only the table part.
 * Over-capture (an extra table) only causes an extra revalidation, never a
 * stale serve, so a loose regex is the safe failure direction. */
export function extractTables(query: string): string[] {
  const cleaned = query.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?"?([a-zA-Z_][\w.]*)"?/gi;
  const out = new Set<string>();
  for (const m of cleaned.matchAll(re)) {
    const name = m[1].toLowerCase().split('.').pop()!;
    out.add(name);
  }
  return [...out];
}

export function collectDeps(): Set<string> | null {
  return depScope.getStore() ?? null;
}

export async function withDepCapture<T>(fn: () => Promise<T>): Promise<{ result: T; tables: Set<string> }> {
  const tables = new Set<string>();
  const result = await depScope.run(tables, fn);
  return { result, tables };
}

/** A bun SQL client that records queried tables into the active capture scope
 * (withDepCapture). Outside a scope it is a plain client. Opt-in: apps that
 * keep `new SQL(url)` simply get no auto-deps. */
export function createKilnSql(url: string): SQL {
  const base = new SQL(url);
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const scope = depScope.getStore();
    if (scope) for (const t of extractTables(strings.join(' ? '))) scope.add(t);
    return (base as any)(strings, ...values);
  };
  // Preserve helpers (.begin, .unsafe, .close, .end, etc.) by proxying misses.
  return new Proxy(wrapped as any, {
    get(_t, prop) {
      const v = (base as any)[prop];
      return typeof v === 'function' ? v.bind(base) : v;
    },
  }) as unknown as SQL;
}
```

Export the three from `core/src/index.ts`: `export { createKilnSql, withDepCapture, collectDeps, extractTables } from './sql.js';`

- [ ] **Step 4: Verify** — capture test PASSES; core tsc clean; rebuild core dist.
- [ ] **Step 5: Commit** — `feat(core): createKilnSql + withDepCapture — observe tables read during load()`

---

### Task 4: Auto-derived `depends_on` in `buildPageHandler`

Run `load()` inside `withDepCapture`; union the observed tables into every live slot's `depends_on` so `Live.value(x)` (no explicit deps) still revalidates when its underlying tables change. Explicit deps are preserved and unioned, never replaced.

**Files:**
- Modify: `packages/routekit/src/boot.ts` — wrap the page `load()` call; thread captured tables into the `upsertSlot` deps for each live field.
- Test: `packages/routekit/src/boot.test.ts`.

**Interfaces:**
- Consumes: `withDepCapture`/`collectDeps` (Task 3); `store.upsertSlot(route, slot, query, params, dependsOn, debounce, columnName, userKey)` (Task 2/ADR-017 signature).
- Produces: for each live field, `dependsOn = unique([...field.dependsOn ?? [], ...observedTables])`. No new exported symbol; behavioral only.

- [ ] **Step 1: Write the failing test** (append to `boot.test.ts`). Uses a fake store capturing `upsertSlot` args and a `load()` that runs a captured query. Follow the file's existing handler-helper + fake-store pattern:

```ts
  it('auto-derives depends_on from tables read during load()', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-autodep-'));
    const { createElement } = await import('react');
    const { withDepCapture } = await import('@kiln/core'); // capture is real
    const { Live } = await import('@kiln/core');
    const upserts: any[] = [];
    const fakeStore = makeFakeStore({ onUpsertSlot: (...a: any[]) => upserts.push(a) });
    const pageModule = {
      load: async () => {
        // simulate a captured query by adding to the active scope directly:
        const { collectDeps } = await import('@kiln/core');
        collectDeps()?.add('tasks');
        return { count: Live.value(0) }; // live field, NO explicit deps
      },
      default: ({ count }: any) => createElement('div', null, `n=${count}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/auto', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [], { cacheDir: tmpDir, ttlSecs: 0, redis: null }, undefined, fakeStore as any, makeFakeWatcher() as any,
    );
    await handler(makeReq({ path: '/auto' }) as any, makeRes());
    const countUpsert = upserts.find((a) => a[1] === 'count');
    expect(countUpsert).toBeDefined();
    expect(countUpsert[4]).toContain('tasks'); // dependsOn arg (index 4) unions the observed table
    await fs.rm(tmpDir, { recursive: true });
  });
```

- [ ] **Step 2: Run → FAIL** — `bun test packages/routekit/src/boot.test.ts -t auto-derives` → FAIL (load() isn't run under capture; `dependsOn` is `[]`).

- [ ] **Step 3: Implement.** In `boot.ts`, the page `load()` invocation inside `loadPageProps` currently calls `module.load(purityTracker.proxied)` directly. Wrap it and stash the observed tables on a handler-scoped var:

```ts
    let observedTables: string[] = [];
    // ... inside loadPageProps, replacing the direct load() call:
    const { result, tables } = await withDepCapture(async () =>
      typeof module.load === 'function' ? await module.load(purityTracker.proxied) : {});
    observedTables = [...tables];
    const loaded = result;
```

Import `withDepCapture` from `@kiln/core` at the top. Then at each `store.upsertSlot(...)` call site for live fields (the step-12 loop and the early `registerLoader` slot writes), union the tables into the deps arg:

```ts
        const deps = Array.from(new Set([
          ...(field.dependsOn ? [field.dependsOn] : []),
          ...observedTables,
        ]));
        await store.upsertSlot(req.path, field.name, null, [], deps,
          field.debounce ?? options.debounce ?? kilnConfig?.fsr?.patchDebounceSecs, null, userKey);
```

Gate the union behind `kilnConfig?.fsr?.autoDeps !== false` (default on) so an app can disable it. Add `autoDeps?: boolean;` to `FsrConfig` (`config.ts`).

- [ ] **Step 4: Verify** — new test PASSES; full `bun test packages/routekit` green (existing manual-dep tests unaffected — union is a superset); tsc clean; rebuild routekit dist.
- [ ] **Step 5: Commit** — `feat(routekit,core): auto-derive slot depends_on from tables read in load()`

---

### Task 5: Active/dormant freshness — schema + store

Add `last_active_at` to route rows. `fetchStaleSlots` eagerly claims a stale slot only when its route row is **active** (SSE-subscribed this window, tracked in Task 7, or read within `activeWindowSecs`). Dormant stale slots are left `stale = TRUE` for lazy rebuild (Task 6). Also lands the Plan-2 review-#3 guarded-migration pattern for the PK swap.

**Files:**
- Modify: `packages/engine/src/schema.ts` — `ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;`; convert the ADR-017 PK swap block to the guarded form below.
- Modify: `packages/engine/src/store.ts` — `markActive(route, userKey)`; `fetchStaleSlots({ activeWindowSecs })`; `fetchDormantStaleSlot(route, userKey)`.
- Test: `packages/engine/src/store.test.ts`.

**Interfaces:**
- Produces: `FsrStore.markActive(route: string, userKey?: string): Promise<void>` (sets `last_active_at = NOW()` on the route row). `FsrStore.fetchStaleSlots(opts?: { activeWindowSecs?: number }): Promise<StaleSlot[]>` — with `activeWindowSecs` set, only returns slots whose route row was active within the window (or is SSE-pinned via `last_active_at` bumps); default (undefined) = today's behavior (all stale/revalidate-due slots). `FsrStore.fetchDormantStaleSlot(route, userKey?): Promise<StaleSlot | null>` — returns a single stale slot for on-read rebuild regardless of activity. Task 6 calls `fetchDormantStaleSlot`; Task 7 calls `markActive`; the watcher (Task 6 step) passes `activeWindowSecs`.

- [ ] **Step 1: Write the failing test** (append to `store.test.ts`):

```ts
    // active/dormant tiers (ADR-018)
    console.log('Testing active/dormant freshness...');
    await store.ensureRouteRow('/active-r', 300, 3600, 'json');
    await store.ensureRouteRow('/dormant-r', 300, 3600, 'json');
    await store.upsertSlot('/active-r', 's', null, [], ['dep_x'], 0);
    await store.upsertSlot('/dormant-r', 's', null, [], ['dep_x'], 0);
    await store.invalidateDepKey('dep_x'); // both slots now stale
    await store.markActive('/active-r');    // only active-r pinged
    const active = await store.fetchStaleSlots({ activeWindowSecs: 60 });
    const routes = active.map((s) => s.route);
    assert.ok(routes.includes('/active-r'), 'active route revalidated eagerly');
    assert.ok(!routes.includes('/dormant-r'), 'dormant route NOT claimed eagerly');
    // dormant slot is still individually fetchable for on-read rebuild
    const dormant = await store.fetchDormantStaleSlot('/dormant-r');
    assert.equal(dormant?.slot, 's');
```

- [ ] **Step 2: Run → FAIL** — `bun --env-file=test-app/.env packages/engine/src/store.test.ts` → FAIL (`markActive`/param/`fetchDormantStaleSlot` undefined; dormant route is claimed).

- [ ] **Step 3: Schema.** Add after the ADR-017 block in `schema.ts`:

```sql
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
```

Replace the ADR-017 unconditional PK swap (schema.ts, the `DROP CONSTRAINT ... ADD CONSTRAINT ... PRIMARY KEY (route, user_key, slot)` pair) with a guarded block that only rebuilds the index when the PK columns are actually wrong (Plan-2 review #3):

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_constraint c ON c.conindid = i.indexrelid
    WHERE c.conname = 'kiln_fsr_pkey'
      AND (SELECT array_agg(attname ORDER BY attnum) FROM pg_attribute
           WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey))
          = ARRAY['route','user_key','slot']::name[]
  ) THEN
    ALTER TABLE kiln_fsr DROP CONSTRAINT IF EXISTS kiln_fsr_pkey;
    ALTER TABLE kiln_fsr ADD CONSTRAINT kiln_fsr_pkey PRIMARY KEY (route, user_key, slot);
  END IF;
END $$;
```

(Apply the same guarded shape to `kiln_fsr_lists_pkey` / `ARRAY['route','user_key','name']`.)

- [ ] **Step 4: Store.** Add `markActive`:

```ts
  async markActive(route: string, userKey = ''): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr SET last_active_at = NOW()
      WHERE route = ${route} AND slot = '' AND user_key = ${userKey}`;
  }
```

Give `fetchStaleSlots` an options arg; when `activeWindowSecs` is provided, add to the `candidates` CTE WHERE (joined route row `r`):

```sql
        AND ($ACTIVE_WINDOW IS NULL OR
             (r.last_active_at IS NOT NULL
              AND r.last_active_at + ($ACTIVE_WINDOW * interval '1 second') >= NOW()))
```

Implement by branching the tagged template on `opts?.activeWindowSecs` (mirror the existing two-branch pattern in `fetchSlotsForSnapshot`): one query with the extra predicate binding `${activeWindowSecs}`, one without. Add `fetchDormantStaleSlot(route, userKey = '')` returning the first `stale = TRUE` non-empty slot for `(route, userKey)` mapped to `StaleSlot` (reuse the SELECT+map shape from `fetchSlotsForSnapshot`, add `WHERE s.stale = TRUE ... LIMIT 1`, no `refresh_claimed_until` mutation — on-read rebuild is synchronous and single-shot).

- [ ] **Step 5: Verify** — store test PASSES; `bun run test:integration` green (existing `fetchStaleSlots()` no-arg callers get today's behavior); engine tsc clean; rebuild engine dist.
- [ ] **Step 6: Commit** — `feat(engine): active/dormant freshness — last_active_at, activeWindowSecs, dormant fetch; guarded PK migration`

---

### Task 6: Lazy rebuild-on-read for dormant stale snapshots + watcher active-window

Wire the tiers into the read/refresh paths: the watcher's eager loop passes `activeWindowSecs` (so it only revalidates active snapshots); the page read path, on a cache hit whose slot row is dormant-stale, rebuilds that snapshot synchronously before serving so a dormant page is never served known-stale.

**Files:**
- Modify: `packages/engine/src/watcher.ts` — the stale-slot fetch (`store.fetchStaleSlots()` ~line 423) passes `{ activeWindowSecs: this.config.activeWindowSecs }`.
- Modify: `packages/routekit/src/boot.ts` — after a validated cache hit, if `store.fetchDormantStaleSlot(req.path, userKey)` returns a row, delete the artifact and fall through to a fresh render (simplest correct rebuild) instead of serving the stale cache.
- Modify: `packages/engine/src/watcher.ts` config type + `cli.ts` `initFsr` — thread `activeWindowSecs` from `config.fsr`.
- Test: `packages/routekit/src/boot.test.ts`, `packages/engine/src/watcher.test.ts`.

**Interfaces:**
- Consumes: `fetchDormantStaleSlot`, `fetchStaleSlots({activeWindowSecs})`, `markActive` (Task 5).
- Produces: no new exports; `FsrWatcherConfig` gains `activeWindowSecs?: number`; `FsrConfig.activeWindowSecs?` already added in Task 4's config edit (if not, add here).

- [ ] **Step 1: Write the failing test** (boot.test.ts) — a `bake='user'`-off plain baked route: bake it, mark its slot stale via the store, next GET must re-run `load()` (fresh) rather than serve the stale artifact:

```ts
  it('rebuilds a dormant stale snapshot on read instead of serving it stale', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-dormant-'));
    const { createElement } = await import('react');
    let n = 0;
    const store = makeRealOrFakeStoreWithStale(); // fake: fetchDormantStaleSlot returns a row once, then null
    const pageModule = {
      load: async () => ({ n: ++n }),
      default: ({ n }: any) => createElement('div', null, `n=${n}`),
    };
    const handler = buildPageHandler(pageModule,
      { pattern: '/dz', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [], { cacheDir: tmpDir, ttlSecs: 0, redis: null }, undefined, store as any);
    await handler(makeReq({ path: '/dz' }) as any, makeRes());        // bake n=1
    store.__setDormantStale('/dz', '', true);                         // slot goes stale, dormant
    const r2 = makeRes();
    await handler(makeReq({ path: '/dz' }) as any, r2);
    expect(r2.captured.body).toContain('n=2');                        // rebuilt, not served stale
    expect(n).toBe(2);
    await fs.rm(tmpDir, { recursive: true });
  });
```

(Extend the file's fake-store helper with `__setDormantStale`/`fetchDormantStaleSlot` returning one row then null.)

- [ ] **Step 2: Run → FAIL** — `bun test packages/routekit/src/boot.test.ts -t "dormant stale"` → FAIL (cache hit served as `n=1`).

- [ ] **Step 3: Implement read path.** In `boot.ts`, at the validated-cache-hit branch (after `materialized` passes signature + buildId checks, before `respondWith...`), add:

```ts
    if (materialized && store && typeof store.fetchDormantStaleSlot === 'function') {
      const dormant = await store.fetchDormantStaleSlot(req.path, userKey);
      if (dormant) {
        // A dormant snapshot went stale without eager revalidation (Task 5).
        // Rebuild on this read rather than serve known-stale data; the fresh
        // render below re-bakes and clears the stale flag via markFresh.
        await cache.delete(req.path, variant);
        materialized = null;
      }
    }
```

Ensure the fresh-render path clears staleness: after a successful re-bake for a live route, the existing `store.markFresh` in the slot-refresh path handles it; if not reached on a plain read-render, call `store.markFresh(req.path, dormantSlot, userKey)` isn't needed because re-`upsertSlot` in step 12 resets `stale` — verify the `upsertSlot` `ON CONFLICT` sets `stale = FALSE` or add it to the conflict SET. (Check `upsertSlot`; if it doesn't reset `stale`, add `stale = FALSE` to its `ON CONFLICT DO UPDATE SET` — a fresh render's slot is fresh by definition.)

- [ ] **Step 4: Implement watcher window.** In `watcher.ts`, change the stale fetch to `await this.store.fetchStaleSlots({ activeWindowSecs: this.config.activeWindowSecs })`. Add `activeWindowSecs?: number` to the watcher config interface; in `cli.ts` `initFsr`, pass `activeWindowSecs: config.fsr.activeWindowSecs ?? 30` into the `new FsrWatcher(...)` options. Add a watcher test asserting a stale slot on a route with no recent `last_active_at` is NOT returned by the loop's fetch, but IS after `markActive`.

- [ ] **Step 5: Verify** — both new tests PASS; `bun run test:integration` + `bun test packages/routekit` green; tsc clean in engine + routekit; rebuild both dists.
- [ ] **Step 6: Commit** — `feat(engine,routekit): dormant snapshots rebuild on read; watcher revalidates only active snapshots`

---

### Task 7: Activity signals — SSE subscription pins a snapshot active (+ bounded loader registry)

An SSE subscriber to a `(route, user)` snapshot marks it active for the window, so a page someone is actively watching gets eager patches; closing the last stream lets it fall dormant. Folds in Plan-2 review #4: evict the per-`(route,user)` loader registration when its snapshot is purged/dormant so `loaderTargets` stops growing unbounded.

**Files:**
- Modify: `packages/routekit/src/boot.ts` — the `/__kiln/fsr` SSE handler calls `store.markActive(route, sseUserKey)` on subscribe and on each keepalive tick.
- Modify: `packages/engine/src/watcher.ts` — `unregisterLoader(route, userKey?)`; call it from `purgeInactiveRoutes` handling (evicted routes) so registrations don't leak.
- Test: `packages/engine/src/watcher.test.ts`, and a boot.test.ts assertion that subscribe calls `markActive`.

**Interfaces:**
- Consumes: `markActive` (Task 5); `fsrHubStream` (ADR-017).
- Produces: `FsrWatcher.unregisterLoader(route: string, userKey?: string): void` (deletes the `loaderKey(route, userKey)` entry). SSE handler side effect: `markActive` on subscribe + keepalive.

- [ ] **Step 1: Write the failing test** (watcher.test.ts) — register a loader, confirm it fires on invalidation, `unregisterLoader`, confirm it no longer fires:

```ts
    console.log('Verifying loader unregistration...');
    const urRoute = '/unreg-route';
    await store.ensureRouteRow(urRoute, 300, 3600, 'json', 'u9');
    await store.setBakedPaths(urRoute, './tmp_unreg.html', './tmp_unreg.json', 'u9');
    await fs.writeFile('./tmp_unreg.html', '<html><body><div s-live="g">x</div></body></html>');
    await fs.writeFile('./tmp_unreg.json', JSON.stringify({ schemaVersion: 1, renderVersion: 1, data: { g: 'old' }, updatedAt: new Date().toISOString() }));
    await store.upsertSlot(urRoute, 'g', null, [], ['unreg_dep'], 0, null, 'u9');
    let fired = 0;
    watcher.registerLoader({ route: urRoute, userKey: 'u9', load: async () => { fired++; return { g: 'new' }; } });
    watcher.unregisterLoader(urRoute, 'u9');
    patches.length = 0;
    await store.invalidateDepKey('unreg_dep', 'u9');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fired, 0, 'unregistered loader must not run');
    await fs.unlink('./tmp_unreg.html').catch(() => {});
    await fs.unlink('./tmp_unreg.json').catch(() => {});
```

- [ ] **Step 2: Run → FAIL** — `bun --env-file=test-app/.env packages/engine/src/watcher.test.ts` → FAIL (`unregisterLoader` undefined).

- [ ] **Step 3: Implement.** In `watcher.ts`:

```ts
  unregisterLoader(route: string, userKey?: string): void {
    this.loaderTargets.delete(loaderKey(route, userKey));
  }
```

In the idle-eviction handler where `purgeInactiveRoutes` returns evicted routes, call `this.unregisterLoader(route, userKey)` for each evicted `(route, userKey)` (the evicted-route shape carries `route`; extend `EvictedRoute`/the purge RETURNING to include `user_key as "userKey"` if not already present, mapping to `userKey`, then unregister). This bounds `loaderTargets` to live snapshots.

In `boot.ts` `/__kiln/fsr` handler, after computing `sseUserKey`, mark active on subscribe and wire keepalive:

```ts
      if (options.store && sseUserKey !== undefined) {
        await options.store.markActive?.(route, sseUserKey);
      }
```

(`markActive` on subscribe is enough to satisfy the tier; a long-lived stream re-pings via the existing keepalive tick — add a `store.markActive` call in the keepalive branch of the stream consumer if the handler owns that loop, otherwise document that `connectionTtlSecs` bounds staleness of the active flag and rely on reconnect re-pinging.)

- [ ] **Step 4: Verify** — watcher test PASSES; boot subscribe test PASSES; integration green; tsc clean; rebuild dists.
- [ ] **Step 5: Commit** — `feat(engine,routekit): SSE subscription pins snapshot active; evict loaders on purge (bounds registry)`

---

### Task 8: Plan-2 review regressions — SSE/snapshot scoping gated on `bake='user'`; cached-JSON `pageData` freshness; slotKey cleanup

Fix the two Plan-2 behavior regressions in the exact plumbing this plan touches, plus the dead-`variant` param on `RedisCache.slotKey` (review #5).

**Files:**
- Modify: `packages/routekit/src/boot.ts` — build a `Map<pattern, BakeMode>` at page registration; the `/__kiln/fsr` + snapshot handlers apply the identity user key **only** when the subscribed route's bake mode is `'user'` (else `userKey = ''`).
- Modify: `packages/engine/src/watcher.ts` + `packages/engine/src/cache.ts` — patch `pageData` alongside `data` in the Redis JSON loop and `refreshRegisteredLoaders`; `patchJsonField` writes both.
- Modify: `packages/engine/src/cache.ts` — `RedisCache.slotKey(route, variant)` either honors `variant` (match `jsonKey`) or drops the unused param (review #5).
- Test: `packages/engine/src/hub.test.ts` (shared-route stream still receives shared patches when an identity resolver is present), `packages/routekit/src/boot.test.ts` (JSON fast path returns post-patch `pageData`).

**Interfaces:**
- Consumes: `identity` (ADR-017), `BakeMode` map.
- Produces: `startKiln` builds `bakeByPattern: Map<string, BakeMode>`; the SSE/snapshot handlers read it. `patchJsonField`/watcher write `pageData[field]` when `pageData` exists on the snapshot.

- [ ] **Step 1: Write the failing tests.**
  (a) hub/boot: with an `identity` hook configured, a subscription to a **shared** (non-`'user'`) live route must still receive shared (`userKey ''`) patches — today `sseUserKey = identity(req)` drops them. Assert via a boot-level test that the resolved SSE `userKey` for a `bake` ≠ `'user'` route is `''`.
  (b) boot: a baked route with a live slot, JSON fast path (`Accept: application/json`) after a patch returns the **patched** value, not the bake-time `pageData`.
  Run → FAIL.

- [ ] **Step 2: Implement scoping gate.** In `startKiln`, while registering pages, populate `bakeByPattern.set(page.pattern, extractPageOptions(mod).bake)`. In the `/__kiln/fsr` and snapshot handlers:

```ts
      const routeBake = bakeByPattern.get(route);
      const sseUserKey = routeBake === 'user' && identity ? identity(req) ?? '' : '';
```

- [ ] **Step 3: Implement pageData freshness.** In `cache.patchJsonField`, after patching `target[field]`, also patch the sibling `pageData` when present:

```ts
    if (existing.pageData && typeof existing.pageData === 'object') {
      (existing.pageData as Record<string, unknown>)[field] = value;
    }
```

Mirror this in the watcher's Redis JSON batch loop and `refreshRegisteredLoaders` (where `data[row.slot] = value` is set, also set `snapshot.pageData[row.slot]` when it exists). Now the cached-JSON fast path (ADR-017) serves live-fresh page props.

- [ ] **Step 4: slotKey cleanup.** Make `RedisCache.slotKey(route, variant)` honor `variant` like `jsonKey`/`htmlKey` (per-user slot hashes are then correctly keyed even though no reader consumes them yet), OR drop the unused `variant` param and its call-site arg. Prefer honoring it (forward-consistent with the other keys). Update `patchSlot`'s call accordingly.

- [ ] **Step 5: Verify** — new tests PASS; `bun run test:integration` + `bun test packages/routekit packages/engine` green; tsc clean; rebuild dists.
- [ ] **Step 6: Commit** — `fix(routekit,engine): scope SSE by identity only for bake='user'; keep pageData live-fresh; key per-user slot hashes`

---

### Task 9: jags-list dogfood — createKilnSql, sync-triggers, freshness

Adopt the new machinery in the dogfood app and prove it end-to-end: swap the DB client to `createKilnSql`, delete the hand-written invalidation triggers in favor of `fsr.triggerTables` + `kiln sync-triggers`, and confirm auto-deps + owner-scoped invalidation + dormant rebuild behave.

**Files:**
- Modify: `apps/jags-list/db/client.ts` — `export const sql = createKilnSql(databaseUrl);`
- Modify: `apps/jags-list/kiln.config.ts` — add `fsr.triggerTables` (each table + `ownerColumn` where a per-user owner exists, e.g. `notifications.user_id`), `fsr.activeWindowSecs`.
- Modify: `apps/jags-list/migrations/0000_init.sql` — remove the 10 hand-written `*_kiln_invalidate` triggers (now managed by `kiln sync-triggers`); keep the `*_touch` triggers.
- Add: an `apps/jags-list` script/README note: run `kiln sync-triggers` after migrations.
- Modify: `apps/jags-list/tests/purity.integration.test.ts` (or a new `freshness.integration.test.ts`) — prove (1) a page whose `load()` reads `projects` auto-invalidates when a project row changes with NO manual dep key; (2) an owner-scoped change to one user's data leaves another user's cached artifact intact.
- Test additions run under the existing `test:purity` / app test scripts.

**Interfaces:**
- Consumes: everything above.
- Produces: dogfch proof that manual dep wiring is gone.

- [ ] **Step 1:** Write the failing freshness E2E (auto-dep invalidation + owner isolation), run → FAIL.
- [ ] **Step 2:** Swap client to `createKilnSql`; add `triggerTables`/`activeWindowSecs` config; delete hand-written invalidate triggers; run `kiln sync-triggers` against the test DB in the suite's `beforeAll` (after migrations).
- [ ] **Step 3:** Rebuild `@kiln/*` dists; run `bun run build` + unit + `RUN_APP_TESTS=1` app/crud/purity/freshness suites (separate `bun` invocations — shared sql client, Plan 1 lesson) → all green.
- [ ] **Step 4: Commit** — `feat(jags-list): createKilnSql + sync-triggers-managed triggers; auto-dep + owner-isolation E2E`

---

### Task 10: Docs, ADR-018, verification, PR

- [ ] `docs/agents/rendering-and-caching.md`: document auto-deps (tables read in `load()` become the slot's `depends_on` when using `createKilnSql`; explicit `Live.value(x, [...])` still unions), `kiln sync-triggers` (+ `--check` for CI), the `owner` column for per-user invalidation, and the active/dormant freshness model (SSE-subscribed or recently-read = eager; else lazy-on-read). Update the `.claude/skills/kiln/SKILL.md` numbered list + gotchas.
- [ ] `docs/agents/data-and-live.md` (or the relevant live-features doc): `createKilnSql` recipe; that manual dep keys remain supported and are the row-level (`table:column=value`) escape hatch; the `triggerTables` config shape.
- [ ] ADR-018 in `.memory/decisions.md` + `.codebase-memory/adr.md`: auto-derived dependencies via SQL observation (table-level; over-capture is safe, row-level stays manual); `sync-triggers` replacing hand-written trigger SQL; `owner` in the invalidation payload scoping per-user staleness; active/dormant freshness tiers as the scaling answer to ADR-017's per-user snapshot fan-out; Plan-2 review fixes folded in. Note deferred-to-future: shared-shell dedup, eager actor re-materialization, row-level auto-deps, auto-owner inference. **Extends** ADR-016/017.
- [ ] Straggler grep: any remaining hand-written `*_kiln_invalidate` triggers in app migrations/templates that should point at `sync-triggers`; confirm `packages/create-kiln/src/templates.ts` trigger example still matches the `kiln_emit_event` arg contract (now `(depKey [, ownerColumn])`).
- [ ] Full battery: `bunx tsc --noEmit` × all packages + test-app + address-book + jags-list; `bun run test:unit`; `bun run test:integration`; jags-list unit/app/crud/purity/freshness; test-app `prove-baking.ts`.
- [ ] Push branch, `gh pr create` (body: what/why; the auto-deps over-capture-is-safe rationale; the owner-scoping and freshness-tier design; the two Plan-2 regressions fixed; verification evidence), ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-Review (at authoring time)

- **Spec coverage (roadmap Plan 3 items):** auto-derived `depends_on` ✓ (T3 capture, T4 wiring) · `kiln sync-triggers` CLI ✓ (T2) · owner column in pg_notify payload ✓ (T1) · active/dormant freshness tiers ✓ (T5 store, T6 read/watcher, T7 activity signal). Plan-2 deferrals addressed or explicitly re-deferred: SSE-subscribed/recently-read eager vs dormant lazy ✓ (T5–T7); shared-shell dedup + eager actor re-materialization → explicitly out of scope (future Plan 4). Plan-2 review findings: #1 SSE scoping ✓ (T8), #2 stale pageData ✓ (T8), #3 PK migration ✓ (T5), #4 loader registry ✓ (T7), #5 slotKey ✓ (T8).
- **Type consistency:** `withDepCapture`/`collectDeps` (T3) consumed by T4; `invalidateDepKey(depKey, owner?)` (T1) consumed by T5 test + db-notify/watcher (T1); `TriggerTableConfig` (T2) consumed by T2 CLI + T9 config; `fetchStaleSlots({activeWindowSecs})` / `markActive` / `fetchDormantStaleSlot` (T5) consumed by T6/T7; `unregisterLoader` (T7) matches `loaderKey` from ADR-017; `bakeByPattern: Map<string, BakeMode>` (T8) uses `extractPageOptions(mod).bake`.
- **Sequencing compiles at every boundary:** T1 (owner) before T5 uses owner-scoped invalidation in its test; T3 (capture) before T4 (wiring); T5 (store tiers) before T6/T7 consume them; T8 gate needs only `extractPageOptions` (existing). All new store params trailing-defaulted so intermediate states keep old callers valid.
- **Deliberate scope cuts** (stated in Global Constraints / Out of scope): shared shells, eager actor re-materialization, row-level auto-deps via WHERE parsing, auto-owner inference → future.
- **Placeholder scan:** all code steps carry concrete SQL/TS; no "add error handling"/"similar to" placeholders. Two spots intentionally instruct the implementer to *verify-then-conditionally-edit* (`upsertSlot` resetting `stale`; keepalive re-ping ownership) — these are correctness checks against current source, not deferred work, and each names the exact condition and the edit to make if it fails.
