# Live List Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Live.list` so Kiln can revalidate keyed collections, structurally patch baked HTML/JSON, and keep JSX usage natural without exposing append/prepend/replace modes.

**Architecture:** `Live.list` is a keyed collection target, not a scalar field. On dependency changes, Kiln reruns the list query, reconciles old row keys against new row keys, removes missing rows, inserts new rows, and patches existing row content through generated internal row-field markers. Public JSX remains normal `items.map(...)`; Kiln preserves list identity through branded array metadata and generated HTML boundaries.

**Tech Stack:** TypeScript, React SSR via `react-dom/server`, Bun SQL, Elysia SSE integration through existing Kiln routekit/engine primitives, Bun test.

---

## Backend Completion Status

- [x] Persist ordered list snapshots and stale state in `kiln_fsr_lists`.
- [x] Share the existing Bun SQL client through `FsrStore.lists` and query callbacks.
- [x] Register executable query, key, and row-render callbacks in the embedded watcher.
- [x] Materialize `Live.list` queries before SSR without requiring `initial`.
- [x] Reconcile and patch list HTML, JSON, Redis artifacts, and SSE payloads.
- [x] Leave failed or unregistered targets stale without partial SSE emission.
- [x] Restore callbacks on the first route request after process restart.
- [x] Subscribe initially empty lists and reload once on the first insert.
- [x] Reject `Live.list` in external watcher mode with an actionable error.
- [x] Add test-app and create-kiln examples using `todo_events` as the external dependency.
- [x] Complete the final repository-wide verification commands.

---

## Pending Corrections Before Implementation

- [x] Revise scalar `LiveProp` DX to copy Pilcrow's principle: declare query-backed live data separately from static `load` data, pass populated live data into `load`, know live field names before render, generate internal DOM markers during SSR, and keep scalar patch payloads small.
- [x] Revise preferred `Live.list` DX to infer the list name from the `load` return key instead of requiring `name`.
- [x] Keep `Live.list.key` required for runtime row identity; React's JSX `key` remains React-only and is not available to Kiln's watcher or baked artifacts.
- [x] Treat `dependsOn` as an external invalidation trigger for the list query. Do not use self-dependency examples such as `todos.updated_at`.
- [x] Remove manual row markers from the target public DX. Page code should render `<TodoRow key={todo.id} todo={todo} />` with no `s-live`, `s-key`, or framework props.
- [x] Prefer row-field patch payloads over whole-row HTML replacement when existing row keys remain and only row fields changed.
- [x] Use whole-row HTML replacement only as a fallback when field-to-DOM mapping is unavailable or a row's rendered shape changed in a way scalar field patching cannot represent.

## Locked TODO: Extract Pure Live Contract Package

Create a separate package for the pure live-data contract before wiring routekit, engine, watcher, SSE, or browser DOM code. This package exists to make scalar live patching and list live patching testable without Postgres, Redis, Elysia, React SSR, or a browser.

Package name and boundaries:

- [x] Create `packages/live/package.json` with package name `@kiln/live`, `type: "module"`, `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`, `exports["."]`, `build: "tsc -b"`, and `clean: "rm -rf dist"`, matching the existing package shape in `packages/core` and `packages/engine`.
- [x] Create `packages/live/tsconfig.json` using the same TypeScript project-reference style as existing packages. Do not add runtime dependencies unless a test proves the standard library is insufficient.
- [x] Create `packages/live/src/index.ts` that re-exports only stable public contract modules: `scalar`, `list`, `patch`, `html`, `json`, and `fixtures`.
- [x] Keep `packages/live` pure. It must not import from `@kiln/engine`, `@kiln/routekit`, `@kiln/client`, `@kiln/react`, Elysia, React, Redis, Postgres, Bun SQL, filesystem APIs, or browser globals.
- [x] After adding the package, add `@kiln/live: "workspace:*"` to the packages that consume the pure contract. Start with `@kiln/core` for public `Live` declarations and `@kiln/engine` for patch application. Add routekit/client dependencies only when implementation reaches marker generation or browser patching.

Scalar live patching responsibilities:

- [x] Create `packages/live/src/scalar.ts`.
- [x] Define `ScalarLiveTarget` as a route-scoped field, not a DOM marker:

```ts
export type LiveDependency = string;

export interface ScalarLiveTarget<T = unknown> {
  kind: "scalar";
  route: string;
  field: string;
  dependsOn: LiveDependency[];
  queryId: string;
  value: T;
}
```

- [x] Define `ScalarPatch` as the small payload used by server file patching and browser SSE:

```ts
export interface ScalarPatch<T = unknown> {
  kind: "scalar";
  route: string;
  field: string;
  value: T;
}
```

- [x] Add `createScalarPatch(route, field, value)` and `isScalarPatch(value)` helpers.
- [x] Scalar patches must update exactly one route field. They must not contain HTML, SQL, row keys, or list names.
- [x] Tests in `packages/live/src/scalar.test.ts` must prove scalar payloads are small and stable:
  - `createScalarPatch("/tasks", "status", "complete")` returns `{ kind: "scalar", route: "/tasks", field: "status", value: "complete" }`.
  - object values remain JSON values, not stringified HTML.
  - invalid patch objects are rejected by `isScalarPatch`.

Scalar JSON patching responsibilities:

- [x] Create `packages/live/src/json.ts`.
- [x] Implement `applyScalarPatchToJson(seed, patch)` as a pure function.
- [x] For scalar patches, update only the top-level field named by `patch.field`.
- [x] Preserve all other JSON properties by structural copy.
- [x] Do not mutate the input object.
- [x] Tests must prove:

```ts
const seed = { title: "Task", status: "in_progress", count: 1 };
const patch = createScalarPatch("/tasks", "status", "complete");
expect(applyScalarPatchToJson(seed, patch)).toEqual({
  title: "Task",
  status: "complete",
  count: 1,
});
expect(seed.status).toBe("in_progress");
```

Scalar HTML patching responsibilities:

- [x] Create `packages/live/src/html.ts`.
- [x] Implement `applyScalarPatchToHtml(html, patch)` as a pure string function for baked HTML files.
- [x] Support current legacy marker format first: `<span s-live="status">old</span>`.
- [x] Support generated marker format second: `<span data-kiln-live-field="status">old</span>`.
- [x] Patch element text content only. Preserve the element tag name and attributes.
- [x] HTML-escape patched scalar values.
- [x] Do not patch attributes in this first pass; attribute patching needs a separate explicit contract.
- [x] Tests must prove both marker styles patch to `complete`, unrelated slots remain unchanged, and `<script>`-like values are escaped as text.

Live list contract responsibilities:

- [x] Create `packages/live/src/list.ts`.
- [x] Define `LiveListOptions<T>` with no public `name` and no public `mode`:

```ts
export type LiveListKey = string | number;

export interface LiveListQueryContext {
  sql?: unknown;
  signal?: AbortSignal;
}

export interface LiveListOptions<T> {
  key(row: T): LiveListKey;
  dependsOn?: string | string[];
  initial?: T[];
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
}
```

- [x] Define `LiveListTarget<T>` with an internal `name` because runtime storage, SSE, and artifacts still need a stable list id:

