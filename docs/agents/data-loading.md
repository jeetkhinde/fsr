# Data loading & JSON

Source: `packages/routekit/src/boot.ts`, `page-options.ts`.

## `load()`

Runs on the server for every render (or every bake). Return a plain object; keys become props on your `default` component.

```tsx
export async function load(req) {
  const post = await db.posts.find(req.params.id);
  return { post, ts: Date.now() };
}
export default function Page({ post, ts }: Awaited<ReturnType<typeof load>>) { … }
```

`req` carries `params`, `query`, headers, `formData()`, and the request context. Type props with `Awaited<ReturnType<typeof load>>` so the component and loader can't drift.

## Every page is also a JSON endpoint

There are **two** ways to get JSON out of a page — you rarely need a separate `api/` folder.

### 1. Content negotiation (always on)

Send `Accept: application/json` (and not `text/html`) and the framework returns `load()`'s result as JSON, skipping all HTML rendering. Same URL, same `load()`.

```bash
curl -H 'Accept: application/json' http://localhost:3000/posts/42
# → {"post": {...}, "ts": 1720000000000}
```

### 2. `json_first` — always JSON

For an endpoint that should return JSON to everyone (curl, fetch, and browsers alike), and needs no UI:

```ts
// pages/api/health.ts
export const json_first = true;
export async function load() {
  return { status: 'ok', ts: Date.now() };
}
```

No `default` component required. This is Kiln's idiomatic API route — a page file with `json_first = true`.

> **Do not use the `apiDir` config for runtime routes.** `apiDir` is typed and scaffolded but `startKiln()` never loads it — the `api/` folder is not served at runtime. Use `json_first`, content negotiation, or collocated `actions` instead. See [gotchas.md](gotchas.md).

## Live fields in `load()`

`load()` may return `LiveProp`/`Live.list` values for fields that update in real time after first paint. See [live-and-islands.md](live-and-islands.md).
