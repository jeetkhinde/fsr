# Live.list Auto-Deps Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a `Live.list` automatic dependencies derived from its own query, so omitting `dependsOn` no longer degrades it silently.

**Architecture:** Each list's query execution is wrapped in its own `withDepCapture` scope inside `materializeLiveLists`; the captured tables ride on the list value as `LiveListMeta.autoDeps`, and `registerLiveLists` unions them with the explicit `dependsOn`. A list that still ends up with no dependencies warns once, stating the real consequence.

**Tech Stack:** TypeScript, Bun (`bun:test`), PostgreSQL, Redis.

**Spec:** `docs/superpowers/specs/2026-07-31-live-list-auto-deps-design.md`

**Branch/worktree:** `fix/live-list-auto-deps` at `.worktrees/fix-live-list-auto-deps/`, branched from `main` @ `f5fa13a`.

## Global Constraints

- **All work happens inside the worktree.** `cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/fix-live-list-auto-deps` at the start of every task — the shell's working directory resets between turns, and running tests from the main workspace validates the wrong tree.
- **A fresh worktree needs setup before any test will run:** `bun install`, then `bun run build` (workspace packages resolve through `dist/`, which is gitignored), and `.env` files copied from the main workspace (`cp ../../test-app/.env test-app/.env` and `cp ../../apps/jags-list/.env apps/jags-list/.env`). Do this once, at the start of Task 1.
- **Never commit to `main`.** All commits land on `fix/live-list-auto-deps`.
- **`bun run build` is mandatory before any completion claim**, alongside `bun run test:unit`. Type-checking and unit tests have missed cross-package breakage in this repo before.
- **Rebuild `@kiln/core` after every change to it, before running `routekit` tests.** A test inside `packages/core` imports source (`./list.js`) and sees edits immediately, but `routekit` consumes `@kiln/core` through its built `dist/`. Editing `list.ts` and running a routekit test without rebuilding produces a failure that looks like broken logic but is only a stale artifact — this bit Task 2 during execution. `bun run --filter './packages/core' build` is enough.
- **Server-only code must never reach the `@kiln/core` barrel** (`packages/core/src/index.ts`). `withDepCapture`/`collectDeps` live in the server-only subpath `@kiln/core/sql` and must be imported from there, never from `@kiln/core`.
- **jags-list suites run one file at a time.** A single `bun test tests/` invocation fails with `PostgresError: Connection closed` because each suite spawns its own server; this is pre-existing on `main`.
- **Explicit deps are preserved, never replaced** — auto-deps only ever adds. `fsr.autoDeps: false` disables the union for lists exactly as it does for scalars.

---

### Task 1: `LiveListMeta.autoDeps` and a clone that can carry it

`cloneLiveListRows` currently reuses the source's meta object **by reference**. Attaching per-request capture results by mutating it would leak them onto a value other requests still hold, so the clone must build a new meta instead.

**Files:**
- Modify: `packages/core/src/list.ts` (the `LiveListMeta` interface and `cloneLiveListRows`)
- Create: `packages/core/src/list.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LiveListMeta<T>.autoDeps?: string[]`
  - `cloneLiveListRows<T>(source: LiveList<T>, rows: T[], extraMeta?: Partial<Pick<LiveListMeta<T>, 'autoDeps'>>): LiveList<T>` — the third parameter is new and optional; existing two-argument calls are unaffected.

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/fix-live-list-auto-deps
bun install
cp ../../test-app/.env test-app/.env
cp ../../apps/jags-list/.env apps/jags-list/.env
bun run build
```

Expected: install succeeds, build exits 0.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/list.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Live } from './live-prop.js';
import { cloneLiveListRows, getLiveListMeta } from './list.js';

function makeList() {
  return Live.list<{ id: number }>({
    key: (row) => row.id,
    dependsOn: 'activity',
    initial: [{ id: 1 }],
    query: () => [{ id: 1 }],
  });
}

describe('cloneLiveListRows', () => {
  it('preserves the source meta when no extra meta is given', () => {
    const source = makeList();
    const clone = cloneLiveListRows(source, [{ id: 2 }]);

    expect([...clone]).toEqual([{ id: 2 }]);
    expect(getLiveListMeta(clone)?.dependsOn).toEqual(['activity']);
    expect(getLiveListMeta(clone)?.autoDeps).toBeUndefined();
  });

  it('carries autoDeps onto the clone', () => {
    const source = makeList();
    const clone = cloneLiveListRows(source, [{ id: 1 }], { autoDeps: ['activity', 'user'] });

    expect(getLiveListMeta(clone)?.autoDeps).toEqual(['activity', 'user']);
    expect(getLiveListMeta(clone)?.dependsOn).toEqual(['activity']);
  });

  it('does not mutate the source meta — capture is per-request, the meta is shared', () => {
    const source = makeList();
    cloneLiveListRows(source, [{ id: 1 }], { autoDeps: ['activity'] });

    expect(getLiveListMeta(source)?.autoDeps).toBeUndefined();
  });

  it('keeps keyOf and query callable on the clone', () => {
    const source = makeList();
    const clone = cloneLiveListRows(source, [{ id: 7 }], { autoDeps: ['activity'] });
    const meta = getLiveListMeta(clone)!;

    expect(meta.keyOf({ id: 7 })).toBe('7');
    expect(meta.query({})).toEqual([{ id: 1 }]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
bun test packages/core/src/list.test.ts
```