```ts
export interface LiveListTarget<T = unknown> {
  kind: "list";
  route: string;
  name: string;
  dependsOn: string[];
  keyOf(row: T): string;
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
}
```

- [x] The public API must infer `name` from the `load` return key. Example: `{ todos: Live.list(...) }` creates internal list name `"todos"`.
- [x] `Live.list.key` remains required because React's JSX `key` is React-only and is not available to watchers, baked files, JSON artifacts, or SSE payloads.
- [x] `dependsOn` is an external invalidation trigger. Do not use examples where a list depends on its own table field such as `todo_events`.

List reconciliation responsibilities:

- [x] Create `packages/live/src/patch.ts`.
- [x] Define list patch operations as data-only payloads:

```ts
export type ListPatch<T = unknown> =
  | { kind: "list"; op: "insert"; route: string; list: string; key: string; index: number; row: T }
  | { kind: "list"; op: "remove"; route: string; list: string; key: string }
  | { kind: "list"; op: "move"; route: string; list: string; key: string; from: number; to: number }
  | { kind: "list"; op: "fields"; route: string; list: string; key: string; changes: Record<string, unknown> }
  | { kind: "list"; op: "replace-row"; route: string; list: string; key: string; row: T };
```

- [x] Implement `reconcileListRows({ route, list, keyOf, previous, next })`.
- [x] Reconciliation rules:
  - Missing old key in `next` emits `remove`.
  - New key in `next` emits `insert` with the new index and row object.
  - Existing key at a different index emits `move`.
  - Existing key with changed shallow fields emits `fields` with only changed fields.
  - Existing key with no shallow changes emits no patch.
  - Duplicate keys in `previous` or `next` throw a descriptive error.
- [x] Field diffing is shallow in the pure package. Nested-object field changes replace that field value. Deep structural diffing is out of scope for the first implementation.
- [x] Tests in `packages/live/src/patch.test.ts` must cover add, remove, move, field change, no-op, duplicate previous key, duplicate next key, and mixed operations in a deterministic order.
- [x] Deterministic operation order must be: removals, insertions, moves, field patches. This keeps file patching and browser patching predictable.

List JSON patching responsibilities:

- [x] Extend `packages/live/src/json.ts` with `applyListPatchToJson(seed, patch)`.
- [x] Baked JSON shape for lists is the normal `load` output shape:

```json
{
  "todos": [
    { "id": 1, "title": "Ship", "status": "in_progress" }
  ]
}
```

- [x] For `fields`, find the row in `seed[patch.list]` whose runtime key matches `patch.key` and update only the changed fields.
- [x] For `insert`, insert `patch.row` at `patch.index`.
- [x] For `remove`, remove the matching row.
- [x] For `move`, reorder the existing row without changing its field values.
- [x] For `replace-row`, replace only the matching row object.
- [x] Do not mutate the input JSON object or input row objects.
- [x] Tests must prove a status-only field patch changes only `todos[0].status`, not the whole array identity by mutation.

List HTML patching responsibilities:

- [x] Extend `packages/live/src/html.ts` with `applyListPatchToHtml(html, patch)`.
- [x] Use generated internal markers, not public developer-authored props:

```html
<ul data-kiln-list="todos">
  <li data-kiln-key="42">
    <span data-kiln-field="title">Ship</span>
    <span data-kiln-field="status">in_progress</span>
  </li>
</ul>
```

- [x] For `fields`, patch only matching row fields:
  - find container `[data-kiln-list="todos"]`
  - find row `[data-kiln-key="42"]` inside that container
  - patch `[data-kiln-field="status"]` text content to the new value
- [x] For `remove`, remove the row element.
- [x] For `move`, move the existing row element within the list container.
- [x] For `insert` and `replace-row`, the pure package must not invent HTML from row data. Those operations require rendered row HTML from routekit/engine. Represent this explicitly with a separate `RenderedListPatch` type only when the renderer supplies HTML.
- [x] Tests must prove that a `fields` patch changes only the status span and preserves title, checkbox markup, row attributes, and surrounding list HTML.

Fixtures and cross-layer tests:

- [x] Create `packages/live/src/fixtures.ts` with reusable todo fixtures:

```ts
export interface TodoFixture {
  id: number;
  title: string;
  completed: boolean;
  status: string;
}

export const todosBefore: TodoFixture[] = [
  { id: 1, title: "Ship", completed: false, status: "in_progress" },
  { id: 2, title: "Review", completed: false, status: "queued" },
];

export const todosAfterStatusChange: TodoFixture[] = [
  { id: 1, title: "Ship", completed: false, status: "complete" },
  { id: 2, title: "Review", completed: false, status: "queued" },
];
```

- [x] Create `packages/live/src/contract.test.ts`.
- [x] Contract test must prove the same `fields` patch can update:
  - scalar/list patch payload object
  - baked JSON
  - baked HTML
- [x] The status-change contract test must assert the patch payload does not contain `<li`, `</li>`, full page HTML, SQL text, or unrelated fields like `title`.

Integration rules for existing packages:

- [x] Move or wrap current scalar `injectFsrSlots` behavior from `packages/engine/src/baking.ts` through `@kiln/live` once scalar HTML tests pass.
- [x] Keep `packages/engine/src/watcher.ts` responsible for DB re-execution, stale-slot fetching, Redis/file writes, and SSE emission. It should consume patch objects from `@kiln/live`, not define patch semantics itself.
- [x] Keep `packages/routekit` responsible for SSR marker generation and inferring list names from `load` return keys. It should not own list reconciliation.
- [x] Keep `packages/client` responsible for browser DOM mutation. Its behavior must match the patch payload types exported by `@kiln/live`.
- [x] Do not implement browser DOM patching until the pure package proves the JSON and HTML contracts.

Implemented integration notes:

- `packages/routekit/src/page-options.ts` now extracts live lists separately from scalar fields and infers list names from `load` result keys.
- `packages/routekit/src/live-list-render.ts` adds generated `data-kiln-list`, `data-kiln-live`, `data-kiln-key`, `data-kiln-field`, and `data-kiln-live-field` markers after SSR for the current plain JSX DX.
- `packages/engine/src/hub.ts` streams scalar `@kiln/live` patches as `live` events and list patches as `list-patch` events.
- `packages/engine/src/list-broadcast.ts` emits shared `ListPatch` field patches instead of the old local patch shape.
- `packages/client/src/silcrow.js` and `packages/routekit/src/live-client-script.ts` apply scalar patches plus list `fields`, `remove`, `move`, `insert`, and `replace-row` patches. `insert` and `replace-row` require renderer-supplied `html`; the runtime does not synthesize row HTML from JSON.

Verification commands for the package split:

```bash
bun test packages/live/src/scalar.test.ts
bun test packages/live/src/patch.test.ts
bun test packages/live/src/json.test.ts
bun test packages/live/src/html.test.ts
bun test packages/live/src/contract.test.ts
bun run --filter '@kiln/live' build
```

Expected result: all tests pass, `@kiln/live` builds, and no package outside `packages/live` is required to run the pure contract tests.

---

## Locked DX

The public API must stay close to this:

