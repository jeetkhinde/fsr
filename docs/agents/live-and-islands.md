# Live data & React islands

Two distinct mechanisms. `LiveProp` pushes real-time **data** over SSE. `island()` adds client-side React **interactivity**. They compose, but each has hard rules.

Sources: `packages/core/src/live-prop.ts` (`Live`), `packages/live/src`, `packages/react/src/island.tsx`, `hooks.ts`.

## LiveProp — real-time scalar fields

Return a `LiveProp` from `load()` and the field updates in place after first paint, whenever its dependencies change.

```tsx
import { Live } from '@kiln/core';

export async function load() {
  return {
    // value, dependency keys, options
    activeUsers: Live.value(0, ['sessions'], { revalidate: 300 }),
  };
}
```

`Live` factory (verified — `packages/core/src/live-prop.ts:59`):

```ts
Live.value<T>(value, dependsOn?: (string | DependencyKey)[], options?: {
  patchDebounce?: number; revalidate?: number | false; target?: LiveTarget
})
Live.initial<T>(value)          // no deps, never updates
Live.list<T>(options)           // see below
```

**Delivery target** (`options.target`):

| Target | Effect |
|--------|--------|
| `'dom'` (default) | Patches the `s-live="field"` DOM node via SSE |
| `'store'` | Updates the client store only (no DOM write) — **required inside islands** |
| `'dom-and-store'` | Both |

### Manual dependency keys: the row-level escape hatch

`dependsOn` keys accept either form:
```ts
['contacts:id=42']
[{ table: 'contacts', column: 'id', value: '42' }]
```

Manual keys remain fully supported alongside [auto-deps](rendering-and-caching.md#auto-derived-dependencies-auto-deps) (`createKilnSql`) — they aren't superseded by it, they compose with it. Auto-deps only ever captures **table names** (best-effort, from `FROM`/`JOIN`/`INTO`/`UPDATE`); it has no way to know a field only cares about one row. A manual `'contacts:id=42'` key is how you express that row-level precision: it still fires from the same trigger machinery (`kiln sync-triggers` / `kiln_emit_event`), but the app decides when to emit that granularity — typically by passing a row-scoped `depKey` in application code rather than relying on the generic table-level trigger, since `kiln sync-triggers`' triggers only ever emit table-level dep keys (`<table>`). If a page's field genuinely needs `contacts:id=42`-shaped invalidation, keep it as an explicit `dependsOn` entry; auto-deps will still union in whatever tables the field's `load()` query touched on top of it.

## Live.list — real-time collections with row diffing

```tsx
import { Live } from '@kiln/core';

export const bake = 'static';
export async function load() {
  return {
    todos: Live.list<Todo>({
      key: (t) => t.id,              // row identity for reconciliation
      dependsOn: 'todo_events',
      query: async ({ sql }) => sql`SELECT id::text, title, completed FROM todos ORDER BY id`,
    }),
  };
}

export default function Todos({ todos }: Awaited<ReturnType<typeof load>>) {
  return <ul>{todos.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

The server computes row-level diffs (`insert` / `remove` / `move` / `replace-row`) — changing one row in a list of 1000 sends one patch, not 1000. The returned value is a real `T[]`; metadata rides on a non-enumerable symbol.

## Islands — client-side React interactivity

Full-page hydration is prohibited (ADR-014). Interactivity comes from islands: named React components mounted into otherwise-static baked HTML.

```tsx
// islands/Counter.tsx — ordinary React component, default export, basename === island name
import { useLiveValue } from '@kiln/react';
export default function Counter({ start }: { start: number }) {
  const activeUsers = useLiveValue<number>('activeUsers', 0); // reads from store
  return <button>{start + activeUsers}</button>;
}
```

```tsx
// pages/dashboard.tsx
import Counter from '../islands/Counter.js';
import { island } from '@kiln/react';
import { Live } from '@kiln/core';

const CounterIsland = island(Counter, 'Counter', { hydrate: 'visible' });
// hydrate: 'load' (default) | 'idle' | 'visible'

export async function load() {
  return { start: 41, activeUsers: Live.value(0, ['sessions'], { target: 'store' }) };
}
export default function Dashboard({ start }: Awaited<ReturnType<typeof load>>) {
  return <main><CounterIsland start={start} /></main>;
}
```

### The four island rules (do not violate)

1. **Props are bake-time values** embedded in the marker — plain JSON only (no `Date`/`Map`/functions).
2. **Live data inside an island uses the store**: declare the field with `target: 'store'` and read it with `useLiveValue(field, fallback)`; pass the bake-time value as `fallback` so SSR and first client render match.
3. **Silcrow never patches DOM inside an island** — the React root owns that subtree. A `dom`-target `LiveProp` inside an island triggers a bake-time warning.
4. **Navigation stays with silcrow** — plain `<a>` links, no client router inside islands.

Nested islands are unsupported (outermost wins).

> **Limitation:** live updates are **not** supported for `cache_key`-variant pages — they're skipped with a one-time warning. See [gotchas.md](gotchas.md).