Expected: the `autoDeps` tests FAIL — `cloneLiveListRows` takes only two parameters, so the third is ignored and `autoDeps` is `undefined`.

- [ ] **Step 4: Add the field**

In `packages/core/src/list.ts`, add to the `LiveListMeta` interface after `dependsOn: string[];`:

```ts
  /** Tables observed while this list's own query ran, captured per-list in
   * materializeLiveLists. Unioned into dependsOn at registration unless
   * fsr.autoDeps is false. Absent when no capture ran (no store, or a query
   * that used a non-capturing SQL client). */
  autoDeps?: string[];
```

- [ ] **Step 5: Give the clone a third parameter**

Replace `cloneLiveListRows` in `packages/core/src/list.ts`:

```ts
export function cloneLiveListRows<T>(
  source: LiveList<T>,
  rows: T[],
  extraMeta?: Partial<Pick<LiveListMeta<T>, 'autoDeps'>>,
): LiveList<T> {
  const meta = getLiveListMeta(source);
  if (!meta) {
    throw new Error('cloneLiveListRows requires a Live.list value');
  }

  // A NEW meta object, never a mutation of the source's: the source meta is
  // shared with the value the caller still holds, and per-request capture
  // results must not leak onto it.
  const nextMeta = extraMeta ? { ...meta, ...extraMeta } : meta;

  const clone = [...rows] as LiveList<T>;
  Object.defineProperty(clone, LIVE_LIST_META, {
    value: nextMeta,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(clone, '__kilnLiveListBrand', {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return clone;
}
```

- [ ] **Step 6: Run to verify it passes**

```bash
bun test packages/core/src/list.test.ts
```

Expected: PASS, all 4 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/list.ts packages/core/src/list.test.ts
git commit -m "feat(core): let cloneLiveListRows carry autoDeps on a fresh meta"
```

---

### Task 2: Capture each list's own query

**Files:**
- Modify: `packages/routekit/src/live-registration.ts` (imports and `materializeLiveLists`)
- Create: `packages/routekit/src/live-registration.test.ts`

**Interfaces:**
- Consumes: `cloneLiveListRows(source, rows, extraMeta?)` and `LiveListMeta.autoDeps` from Task 1.
- Produces: `materializeLiveLists` now attaches `autoDeps` to each materialized list. Its signature `(loadResult: any, store?: FsrStore) => Promise<any>` is **unchanged** — both call sites in `page-render.ts` keep working untouched.

The test simulates a capturing SQL client without a database: `collectDeps()` returns the active capture `Set`, so a query closure that calls `collectDeps()?.add('activity')` is indistinguishable from a real `createKilnSql` template as far as capture is concerned.

- [ ] **Step 1: Write the failing tests**

Create `packages/routekit/src/live-registration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Live, getLiveListMeta } from '@kiln/core';
import { collectDeps } from '@kiln/core/sql';
import { materializeLiveLists } from './live-registration.js';

/** Stand-in for FsrStore: runs the query the way the real one does
 * (`query({ sql, signal })`) without needing Postgres. */