```tsx
export const load = async () => ({
  todos: Live.list({
    key: (todo) => todo.id,
    dependsOn: "todo_events",
    query: ({ sql }) => sql`
      select id, title, completed, updated_at
      from todos
      order by id asc
    `,
  }),
});

export default function Page({ todos }) {
  return (
    <ul>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  );
}
```

No public `mode` option. `dependsOn` means revalidate this target, just like scalar `LiveProp`. The runtime derives insert, remove, move, and patch outcomes by comparing previous and current keyed query results.

---

## File Map

- Modify: `packages/core/src/list.ts`
  - Define `LiveList`, `LiveListOptions`, row key types, list metadata symbols, and JSON-serializable snapshot types.
- Modify: `packages/core/src/live-prop.ts`
  - Export a `Live` namespace/object with `value` and `list` helpers while keeping existing `LiveProp` compatibility.
- Modify: `packages/core/src/index.ts`
  - Re-export new list types and helpers.
- Create: `packages/core/src/live-list.test.ts`
  - Unit tests for branded list behavior, key extraction, metadata preservation through `map`, and JSON shape.
- Modify: `packages/routekit/src/page-options.ts`
  - Detect scalar `LiveProp` and list `LiveList` targets separately.
- Create: `packages/routekit/src/live-list-render.ts`
  - Render-time helpers for generated list boundaries and scoped row `s-live` values.
- Create: `packages/routekit/src/live-list-render.test.ts`
  - Tests for boundary and scoped `s-live` marker generation.
- Modify: `packages/engine/src/schema.ts`
  - Add list metadata/artifact columns or companion table SQL.
- Modify: `test-app/migrations/0000_init.sql`
  - Keep scaffold/test app schema aligned with engine schema SQL.
- Create: `packages/engine/src/list-store.ts`
  - Store list snapshots, row keys, row JSON, cursors, dependencies, and artifact paths.
- Create: `packages/engine/src/list-store.test.ts`
  - Bun SQL integration tests for list snapshot persistence and key reconciliation.
- Create: `packages/engine/src/list-reconcile.ts`
  - Pure reconciliation function from old keyed rows and new keyed rows to remove/insert/move/patch operations.
- Create: `packages/engine/src/list-reconcile.test.ts`
  - Unit tests for add, remove, update, reorder, and no-op cases.
- Modify: `packages/engine/src/baking.ts`
  - Add structural list patch helpers for HTML boundaries and JSON arrays.
- Create: `packages/engine/src/list-baking.test.ts`
  - Tests for inserting/removing/reordering keyed row HTML and JSON.
- Modify: `packages/engine/src/watcher.ts`
  - Revalidate list targets on dependency changes, emit list patch events, update baked artifacts.
- Modify: `packages/engine/src/hub.ts`
  - Stream `list:patch` events to clients alongside scalar FSR events.
- Modify: `packages/routekit/src/live-client-script.ts`
  - Apply list insert/remove/move/patch events in the browser.
- Modify: `packages/routekit/src/live-client.test.ts`
  - Test browser script contains list patch handlers.
- Modify: `packages/create-kiln/src/templates.ts`
  - Add a small Todo/logs example using `Live.list`.
- Create: `test-app/pages/todos.tsx`
  - Add a minimal list usage example as the integration fixture.

---

## Task 1: Core `Live.list` API And Metadata

**Files:**
- Modify: `packages/core/src/list.ts`
- Modify: `packages/core/src/live-prop.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/live-list.test.ts`

- [x] **Step 1: Write failing tests for branded list metadata**

Add `packages/core/src/live-list.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Live, getLiveListMeta, isLiveList } from "./index.js";

describe("Live.list", () => {
  it("returns an array-like value with hidden list metadata", () => {
    const todos = Live.list({
      key: (todo: { id: number }) => todo.id,
      dependsOn: "todo_events",
      initial: [
        { id: 1, title: "Ship list support" },
        { id: 2, title: "Patch baked files" },
      ],
      query: async () => [],
    });

    expect(Array.isArray(todos)).toBe(true);
    expect(isLiveList(todos)).toBe(true);
    expect(todos).toHaveLength(2);

    const meta = getLiveListMeta(todos);
    expect(meta?.name).toBe("todos");
    expect(meta?.dependsOn).toEqual(["todo_events"]);
    expect(meta?.keyOf(todos[0])).toBe("1");
    expect(meta?.keyOf(todos[1])).toBe("2");
  });

  it("preserves row keys through normal map usage", () => {
    const todos = Live.list({
      key: (todo: { id: number }) => todo.id,
      dependsOn: "todo_events",
      initial: [{ id: 7, title: "Natural JSX" }],
      query: async () => [],
    });

    const rendered = todos.map((todo) => ({
      key: todo.id,
      title: todo.title,
    }));

    const meta = getLiveListMeta(todos);
    expect(rendered).toEqual([{ key: 7, title: "Natural JSX" }]);
    expect(meta?.keyOf(todos[0])).toBe("7");
  });
});
```

- [x] **Step 2: Run the failing core test**

Run:

```bash
bun test packages/core/src/live-list.test.ts
```

Expected: FAIL because `Live`, `getLiveListMeta`, and `isLiveList` do not exist.

- [x] **Step 3: Implement the core types and helper**

Replace `packages/core/src/list.ts` with:

```ts
export interface KilnListRow {
  __key: string;
  __liveFields: string[];
  [field: string]: any;
}

export interface ListPatchEvent {
  list: string;
  key: string;
  changes: Record<string, any>;
}

export interface ListChunkCache {
  get(list: string, key: string): string | null;
  set(list: string, key: string, html: string): void;
  delete(list: string, key: string): void;
  deleteList(list: string): void;
}

export type LiveListKey = string | number;

export interface LiveListQueryContext {
  sql?: unknown;
  after?: string | number | null;
  signal?: AbortSignal;
}

export interface LiveListOptions<T> {
  name: string;
  key: (row: T) => LiveListKey;
  dependsOn?: string | string[];
  initial?: T[];
  query: (ctx: LiveListQueryContext) => Promise<T[]> | T[];
}

export interface LiveListMeta<T = unknown> {
  kind: "list";
  name: string;
  dependsOn: string[];
  keyOf(row: T): string;
  query(ctx: LiveListQueryContext): Promise<T[]> | T[];
}

export type LiveList<T> = T[] & {
  readonly __kilnLiveListBrand?: true;
};

export const LIVE_LIST_META = Symbol.for("kiln.live-list.meta");

export function createLiveList<T>(options: LiveListOptions<T>): LiveList<T> {
  const rows = [...(options.initial ?? [])] as LiveList<T>;
  const dependsOn = Array.isArray(options.dependsOn)
    ? options.dependsOn
    : options.dependsOn
      ? [options.dependsOn]
      : [];

  const meta: LiveListMeta<T> = {
    kind: "list",
    name: options.name,
    dependsOn,
    keyOf: (row: T) => String(options.key(row)),
    query: options.query,
  };

  Object.defineProperty(rows, LIVE_LIST_META, {
    value: meta,
    enumerable: false,
    configurable: false,
  });

  return rows;
}

export function isLiveList(value: unknown): value is LiveList<unknown> {
  return Array.isArray(value) && !!(value as any)[LIVE_LIST_META];
}

export function getLiveListMeta<T = unknown>(value: unknown): LiveListMeta<T> | null {
  return isLiveList(value) ? ((value as any)[LIVE_LIST_META] as LiveListMeta<T>) : null;
}
```

