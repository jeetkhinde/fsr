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

### `LiveProp` in a layout

A `_layout.tsx`'s `load()` may return `LiveProp` fields, and they update exactly like a page's: the field is registered under the **page's** concrete route (which is what the browser subscribes with), its `load()` is dep-captured on its own, and the watcher re-runs that layout's `load()` when a captured table changes. Nothing extra to declare.

Two consequences worth knowing:

- **Auto-deps are per segment.** A layout field depends on the tables the *layout's* `load()` queried, never the page's, and vice versa — one write does not revalidate the other segment's fields.
- **A name collision resolves to the page.** If a layout and its page both return a field called `unread`, the page's wins, matching how `load()` results merge into props.

`Live.list` in a layout is a different story — see [the dynamic-segment restriction](#livelist--real-time-collections-with-row-diffing) below.

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

### Markup other than `<ul>`/`<li>`

The example above works with no extra markup because Kiln can find `<li>` rows inside a `<ul>`/`<ol>` on its own. For **any other markup** — a div board, a table, a definition list — put `data-kiln-row={key}` on each row element, where the value equals the list's `key(row)`:

```tsx
// A div-based board
export default function Board({ cards }: Awaited<ReturnType<typeof load>>) {
  return (
    <div className="board">
      {cards.map((c) => (
        <article key={c.id} data-kiln-row={c.id}>
          <h3>{c.title}</h3>
        </article>
      ))}
    </div>
  );
}
```

```tsx
// A table
<table>
  <tbody>
    {rows.map((r) => (
      <tr key={r.id} data-kiln-row={r.id}>
        <td>{r.title}</td>
      </tr>
    ))}
  </tbody>
</table>
```

Kiln marks the rows' **enclosing element** as the list container — the `div.board` and the `tbody` above — so you don't declare it. Two things to know:

- **The value must equal `key(row)`.** It is how a marked element is matched to its row. A `data-kiln-row` value matching no row is warned about once and that element simply never updates.
- **Markers are all-or-nothing per list.** If Kiln sees any `data-kiln-row` for a list it uses only marked elements; without markers it falls back to the `<ul>`/`<li>` scan. Marking some rows and not others means the unmarked ones are not live.

### A `Live.list` inside an island

The default `dom` target cannot reach an island — silcrow never patches DOM the React root owns (rule 3 below), and a `dom` list rendered by an island is warned about at bake time. Declare `target: 'store'` and read it with `useLiveList()`:

```tsx
// pages/board.tsx
export async function load() {
  return {
    cards: Live.list<Card>({
      key: (c) => c.id,
      target: 'store',                 // no DOM marking; patches go to the store
      query: async ({ sql }) => sql`SELECT id::text, title FROM cards ORDER BY position`,
    }),
  };
}
```

```tsx
// islands/Board.tsx
import { useLiveList } from '@kiln/react';

export default function Board({ initial }: { initial: Card[] }) {
  const cards = useLiveList<Card>('cards', { key: (c) => c.id, initial });
  return <div>{cards.map((c) => <article key={c.id}>{c.title}</article>)}</div>;
}
```

| Target | Effect |
|--------|--------|
| `'dom'` (default) | Rows are marked and patched in place. Not delivered inside an island. |
| `'store'` | No marking at all; patches go to the `live-list:<name>` store scope for `useLiveList()`. |
| `'dom-and-store'` | Both — for a list rendered outside an island whose data an island also reads. |

Three things to know:

- **`key` must match the server's.** Patches identify rows by `key(row)`, and that function cannot be serialized to the browser — so the island passes its own copy. A mismatch means patches quietly apply to nothing.
- **Initial rows come from the baked seed** (`window.__kiln_seed`), so `initial` is only needed for the server render (pass the island prop, as above).
- **Patches that land before the island hydrates are replayed**, not lost — the client keeps a bounded log (200 patches) that `useLiveList` drains on mount.

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
2. **Live data inside an island uses the store**: declare the field with `target: 'store'` and read it with `useLiveValue(field, fallback)` — or, for a `Live.list`, [`useLiveList(name, { key })`](#a-livelist-inside-an-island). Pass the bake-time value as `fallback`/`initial` so SSR and first client render match.
3. **Silcrow never patches DOM inside an island** — the React root owns that subtree. A `dom`-target `LiveProp` **or `Live.list`** inside an island triggers a bake-time warning.
4. **Navigation stays with silcrow** — plain `<a>` links, no client router inside islands.

Nested islands are unsupported (outermost wins).

> **Limitation:** live updates are **not** supported for `cache_key`-variant pages — they're skipped with a one-time warning. See [gotchas.md](gotchas.md).