function fakeStore() {
  return {
    executeLiveListQuery: async (query: any) => {
      const rows = await query({ sql: null });
      if (!Array.isArray(rows)) throw new Error('Live.list query must return an array');
      return rows;
    },
  } as any;
}

describe('materializeLiveLists auto-deps', () => {
  it('captures the tables a list query touches', async () => {
    const list = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('activity');
        return [{ id: 1 }];
      },
    });

    const out = await materializeLiveLists({ events: list }, fakeStore());

    expect(getLiveListMeta(out.events)?.autoDeps).toEqual(['activity']);
  });

  it('captures for a list that declares no initial rows', async () => {
    // The case page-level capture would miss: `initial` is optional, and the
    // page's own capture scope wraps only load(), not the list's query.
    const list = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('tasks');
        return [{ id: 9 }];
      },
    });

    const out = await materializeLiveLists({ items: list }, fakeStore());

    expect(getLiveListMeta(out.items)?.autoDeps).toEqual(['tasks']);
    expect([...out.items]).toEqual([{ id: 9 }]);
  });

  it('keeps two lists on one page from contaminating each other', async () => {
    const a = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('activity');
        return [{ id: 1 }];
      },
    });
    const b = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('tasks');
        return [{ id: 2 }];
      },
    });

    const out = await materializeLiveLists({ a, b }, fakeStore());

    expect(getLiveListMeta(out.a)?.autoDeps).toEqual(['activity']);
    expect(getLiveListMeta(out.b)?.autoDeps).toEqual(['tasks']);
  });

  it('preserves an explicit dependsOn alongside the captured tables', async () => {
    const list = Live.list<{ id: number }>({
      key: (row) => row.id,
      dependsOn: 'explicit_table',
      query: () => {
        collectDeps()?.add('activity');
        return [{ id: 1 }];
      },
    });

    const out = await materializeLiveLists({ events: list }, fakeStore());
    const meta = getLiveListMeta(out.events)!;

    expect(meta.dependsOn).toEqual(['explicit_table']);
    expect(meta.autoDeps).toEqual(['activity']);
  });

  it('leaves non-list values untouched', async () => {
    const out = await materializeLiveLists({ title: 'hello', n: 3 }, fakeStore());
    expect(out).toEqual({ title: 'hello', n: 3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/routekit/src/live-registration.test.ts
```

Expected: the four `autoDeps` assertions FAIL with `undefined` — nothing captures yet. The "leaves non-list values untouched" test passes already.

- [ ] **Step 3: Add the capture**

In `packages/routekit/src/live-registration.ts`, add the import (the server-only subpath — never the `@kiln/core` barrel):

```ts
import { withDepCapture } from '@kiln/core/sql';
```

Then replace the two lines inside `materializeLiveLists` that execute the query:

```ts
    const { result: rows, tables } = await withDepCapture(() =>
      store.executeLiveListQuery(meta.query),
    );
    next[name] = cloneLiveListRows(value as LiveList<unknown>, rows, {
      autoDeps: [...tables],
    });
```

Capture runs unconditionally, even when `fsr.autoDeps` is disabled — only the *union* is gated (Task 3). An `AsyncLocalStorage` run plus a `Set` is not worth threading config into this function to avoid, and it keeps the signature unchanged for both call sites.

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/routekit/src/live-registration.test.ts
```

Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/routekit/src/live-registration.ts packages/routekit/src/live-registration.test.ts
git commit -m "feat(routekit): capture each Live.list query's tables into autoDeps"
```

---

### Task 3: Union auto-deps into registration

`registerLiveLists` currently repeats `dependsOn: meta.dependsOn` at both of its object literals. Computing it once removes that duplication and gives the union a single home.

**Files:**
- Modify: `packages/routekit/src/live-registration.ts` (`registerLiveLists` input type and body; new exported helper)
- Modify: `packages/routekit/src/page-render.ts` (both `registerLiveLists({...})` call sites)
- Modify: `packages/routekit/src/live-registration.test.ts` (append)

**Interfaces:**
- Consumes: `LiveListMeta.autoDeps` (Task 1), populated by `materializeLiveLists` (Task 2).
- Produces:
  - `resolveListDeps(meta: LiveListMeta<any>, autoDepsEnabled: boolean): string[]` — exported from `live-registration.ts`.
  - `registerLiveLists` input gains `autoDeps?: boolean` (omitted or `true` means enabled).

- [ ] **Step 1: Write the failing tests**

Append to `packages/routekit/src/live-registration.test.ts`:

```ts
import { resolveListDeps } from './live-registration.js';

describe('resolveListDeps', () => {
  it('unions explicit deps with captured ones', () => {
    const meta = { dependsOn: ['explicit_table'], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, true).sort()).toEqual(['activity', 'explicit_table']);
  });

  it('drops captured deps when auto-deps is disabled, keeping explicit ones', () => {
    const meta = { dependsOn: ['explicit_table'], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, false)).toEqual(['explicit_table']);
  });

  it('deduplicates when a table is both declared and captured', () => {
    const meta = { dependsOn: ['activity'], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, true)).toEqual(['activity']);
  });

  it('returns captured deps when nothing was declared', () => {
    const meta = { dependsOn: [], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, true)).toEqual(['activity']);
  });

  it('returns an empty list when there is nothing at all', () => {
    const meta = { dependsOn: [] } as any;
    expect(resolveListDeps(meta, true)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/routekit/src/live-registration.test.ts
```

Expected: FAIL — `resolveListDeps` is not exported.

- [ ] **Step 3: Add the helper**

In `packages/routekit/src/live-registration.ts`, add above `registerLiveLists`:

```ts
/** Explicit deps plus the tables captured from the list's own query. Explicit
 * deps are preserved and never replaced — auto-deps only ever adds, matching
 * the scalar path's rule (page-render.ts, step 12). */
export function resolveListDeps(meta: LiveListMeta<any>, autoDepsEnabled: boolean): string[] {
  return Array.from(
    new Set([...meta.dependsOn, ...(autoDepsEnabled ? meta.autoDeps ?? [] : [])]),
  );
}
```

Add `LiveListMeta` to the existing type import from `@kiln/core`:

```ts
import {
  cloneLiveListRows,
  getLiveListMeta,
  isLiveList,
  type LiveList,
  type LiveListMeta,
} from '@kiln/core';
```

- [ ] **Step 4: Use it in `registerLiveLists`**

Add `autoDeps?: boolean;` to the `input` type of `registerLiveLists`, after `defaultRevalidate?: number | false;`:

```ts
  /** Mirrors kilnConfig.fsr.autoDeps. Omitted or true = union captured deps. */
  autoDeps?: boolean;
```

Inside the loop, immediately after the `const rows = value as unknown[];` line, add:

```ts
    const dependsOn = resolveListDeps(meta, input.autoDeps !== false);
```

Then replace **both** occurrences of `dependsOn: meta.dependsOn,` in the `watcher.registerLiveList(...)` call with:

```ts
        dependsOn,
```

- [ ] **Step 5: Pass the config through at both call sites**

In `packages/routekit/src/page-render.ts`, add one line to each of the two `registerLiveLists({ ... })` calls — the page call and the layout call — alongside the existing `defaultDebounce`/`defaultRevalidate` entries:

```ts
        autoDeps: kilnConfig?.fsr?.autoDeps !== false,
```

- [ ] **Step 6: Run to verify it passes**

```bash
bun test packages/routekit/src/live-registration.test.ts
```

Expected: PASS, all 10 tests.

- [ ] **Step 7: Full suite and build**

```bash
bun run test:unit && bun run build
```

Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add packages/routekit/src/live-registration.ts packages/routekit/src/live-registration.test.ts packages/routekit/src/page-render.ts
git commit -m "feat(routekit): union Live.list auto-deps into registration"
```

---

### Task 4: Warn when a list ends up with no dependencies

Auto-deps can still come up empty — a query built with plain `new SQL(url)` is invisible to capture by design, and a dynamically-interpolated table name is invisible to `extractTables`. Silence is what made this a bug rather than a gap, so the empty case must say so.

**Files:**
- Modify: `packages/routekit/src/live-registration.ts` (`registerLiveLists`)
- Modify: `packages/routekit/src/live-registration.test.ts` (append)

**Interfaces:**
- Consumes: `resolveListDeps` and the `dependsOn` local from Task 3.
- Produces: a `warnOnce` keyed `live-list-no-deps:${route}:${name}`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/routekit/src/live-registration.test.ts`:

```ts
import { registerLiveLists } from './live-registration.js';

/** Minimal watcher that records what it was asked to register. */
function fakeWatcher() {
  const calls: any[] = [];
  return {
    calls,
    registerLiveList: async (target: any, snapshot: any) => {
      calls.push({ target, snapshot });
    },
  } as any;
}

/** HTML in the shape extractLiveListRowHtml expects: a container carrying
 * data-kiln-list, with rows carrying data-kiln-key. */
const LIST_HTML = '<ul data-kiln-list="events"><li data-kiln-key="1">one</li></ul>';

function listWith(opts: { dependsOn?: string; autoDeps?: string[]; revalidate?: number | false }) {
  const list = Live.list<{ id: number }>({
    key: (row) => row.id,
    ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
    ...(opts.revalidate !== undefined ? { revalidate: opts.revalidate } : {}),
    initial: [{ id: 1 }],
    query: () => [{ id: 1 }],
  });
  if (opts.autoDeps) (getLiveListMeta(list) as any).autoDeps = opts.autoDeps;
  return list;
}

async function register(route: string, list: any, extra: Record<string, unknown> = {}) {
  const watcher = fakeWatcher();
  await registerLiveLists({
    route,
    pageComponent: () => null,
    pageProps: { events: list },
    finalHtml: LIST_HTML,
    htmlPath: null,
    jsonPath: null,
    watcher,
    ...extra,
  } as any);
  return watcher;
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  return { warnings, restore: () => { console.warn = original; } };
}

describe('registerLiveLists empty-dependency warning', () => {
  it('registers the unioned deps on the watcher target', async () => {
    const watcher = await register('/r1', listWith({ dependsOn: 'explicit', autoDeps: ['activity'] }));

    expect(watcher.calls).toHaveLength(1);
    expect([...watcher.calls[0].target.dependsOn].sort()).toEqual(['activity', 'explicit']);
    expect([...watcher.calls[0].snapshot.dependsOn].sort()).toEqual(['activity', 'explicit']);
  });

  it('warns when a list has neither declared nor captured deps', async () => {
    const w = captureWarnings();
    try {
      await register('/r2', listWith({}));
    } finally {
      w.restore();
    }

    expect(w.warnings.some((m) => m.includes('has no dependencies'))).toBe(true);
    expect(w.warnings.some((m) => m.includes('revalidate timer'))).toBe(true);
  });

  it('says the list will never update when revalidate is false', async () => {
    const w = captureWarnings();
    try {
      await register('/r3', listWith({ revalidate: false }));
    } finally {
      w.restore();
    }

    expect(w.warnings.some((m) => m.includes('will never update'))).toBe(true);
  });

  it('does not warn when deps were captured', async () => {
    const w = captureWarnings();
    try {
      await register('/r4', listWith({ autoDeps: ['activity'] }));
    } finally {
      w.restore();
    }

    expect(w.warnings.some((m) => m.includes('has no dependencies'))).toBe(false);
  });

  it('warns only once for the same route and list', async () => {
    const w = captureWarnings();
    try {
      await register('/r5', listWith({}));
      await register('/r5', listWith({}));
    } finally {
      w.restore();
    }

    expect(w.warnings.filter((m) => m.includes('has no dependencies'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/routekit/src/live-registration.test.ts
```

Expected: the three warning-content tests FAIL — nothing warns yet. The "registers the unioned deps" and "does not warn" tests pass already.

- [ ] **Step 3: Add the warning**

In `packages/routekit/src/live-registration.ts`, add the import:

```ts
import { warnOnce } from './dedup.js';
```

Then, immediately after the `const dependsOn = resolveListDeps(...)` line added in Task 3:

```ts
    if (dependsOn.length === 0) {
      // Branch on the EFFECTIVE revalidate — the same expression used when
      // building the target below — because a list with no deps is not
      // necessarily dead: fetchStaleLists also refreshes on
      // COALESCE(revalidate_secs, 300) > 0. Only revalidate:false (stored as
      // 0) removes that fallback.
      const effectiveRevalidate = meta.revalidate ?? input.defaultRevalidate;
      warnOnce(
        `live-list-no-deps:${input.route}:${name}`,
        `[kiln] Live.list "${name}" on route "${input.route}" has no dependencies: none were ` +
          `declared via dependsOn, and none were captured from its query. ` +
          (effectiveRevalidate === false
            ? `With revalidate: false it will never update.`
            : `It will refresh only on the revalidate timer (~300s by default), not when the ` +
              `underlying data changes.`) +
          ` Auto-deps only sees queries made through a createKilnSql client, and cannot see a ` +
          `dynamically-interpolated table name — give the list an explicit dependsOn if either applies.`,
      );
    }
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/routekit/src/live-registration.test.ts
```

Expected: PASS, all 15 tests.

- [ ] **Step 5: Full suite and build**

```bash
bun run test:unit && bun run build
```

Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add packages/routekit/src/live-registration.ts packages/routekit/src/live-registration.test.ts
git commit -m "feat(routekit): warn when a Live.list registers with no dependencies"
```

---

### Task 5: The falsification — delete jags-list's explicit `dependsOn`

`.memory` records that deleting `dependsOn: 'activity'` from this page makes `bun run test:live` fail on a 20s timeout. This task performs exactly that deletion and requires the suite to **pass**, which is what proves auto-deps carried the dependency.

**Files:**
- Modify: `apps/jags-list/pages/projects/[id]/activity.tsx` (the `Live.list` declaration and its comment)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no exports. The app now relies on auto-deps for its live feed.

`activityRows` queries through `sql` from `db/client.js`, which is `createKilnSql`, with `FROM activity a` and `LEFT JOIN "user" u` — so capture should yield `activity` (and `user`, a harmless over-capture in the safe direction).

- [ ] **Step 1: Confirm the suite passes before the change**

```bash
cd apps/jags-list && bun run test:live
```

Expected: PASS. This is the baseline — if it fails here, stop and report, because the falsification is meaningless without a green starting point. Needs live PostgreSQL and Redis.

- [ ] **Step 2: Delete the explicit dependency**

In `apps/jags-list/pages/projects/[id]/activity.tsx`, replace the comment and the `dependsOn` line in the `Live.list` declaration:

```tsx
    // No dependsOn: the framework captures the tables this list's own query
    // touches (`activity`, plus `user` via the join) and registers them as
    // dependencies automatically, exactly as it does for scalar Live.value.
    // This page is the falsification for that behaviour — if auto-deps
    // regresses, tests/live.integration.test.ts times out.
    events: Live.list<ActivityRow>({
      key: (row) => row.id,
      initial: await activityRows(projectId),
      query: () => activityRows(projectId),
    }),
```

- [ ] **Step 3: Run the falsifying suite**

```bash
cd apps/jags-list && bun run test:live
```

Expected: PASS. A 20s timeout here means auto-deps did not reach the watcher — do not re-add `dependsOn` to make it green; that would restore the workaround and hide the failure. Report instead.

- [ ] **Step 4: Prove the test still has teeth**

A passing suite only shows the fix works; it does not show the suite would notice if it stopped working. Confirm the negative, so "this test falsifies the feature" is observed rather than inherited from a memory note:

`git stash` does **not** work here — the fix is already committed by Tasks 2–4, so there is nothing to stash. Revert against `main` instead, and revert `page-render.ts` too, or the build fails on the `autoDeps` argument the reverted signature no longer accepts. jags-list runs against routekit's built `dist/`, so the rebuild is not optional:

```bash
cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/fix-live-list-auto-deps
git checkout main -- packages/routekit/src/live-registration.ts packages/routekit/src/page-render.ts
bun run --filter './packages/routekit' build
grep -c withDepCapture packages/routekit/dist/live-registration.js   # must print 0
cd apps/jags-list && bun run test:live
```

Expected: **FAIL** on a ~20s timeout. The `grep` matters — `tsc -b` reports errors from the test file (which still references `resolveListDeps`) while still emitting, so confirm from `dist` that the capture is genuinely absent rather than trusting the build's exit code. Then restore:

```bash
cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/fix-live-list-auto-deps
git checkout HEAD -- packages/routekit/src/live-registration.ts packages/routekit/src/page-render.ts
bun run build
```

If it *passes* with the fix stashed, the suite is not actually exercising the dependency path and the whole falsification is worthless — stop and report that, rather than proceeding on a test that cannot fail.

- [ ] **Step 5: Verify the captured deps are what you think**

Whether `extractTables` yields `activity` from `FROM activity a` and how it handles the quoted `"user"` is an assumption worth confirming rather than inferring from a passing test. Add a temporary log after the `const dependsOn = resolveListDeps(...)` line in `packages/routekit/src/live-registration.ts`:

```ts
    console.log('[deps]', input.route, name, dependsOn);
```

Re-run `bun run test:live`, read the logged array for `/projects/:id/activity`, confirm it contains `activity`, then **remove the log line** before committing.

- [ ] **Step 6: Run the other jags-list suites**

One file at a time — a single `bun test tests/` invocation collides on Postgres connections:

```bash
cd apps/jags-list && for f in tests/*.test.ts; do RUN_APP_TESTS=1 bun --env-file=.env test "$f"; done
```

Expected: all seven PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/jags-list/pages/projects/\[id\]/activity.tsx
git commit -m "refactor(jags-list): drop the explicit Live.list dependsOn

The workaround for the auto-deps gap. Deleting it used to make test:live
time out at 20s; it now passes on captured deps alone."
```

---

### Task 6: Documentation, ADR, and memory

**Files:**
- Modify: `.codebase-memory/adr.md` (ADR-018)
- Modify: `.memory/bugs-active.md` (§1)
- Modify: `.memory/bugs-resolved.md`
- Modify: `.memory/active-work.md` (§ Next Priorities)
- Modify: `docs/agents/` — whichever files state that `Live.list` needs an explicit `dependsOn`

- [ ] **Step 1: Find the stale documentation**

```bash
grep -rn "dependsOn" docs/agents/ | grep -i "list\|mandatory\|required"
```

Update every hit that says a `Live.list` requires an explicit `dependsOn`, and the gotchas table row for it if one exists. Replace with: auto-deps applies to lists as it does to scalars, an explicit `dependsOn` is still needed when the query uses a non-`createKilnSql` client or a dynamically-interpolated table name, and a list with no deps at all now warns.

- [ ] **Step 2: Amend ADR-018**

ADR-018 describes auto-deps as `load()`-scoped capture only. Append a paragraph recording that a `Live.list` additionally captures its **own** query execution, per-list, in `materializeLiveLists`; that the result rides on `LiveListMeta.autoDeps` and is unioned at registration by `resolveListDeps`; and that per-list capture was chosen over reusing the page's observed tables because `initial` is optional and the page scope wraps only `load()`.

- [ ] **Step 3: Move the bug to resolved**

Remove the `Live.list receives no auto-deps` entry from `.memory/bugs-active.md` §1 and add it to `.memory/bugs-resolved.md` with the date, branch, and the falsification result.

**Include the correction:** the active entry claims a dep-less list "never updates". That is true only with `revalidate: false` — otherwise `fetchStaleLists` still refreshes it on the `COALESCE(revalidate_secs, 300) > 0` timer. Record the accurate version so the next reader is not misled about severity.

- [ ] **Step 4: Update the priorities**

In `.memory/active-work.md`, mark the auto-deps item of the `Live.list` cluster done and name the next one — the remaining constraints are `<li>`-only markup, patches dropped inside islands, and no `target` option.

Also record the defect found but not fixed here: **layout `load()` is never wrapped in `withDepCapture`** (`packages/routekit/src/page-render.ts`, the layout branch calls `lMod.load(tracker.proxied)` directly), so layout *scalar* live fields get no auto-deps at all. Layout *lists* are fine, because list capture is self-contained.

- [ ] **Step 5: Final verification**

```bash
bun run test:unit && bun run test:integration && bun run build
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A .codebase-memory docs .memory
git commit -m "docs: record Live.list auto-deps parity (ADR-018 amendment)"
```

---

## Finishing

Use `superpowers:finishing-a-development-branch` → "Push and create PR". Do not push to `main`.

Lead the PR description with the falsification: the explicit `dependsOn` is gone from jags-list and `test:live` passes on captured deps alone.

Note for the PR: PR #31 (`feat/action-response-api`) may be open against `main` at the same time. Both touch `packages/routekit/src/page-render.ts`, but in different regions — #31 changed header writes, this changes the two `registerLiveLists` call sites — so a conflict is unlikely and would be trivial.