Modify `packages/core/src/live-prop.ts`:

```ts
import { createLiveList, type LiveList, type LiveListOptions } from "./list.js";

export interface DependencyKey {
  table: string;
  column: string;
  value: string;
}

export function depToString(key: DependencyKey): string {
  return `${key.table}:${key.column}=${key.value}`;
}

export type LiveTarget = "dom" | "dom-and-store" | "store";

export class LiveProp<T> {
  public value: T;
  public dependsOn: string[];
  public patchDebounce?: number;
  public deliveryTarget: LiveTarget = "dom";

  constructor(
    value: T,
    dependsOn: (string | DependencyKey)[] = [],
    options?: { patchDebounce?: number; target?: LiveTarget }
  ) {
    this.value = value;
    this.dependsOn = dependsOn.map((dep) =>
      typeof dep === "string" ? dep : depToString(dep)
    );
    this.patchDebounce = options?.patchDebounce;
    if (options?.target) {
      this.deliveryTarget = options.target;
    }
  }

  static initial<T>(value: T): LiveProp<T> {
    return new LiveProp(value, []);
  }

  public debounce(seconds: number): this {
    this.patchDebounce = seconds;
    return this;
  }

  public target(target: LiveTarget): this {
    this.deliveryTarget = target;
    return this;
  }
}

export const Live = {
  value<T>(
    value: T,
    dependsOn: (string | DependencyKey)[] = [],
    options?: { patchDebounce?: number; target?: LiveTarget }
  ): LiveProp<T> {
    return new LiveProp(value, dependsOn, options);
  },

  initial<T>(value: T): LiveProp<T> {
    return LiveProp.initial(value);
  },

  list<T>(options: LiveListOptions<T>): LiveList<T> {
    return createLiveList(options);
  },
};
```

Modify `packages/core/src/index.ts` to export the new helpers:

```ts
export * from "./types.js";
export * from "./config.js";
export * from "./live-prop.js";
export * from "./list.js";
```

- [x] **Step 4: Run core tests**

Run:

```bash
bun test packages/core/src/live-list.test.ts packages/core/src/list.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/list.ts packages/core/src/live-prop.ts packages/core/src/index.ts packages/core/src/live-list.test.ts
git commit -m "feat(core): add Live.list metadata"
```

---

## Task 2: Extract List Metadata From Route Loads

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/routekit/src/page-options.ts`
- Create: `packages/routekit/src/page-options-live-list.test.ts`

- [x] **Step 1: Write failing metadata extraction test**

Add `packages/routekit/src/page-options-live-list.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Live } from "@kiln/core";
import { extractLiveFields, extractLiveLists } from "./page-options.js";

describe("extractLiveLists", () => {
  it("extracts list metadata without treating lists as scalar fields", () => {
    const loadResult = {
      count: Live.value(1, ["todo_events"]),
      todos: Live.list({
        key: (todo: { id: number }) => todo.id,
        dependsOn: "todo_events",
        initial: [{ id: 1, title: "A" }],
        query: async () => [],
      }),
    };

    expect(extractLiveFields(loadResult).map((field) => field.name)).toEqual(["count"]);

    const lists = extractLiveLists(loadResult);
    expect(lists).toHaveLength(1);
    expect(lists[0].propName).toBe("todos");
    expect(lists[0].name).toBe("todos");
    expect(lists[0].dependsOn).toEqual(["todo_events"]);
    expect(lists[0].rows).toEqual([{ id: 1, title: "A" }]);
    expect(lists[0].keys).toEqual(["1"]);
  });
});
```

- [x] **Step 2: Run the failing routekit test**

Run:

```bash
bun test packages/routekit/src/page-options-live-list.test.ts
```

Expected: FAIL because `extractLiveLists` does not exist.

- [x] **Step 3: Add list metadata types**

Modify `packages/core/src/types.ts` by adding:

```ts
export interface LiveListMetaResult {
  propName: string;
  name: string;
  dependsOn: string[];
  keys: string[];
  rows: unknown[];
}
```

- [x] **Step 4: Implement `extractLiveLists`**

Modify `packages/routekit/src/page-options.ts`:

```ts
import { LiveProp, getLiveListMeta, isLiveList } from "@kiln/core";
import type { LiveFieldMeta, LiveListMetaResult } from "@kiln/core";

export interface PageOptions {
  promoteAfter?: number;
}

export function extractPageOptions(module: any): PageOptions {
  return {
    promoteAfter: typeof module.promoteAfter === "number" ? module.promoteAfter : undefined,
  };
}

export function extractLiveFields(loadResult: any): LiveFieldMeta[] {
  const fields: LiveFieldMeta[] = [];
  if (!loadResult || typeof loadResult !== "object") {
    return fields;
  }

  for (const [key, value] of Object.entries(loadResult)) {
    if (isLiveList(value)) {
      continue;
    }

    if (value && (value instanceof LiveProp || (value as any).constructor?.name === "LiveProp")) {
      const lp = value as any;

      let dependsOn: string | undefined;
      if (Array.isArray(lp.dependsOn) && lp.dependsOn.length > 0) {
        dependsOn = lp.dependsOn[0];
      } else if (typeof lp.dependsOn === "string") {
        dependsOn = lp.dependsOn;
      } else if (lp.options?.dependsOn) {
        dependsOn = lp.options.dependsOn;
      }

      const revalidate = lp.options?.revalidate;
      const debounce = lp.patchDebounce !== undefined ? lp.patchDebounce : lp.options?.debounce;
      const deliveryTarget = lp.deliveryTarget || lp.options?.target || "dom";

      fields.push({
        name: key,
        revalidate,
        debounce,
        dependsOn,
        deliveryTarget,
      });
    }
  }

  return fields;
}

export function extractLiveLists(loadResult: any): LiveListMetaResult[] {
  const lists: LiveListMetaResult[] = [];
  if (!loadResult || typeof loadResult !== "object") {
    return lists;
  }

  for (const [propName, value] of Object.entries(loadResult)) {
    const meta = getLiveListMeta(value);
    if (!meta) continue;

    const rows = Array.isArray(value) ? [...value] : [];
    lists.push({
      propName,
      name: meta.name,
      dependsOn: meta.dependsOn,
      rows,
      keys: rows.map((row) => meta.keyOf(row)),
    });
  }

  return lists;
}
```

- [x] **Step 5: Run routekit metadata tests**

Run:

```bash
bun test packages/routekit/src/page-options-live-list.test.ts packages/routekit/src/boot.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/routekit/src/page-options.ts packages/routekit/src/page-options-live-list.test.ts
git commit -m "feat(routekit): extract Live.list metadata"
```

---

## Task 3: Pure Key Reconciliation

**Files:**
- Create: `packages/engine/src/list-reconcile.ts`
- Create: `packages/engine/src/list-reconcile.test.ts`
- Modify: `packages/engine/src/index.ts`

- [x] **Step 1: Write failing reconciliation tests**

Add `packages/engine/src/list-reconcile.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { reconcileListRows } from "./list-reconcile.js";

describe("reconcileListRows", () => {
  it("derives inserts, removes, keeps, and moves by key", () => {
    const oldRows = [
      { key: "1", hash: "a" },
      { key: "2", hash: "b" },
      { key: "3", hash: "c" },
    ];
    const newRows = [
      { key: "2", hash: "b" },
      { key: "4", hash: "d" },
      { key: "3", hash: "c2" },
    ];

    const result = reconcileListRows(oldRows, newRows);

    expect(result.removes).toEqual([{ key: "1", from: 0 }]);
    expect(result.inserts).toEqual([{ key: "4", to: 1 }]);
    expect(result.moves).toEqual([{ key: "2", from: 1, to: 0 }]);
    expect(result.patches).toEqual([{ key: "3", at: 2 }]);
    expect(result.nextKeys).toEqual(["2", "4", "3"]);
  });

  it("returns no operations for identical key and hash order", () => {
    const rows = [
      { key: "1", hash: "a" },
      { key: "2", hash: "b" },
    ];

    const result = reconcileListRows(rows, rows);

    expect(result.removes).toEqual([]);
    expect(result.inserts).toEqual([]);
    expect(result.moves).toEqual([]);
    expect(result.patches).toEqual([]);
    expect(result.nextKeys).toEqual(["1", "2"]);
  });
});
```

- [x] **Step 2: Run the failing reconciliation tests**

Run:

```bash
bun test packages/engine/src/list-reconcile.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement pure reconciliation**

Create `packages/engine/src/list-reconcile.ts`:

```ts
export interface ListRowFingerprint {
  key: string;
  hash: string;
}

export interface ListRemoveOp {
  key: string;
  from: number;
}

export interface ListInsertOp {
  key: string;
  to: number;
}

export interface ListMoveOp {
  key: string;
  from: number;
  to: number;
}

export interface ListPatchOp {
  key: string;
  at: number;
}

export interface ListReconcileResult {
  removes: ListRemoveOp[];
  inserts: ListInsertOp[];
  moves: ListMoveOp[];
  patches: ListPatchOp[];
  nextKeys: string[];
}

export function reconcileListRows(
  oldRows: ListRowFingerprint[],
  newRows: ListRowFingerprint[]
): ListReconcileResult {
  const oldByKey = new Map(oldRows.map((row, index) => [row.key, { row, index }]));
  const newByKey = new Map(newRows.map((row, index) => [row.key, { row, index }]));

  const removes: ListRemoveOp[] = [];
  const inserts: ListInsertOp[] = [];
  const moves: ListMoveOp[] = [];
  const patches: ListPatchOp[] = [];

  for (let index = 0; index < oldRows.length; index += 1) {
    const row = oldRows[index];
    if (!newByKey.has(row.key)) {
      removes.push({ key: row.key, from: index });
    }
  }

  for (let index = 0; index < newRows.length; index += 1) {
    const row = newRows[index];
    const old = oldByKey.get(row.key);
    if (!old) {
      inserts.push({ key: row.key, to: index });
      continue;
    }
    if (old.index !== index) {
      moves.push({ key: row.key, from: old.index, to: index });
    }
    if (old.row.hash !== row.hash) {
      patches.push({ key: row.key, at: index });
    }
  }

  return {
    removes,
    inserts,
    moves,
    patches,
    nextKeys: newRows.map((row) => row.key),
  };
}
```

Modify `packages/engine/src/index.ts`:

```ts
export * from "./baking.js";
export * from "./cache.js";
export * from "./db-notify.js";
export * from "./hub.js";
export * from "./list-broadcast.js";
export * from "./list-chunk-cache.js";
export * from "./list-reconcile.js";
export * from "./schema.js";
export * from "./store.js";
export * from "./watcher.js";
```

- [x] **Step 4: Run reconciliation tests**

Run:

```bash
bun test packages/engine/src/list-reconcile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/list-reconcile.ts packages/engine/src/list-reconcile.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): reconcile live lists by key"
```

---

## Task 4: Structural HTML And JSON List Patching

**Files:**
- Modify: `packages/engine/src/baking.ts`
- Create: `packages/engine/src/list-baking.test.ts`

- [x] **Step 1: Write failing structural patch tests**

Add `packages/engine/src/list-baking.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { applyLiveListHtmlPatch, applyLiveListJsonPatch } from "./baking.js";

describe("live list artifact patching", () => {
  it("removes missing rows and inserts new keyed rows before the list end marker", () => {
    const html = [
      '<ul data-kiln-list="todos">',
      '<li data-kiln-key="1" s-live="todos:1">one</li>',
      '<li data-kiln-key="2" s-live="todos:2">two</li>',
      "<!--kiln-list-end:todos-->",
      "</ul>",
    ].join("");

    const patched = applyLiveListHtmlPatch(html, {
      list: "todos",
      removes: ["1"],
      rows: [{ key: "3", html: '<li data-kiln-key="3" s-live="todos:3">three</li>' }],
      order: ["2", "3"],
    });

    expect(patched).not.toContain('data-kiln-key="1"');
    expect(patched).toContain('<li data-kiln-key="2" s-live="todos:2">two</li>');
    expect(patched).toContain('<li data-kiln-key="3" s-live="todos:3">three</li>');
    expect(patched.indexOf('data-kiln-key="2"')).toBeLessThan(patched.indexOf('data-kiln-key="3"'));
  });

  it("updates JSON arrays by list name and key", () => {
    const json = JSON.stringify({
      todos: [
        { id: 1, title: "one" },
        { id: 2, title: "two" },
      ],
    });

    const patched = applyLiveListJsonPatch(json, {
      list: "todos",
      removes: ["1"],
      rows: [{ key: "3", data: { id: 3, title: "three" } }],
      order: ["2", "3"],
      keyField: "id",
    });

    expect(JSON.parse(patched)).toEqual({
      todos: [
        { id: 2, title: "two" },
        { id: 3, title: "three" },
      ],
    });
  });
});
```

- [x] **Step 2: Run failing structural patch tests**

Run:

```bash
bun test packages/engine/src/list-baking.test.ts
```

Expected: FAIL because the functions do not exist.

- [x] **Step 3: Implement structural patch helpers**

Append to `packages/engine/src/baking.ts`:

```ts
export interface LiveListHtmlPatchRow {
  key: string;
  html: string;
}

export interface LiveListHtmlPatch {
  list: string;
  removes: string[];
  rows: LiveListHtmlPatchRow[];
  order: string[];
}

export interface LiveListJsonPatchRow {
  key: string;
  data: Record<string, unknown>;
}

export interface LiveListJsonPatch {
  list: string;
  removes: string[];
  rows: LiveListJsonPatchRow[];
  order: string[];
  keyField: string;
}

export function applyLiveListHtmlPatch(html: string, patch: LiveListHtmlPatch): string {
  const startToken = `data-kiln-list="${patch.list}"`;
  const endToken = `<!--kiln-list-end:${patch.list}-->`;
  const listStart = html.indexOf(startToken);
  const end = html.indexOf(endToken);
  if (listStart === -1 || end === -1 || end < listStart) return html;

  const before = html.slice(0, listStart);
  const listAndRows = html.slice(listStart, end);
  const after = html.slice(end);

  const existingRows = new Map<string, string>();
  const rowRegex = /<([a-zA-Z0-9:-]+)\b[^>]*data-kiln-key="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(listAndRows)) !== null) {
    existingRows.set(match[2], match[0]);
  }

  for (const key of patch.removes) {
    existingRows.delete(key);
  }
  for (const row of patch.rows) {
    existingRows.set(row.key, row.html);
  }

  const openTagEnd = listAndRows.indexOf(">");
  if (openTagEnd === -1) return html;

  const openTag = listAndRows.slice(0, openTagEnd + 1);
  const orderedRows = patch.order
    .map((key) => existingRows.get(key))
    .filter((row): row is string => !!row)
    .join("");

  return before + openTag + orderedRows + after;
}

export function applyLiveListJsonPatch(json: string, patch: LiveListJsonPatch): string {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const existing = Array.isArray(parsed[patch.list])
    ? (parsed[patch.list] as Record<string, unknown>[])
    : [];

  const rowsByKey = new Map<string, Record<string, unknown>>();
  for (const row of existing) {
    rowsByKey.set(String(row[patch.keyField]), row);
  }
  for (const key of patch.removes) {
    rowsByKey.delete(key);
  }
  for (const row of patch.rows) {
    rowsByKey.set(row.key, row.data);
  }

  parsed[patch.list] = patch.order
    .map((key) => rowsByKey.get(key))
    .filter((row): row is Record<string, unknown> => !!row);

  return JSON.stringify(parsed);
}
```

- [x] **Step 4: Run structural patch tests**

Run:

```bash
bun test packages/engine/src/list-baking.test.ts packages/engine/src/baking.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/baking.ts packages/engine/src/list-baking.test.ts
git commit -m "feat(engine): patch keyed live list artifacts"
```

---

## Task 5: Persist List Snapshots And Dependencies

**Files:**
- Modify: `packages/engine/src/schema.ts`
- Modify: `test-app/migrations/0000_init.sql`
- Create: `packages/engine/src/list-store.ts`
- Create: `packages/engine/src/list-store.test.ts`
- Modify: `packages/engine/src/index.ts`

- [x] **Step 1: Write failing list store integration test**

Add `packages/engine/src/list-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { SQL } from "bun";
import { KILN_FSR_SCHEMA_SQL } from "./schema.js";
import { FsrListStore } from "./list-store.js";

async function runTests() {
  const sql = new SQL(process.env.DATABASE_URL || "postgresql://localhost:5432/kilnjs_test");
  const store = new FsrListStore(sql);

  try {
    await sql.unsafe(KILN_FSR_SCHEMA_SQL);
    await sql.unsafe("DELETE FROM kiln_fsr_lists");

    await store.upsertList({
      route: "/todos",
      propName: "todos",
      dependsOn: ["todo_events"],
      keyField: "id",
      rows: [
        { key: "1", data: { id: 1, title: "one" }, html: '<li data-kiln-key="1">one</li>' },
        { key: "2", data: { id: 2, title: "two" }, html: '<li data-kiln-key="2">two</li>' },
      ],
    });

    const snapshot = await store.getList("/todos", "todos");
    assert.ok(snapshot);
    assert.deepEqual(snapshot.keys, ["1", "2"]);
    assert.deepEqual(snapshot.dependsOn, ["todo_events"]);

    const affected = await store.findListsByDependency("todo_events");
    assert.deepEqual(affected.map((row) => `${row.route}:${row.name}`), ["/todos:todos"]);

    console.log("🎉 FsrListStore integration tests PASSED!");
  } finally {
    await sql.unsafe("DELETE FROM kiln_fsr_lists");
    sql.close();
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ FsrListStore tests failed:", err);
    process.exit(1);
  });
```

- [x] **Step 2: Run failing list store test**

Run:

```bash
bun --env-file=test-app/.env packages/engine/src/list-store.test.ts
```

Expected: FAIL because `kiln_fsr_lists` and `FsrListStore` do not exist.

- [x] **Step 3: Extend schema SQL**

Modify `packages/engine/src/schema.ts` so `KILN_FSR_SCHEMA_SQL` includes:

```sql
CREATE TABLE IF NOT EXISTS kiln_fsr_lists (
  route TEXT NOT NULL,
  name TEXT NOT NULL,
  prop_name TEXT NOT NULL,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  key_field TEXT NOT NULL,
  keys TEXT[] NOT NULL DEFAULT '{}',
  rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_html JSONB NOT NULL DEFAULT '{}'::jsonb,
  html_path TEXT,
  json_path TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (route, name)
);

CREATE INDEX IF NOT EXISTS idx_kiln_fsr_lists_depends_on ON kiln_fsr_lists USING GIN (depends_on);
```

Apply the same table and index to `test-app/migrations/0000_init.sql`.

- [x] **Step 4: Implement `FsrListStore`**

Create `packages/engine/src/list-store.ts`:

```ts
type BunSqlClient = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  unsafe(query: string, params?: unknown[]): Promise<any[]>;
};

export interface StoredListRow {
  key: string;
  data: Record<string, unknown>;
  html: string;
}

export interface UpsertListInput {
  route: string;
  name: string;
  propName: string;
  dependsOn: string[];
  keyField: string;
  rows: StoredListRow[];
  htmlPath?: string | null;
  jsonPath?: string | null;
}

export interface StoredListSnapshot {
  route: string;
  name: string;
  propName: string;
  dependsOn: string[];
  keyField: string;
  keys: string[];
  rows: StoredListRow[];
  htmlPath: string | null;
  jsonPath: string | null;
}

export class FsrListStore {
  constructor(private sql: BunSqlClient) {}

  async upsertList(input: UpsertListInput): Promise<void> {
    const keys = input.rows.map((row) => row.key);
    const rows = input.rows.map((row) => ({ key: row.key, data: row.data }));
    const rowHtml = Object.fromEntries(input.rows.map((row) => [row.key, row.html]));

    await this.sql`
      INSERT INTO kiln_fsr_lists
        (route, name, prop_name, depends_on, key_field, keys, rows, row_html, html_path, json_path, updated_at)
      VALUES (
        ${input.route},
        ${input.name},
        ${input.propName},
        ARRAY(SELECT jsonb_array_elements_text(${input.dependsOn}::jsonb))::text[],
        ${input.keyField},
        ARRAY(SELECT jsonb_array_elements_text(${keys}::jsonb))::text[],
        ${rows}::jsonb,
        ${rowHtml}::jsonb,
        ${input.htmlPath ?? null},
        ${input.jsonPath ?? null},
        now()
      )
      ON CONFLICT (route, name) DO UPDATE SET
        prop_name = EXCLUDED.prop_name,
        depends_on = EXCLUDED.depends_on,
        key_field = EXCLUDED.key_field,
        keys = EXCLUDED.keys,
        rows = EXCLUDED.rows,
        row_html = EXCLUDED.row_html,
        html_path = EXCLUDED.html_path,
        json_path = EXCLUDED.json_path,
        updated_at = now()
    `;
  }

  async getList(route: string, name: string): Promise<StoredListSnapshot | null> {
    const rows = await this.sql`
      SELECT route, name, prop_name as "propName", depends_on as "dependsOn",
             key_field as "keyField", keys, rows, row_html as "rowHtml",
             html_path as "htmlPath", json_path as "jsonPath"
      FROM kiln_fsr_lists
      WHERE route = ${route} AND name = ${name}
    `;
    const row = rows[0] as any;
    if (!row) return null;

    const rowHtml = row.rowHtml || {};
    return {
      route: row.route,
      name: row.name,
      propName: row.propName,
      dependsOn: row.dependsOn || [],
      keyField: row.keyField,
      keys: row.keys || [],
      rows: (row.rows || []).map((entry: any) => ({
        key: entry.key,
        data: entry.data,
        html: rowHtml[entry.key] || "",
      })),
      htmlPath: row.htmlPath,
      jsonPath: row.jsonPath,
    };
  }

  async findListsByDependency(depKey: string): Promise<Array<{ route: string; name: string }>> {
    const rows = await this.sql`
      SELECT route, name
      FROM kiln_fsr_lists
      WHERE ${depKey} = ANY(depends_on)
      ORDER BY route, name
    `;
    return rows.map((row: any) => ({ route: row.route, name: row.name }));
  }
}
```

Modify `packages/engine/src/index.ts`:

```ts
export * from "./list-store.js";
```

- [x] **Step 5: Run list store integration test**

Run:

```bash
bun --env-file=test-app/.env packages/engine/src/list-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/schema.ts test-app/migrations/0000_init.sql packages/engine/src/list-store.ts packages/engine/src/list-store.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): persist live list snapshots"
```

---

## Task 6: Render List Boundaries While Preserving Natural JSX

**Files:**
- Create: `packages/routekit/src/live-list-render.ts`
- Create: `packages/routekit/src/live-list-render.test.ts`

- [x] **Step 1: Write failing boundary render test**

Add `packages/routekit/src/live-list-render.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { wrapLiveListHtml } from "./live-list-render.js";

describe("wrapLiveListHtml", () => {
  it("adds list boundary and scopes row s-live values", () => {
    const html = [
      "<ul>",
      '<li data-kiln-key="1" s-live="1">one</li>',
      '<li data-kiln-key="2" s-live="2">two</li>',
      "</ul>",
    ].join("");

    const wrapped = wrapLiveListHtml(html, {
      list: "todos",
      keys: ["1", "2"],
    });

    expect(wrapped).toContain('<ul data-kiln-list="todos">');
    expect(wrapped).toContain('s-live="todos:1"');
    expect(wrapped).toContain('s-live="todos:2"');
    expect(wrapped).toContain("<!--kiln-list-end:todos-->");
  });
});
```

- [x] **Step 2: Run failing render test**

Run:

```bash
bun test packages/routekit/src/live-list-render.test.ts
```

Expected: FAIL because `wrapLiveListHtml` does not exist.

- [x] **Step 3: Implement first-pass boundary helper**

Create `packages/routekit/src/live-list-render.ts`:

```ts
export interface WrapLiveListHtmlOptions {
  list: string;
  keys: string[];
}

export function wrapLiveListHtml(html: string, options: WrapLiveListHtmlOptions): string {
  const openUl = html.indexOf("<ul");
  if (openUl === -1) return html;

  let result = html;
  result = result.replace("<ul", `<ul data-kiln-list="${options.list}"`);

  for (const key of options.keys) {
    result = result.replaceAll(`s-live="${key}"`, `s-live="${options.list}:${key}"`);
  }

  result = result.replace("</ul>", `<!--kiln-list-end:${options.list}--></ul>`);
  return result;
}
```

- [x] **Step 4: Run render tests**

Run:

```bash
bun test packages/routekit/src/live-list-render.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routekit/src/live-list-render.ts packages/routekit/src/live-list-render.test.ts
git commit -m "feat(routekit): render live list boundaries"
```

---

## Task 7: Emit List Patch Events From The Watcher

**Files:**
- Modify: `packages/engine/src/watcher.ts`
- Modify: `packages/engine/src/hub.ts`
- Create: `packages/engine/src/list-watcher.test.ts`

- [x] **Step 1: Write failing watcher-level test**

Add `packages/engine/src/list-watcher.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { SQL } from "bun";
import { FsrListStore } from "./list-store.js";
import { KILN_FSR_SCHEMA_SQL } from "./schema.js";

async function runTests() {
  const sql = new SQL(process.env.DATABASE_URL || "postgresql://localhost:5432/kilnjs_test");
  const listStore = new FsrListStore(sql);
  const htmlPath = "./temp_live_list.html";
  const jsonPath = "./temp_live_list.json";

  try {
    await sql.unsafe(KILN_FSR_SCHEMA_SQL);
    await sql.unsafe("DELETE FROM kiln_fsr_lists");

    await fs.writeFile(
      htmlPath,
      '<ul data-kiln-list="todos"><li data-kiln-key="1" s-live="todos:1">one</li><!--kiln-list-end:todos--></ul>',
      "utf8"
    );
    await fs.writeFile(jsonPath, JSON.stringify({ todos: [{ id: 1, title: "one" }] }), "utf8");

    await listStore.upsertList({
      route: "/todos",
      propName: "todos",
      dependsOn: ["todo_events"],
      keyField: "id",
      htmlPath,
      jsonPath,
      rows: [
        { key: "1", data: { id: 1, title: "one" }, html: '<li data-kiln-key="1" s-live="todos:1">one</li>' },
      ],
    });

    const snapshot = await listStore.getList("/todos", "todos");
    assert.ok(snapshot);
    assert.deepEqual(snapshot.keys, ["1"]);

    console.log("🎉 live list watcher fixture PASSED!");
  } finally {
    await sql.unsafe("DELETE FROM kiln_fsr_lists");
    sql.close();
    await fs.unlink(htmlPath).catch(() => {});
    await fs.unlink(jsonPath).catch(() => {});
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ live list watcher fixture failed:", err);
    process.exit(1);
  });
```

- [x] **Step 2: Run the watcher fixture**

Run:

```bash
bun --env-file=test-app/.env packages/engine/src/list-watcher.test.ts
```

Expected: PASS after Task 5. This fixture establishes cleanup and file paths before list patch event emission is connected.

- [x] **Step 3: Extend watcher types**

Modify `packages/engine/src/watcher.ts` to add:

```ts
export interface ListPatchRow {
  key: string;
  html: string;
  data: Record<string, unknown>;
}

export interface ListPatch {
  route: string;
  list: string;
  removes: string[];
  rows: ListPatchRow[];
  order: string[];
}
```

- [x] **Step 4: Emit list patches from watcher after artifact patching**

In `packages/engine/src/watcher.ts`, add a private method for list patch event delivery:

```ts
private emitListPatch(patch: ListPatch): void {
  this.emitter.emit("list:patch", patch);
}
```

Add this call shape in the code path that handles a reconciled list patch:

```ts
this.emitListPatch({
  route,
  list: listName,
  removes: reconcile.removes.map((op) => op.key),
  rows: insertedOrPatchedRows,
  order: reconcile.nextKeys,
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/watcher.ts packages/engine/src/list-watcher.test.ts
git commit -m "feat(engine): prepare watcher list patch events"
```

---

## Task 8: SSE And Browser Client List Patch Application

**Files:**
- Modify: `packages/engine/src/hub.ts`
- Modify: `packages/routekit/src/live-client-script.ts`
- Modify: `packages/routekit/src/live-client.test.ts`

- [x] **Step 1: Write failing client script tests**

Modify `packages/routekit/src/live-client.test.ts` with checks:

```ts
run("script handles list patch events", () => {
  assert.ok(script.includes("list:patch"));
  assert.ok(script.includes("data-kiln-list"));
  assert.ok(script.includes("data-kiln-key"));
});
```

- [x] **Step 2: Run failing client script test**

Run:

```bash
bun test packages/routekit/src/live-client.test.ts
```

Expected: FAIL until the client script includes list patch handling.

- [x] **Step 3: Add SSE list event emission**

Modify `packages/engine/src/hub.ts` in `fsrHubStream` so it listens for `list:patch` on the watcher emitter and yields:

```ts
{
  event: "list:patch",
  data: JSON.stringify(patch),
}
```

Keep existing scalar `fsr` events unchanged.

- [x] **Step 4: Add client-side list patch handling**

Modify `packages/routekit/src/live-client-script.ts` to include:

```js
function _patchList(patch){
  var root = document.querySelector('[data-kiln-list="'+patch.list+'"]');
  if(!root) return;

  (patch.removes || []).forEach(function(key){
    var node = root.querySelector('[data-kiln-key="'+key+'"]');
    if(node) node.remove();
  });

  (patch.rows || []).forEach(function(row){
    var existing = root.querySelector('[data-kiln-key="'+row.key+'"]');
    var tpl = document.createElement('template');
    tpl.innerHTML = row.html;
    var next = tpl.content.firstElementChild;
    if(!next) return;
    if(existing) existing.replaceWith(next);
    else root.insertBefore(next, _listEnd(root));
  });

  (patch.order || []).forEach(function(key){
    var node = root.querySelector('[data-kiln-key="'+key+'"]');
    if(node) root.insertBefore(node, _listEnd(root));
  });
}

function _listEnd(root){
  for(var i=0;i<root.childNodes.length;i++){
    var node = root.childNodes[i];
    if(node.nodeType === 8 && node.nodeValue === 'kiln-list-end:'+root.getAttribute('data-kiln-list')){
      return node;
    }
  }
  return null;
}
```

Add:

```js
es.addEventListener('list:patch', function(e){
  try{_patchList(JSON.parse(e.data));}catch(_){}
});
```

- [x] **Step 5: Run SSE/client tests**

Run:

```bash
bun test packages/routekit/src/live-client.test.ts packages/engine/src/hub.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/hub.ts packages/routekit/src/live-client-script.ts packages/routekit/src/live-client.test.ts
git commit -m "feat(routekit): apply live list patches in client"
```

---

## Task 9: Scaffold And Example DX

**Files:**
- Modify: `packages/create-kiln/src/templates.ts`
- Create: `packages/create-kiln/src/templates.test.ts`
- Create: `test-app/pages/todos.tsx`

- [x] **Step 1: Add scaffold test expectation**

Create `packages/create-kiln/src/templates.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { indexPage } from "./templates.js";

describe("create-kiln templates", () => {
  it("shows natural Live.list DX in the default page", () => {
    expect(indexPage).toContain("Live.list");
    expect(indexPage).toContain("key: (todo) => todo.id");
    expect(indexPage).toContain('dependsOn: "todo_events"');
    expect(indexPage).toContain("todos.map((todo)");
    expect(indexPage).not.toContain('name: "todos"');
    expect(indexPage).not.toContain("s-live={todo.id}");
  });
});
```

- [x] **Step 2: Update scaffold page template and test app page**

Modify `packages/create-kiln/src/templates.ts` so `indexPage` includes this public shape. Also create `test-app/pages/todos.tsx` with the same example so the repo has a local fixture:

```tsx
import { Live } from "@kiln/core";

type Todo = {
  id: number;
  title: string;
  completed: boolean;
};

export const load = async () => ({
  todos: Live.list<Todo>({
    key: (todo) => todo.id,
    dependsOn: "todo_events",
    query: async ({ sql }) => sql`
      select id, title, completed
      from todos
      order by id asc
    `,
  }),
});

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <li>
      <span>{todo.completed ? "Done" : "Open"}</span>
      <span>{todo.title}</span>
    </li>
  );
}

export default function TodosPage({ todos }: { todos: Todo[] }) {
  return (
    <ul>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  );
}
```

- [x] **Step 3: Run scaffold and app typechecks**

Run:

```bash
bun test packages/create-kiln/src/templates.test.ts
bunx tsc -p packages/create-kiln/tsconfig.json --noEmit --pretty false
bunx tsc -p test-app/tsconfig.json --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/create-kiln/src/templates.ts packages/create-kiln/src/templates.test.ts test-app/pages/todos.tsx
git commit -m "docs: show natural Live.list DX"
```

---

## Task 10: Final Verification

**Files:**
- All touched files.

- [x] **Step 1: Run source tests**

Run:

```bash
bun run test:unit
```

Expected: PASS with no failures.

- [x] **Step 2: Run DB integration tests**

Run:

```bash
bun --env-file=test-app/.env packages/engine/src/list-store.test.ts
bun --env-file=test-app/.env packages/engine/src/list-watcher.test.ts
bun run test:integration
```

Expected: PASS.

- [x] **Step 3: Run build**

Run:

```bash
bun run build
```

Expected: PASS.

- [x] **Step 4: Run Drizzle/native dependency guard**

Run:

```bash
rg -n "drizzle|drizzle-orm|drizzle-kit|bun-sql|elysia-compress" packages test-app package.json pnpm-lock.yaml bun.lock --glob '!**/dist/**'
```

Expected: no matches.

- [x] **Step 5: Check generated temp files**

Run:

```bash
find . -maxdepth 1 \( -name 'temp_live_list.html' -o -name 'temp_live_list.json' -o -name 'temp_test_page.html' -o -name 'temp_test_page.json' \) -print
```

Expected: no output.

- [ ] **Step 6: Commit final verification script changes**

```bash
git add package.json
git commit -m "test: include live list integration coverage"
```

---

## Self-Review Notes

- The plan preserves the locked DX: no public `mode`, key-based reconciliation, natural JSX `map`.
- `dependsOn` keeps the same meaning as scalar `LiveProp`.
- The plan explicitly separates scalar slot patching from list membership reconciliation while using row-scoped `s-live` for existing row content.
- The first render-boundary helper is intentionally conservative. Preserve the user-facing natural JSX API; internal wrapper/metadata mechanics must stay generated by Kiln.
- The database integration tests must run serially because they share local Postgres/Redis state.
