# Building apps with Kiln — agent guide

> **Audience:** an AI coding agent writing application code *with* Kiln (not modifying the Kiln framework itself — for that, see the repo's root [`Agents.md`](../../Agents.md) and [`.memory/`](../../.memory/)).
>
> **How to use this:** read this file first for the mental model and the happy path. Load the topic files below only when the task touches that area (progressive disclosure). Every code sample here is verified against the current source — if you find a discrepancy, trust the source and update the doc.

---

## What Kiln is, in one paragraph

Kiln is a file-based React web framework. You write pages under `pages/`. Each page file exports a `load()` (server data), a `default` React component (the UI), and optional `actions` (POST handlers). A single integer export — `promote_after` — decides whether a page is rendered per-request (SSR), baked once (SSG/ISR), or baked after N hits (FSR). Real-time fields come from `LiveProp`/`Live.list` pushed over SSE; client-side interactivity comes from **islands** only (no full-page hydration).

## The mental model (know these five things)

1. **A page is a file.** `pages/posts/[id].tsx` → route `/posts/:id`. `index.tsx` → `/`. See [`routing.md`](routing.md).
2. **`load()` runs on the server and doubles as your API.** The same `load()` returns HTML to a browser and JSON to an `Accept: application/json` client. See [`data-loading.md`](data-loading.md).
3. **Rendering mode is one export.** `export const promote_after = 0 | 1 | N | (absent)`. See [`rendering-and-caching.md`](rendering-and-caching.md).
4. **Mutations are collocated `actions`.** `export const actions = { create(req) {…} }` registers a POST handler on the same route. See [`actions-and-forms.md`](actions-and-forms.md).
5. **Live data + interactivity have exact rules.** `LiveProp` for real-time fields, `island()` for React interactivity, and islands read live data from the store, never the DOM. See [`live-and-islands.md`](live-and-islands.md).
6. **Auth is app policy, not framework.** Kiln ships no auth; bring a library and gate requests in `hooks.ts` → `handle(req, res)`, stashing the user on `req.locals` for `load()` to read. See [`auth.md`](auth.md).

---

## Getting started (verified against `create-kiln`)

Scaffold, then use the CLI (`packages/cli` commands: `dev`, `build`, `start`):

```jsonc
// package.json scripts (from create-kiln)
{
  "scripts": {
    "dev": "kiln dev",
    "build": "kiln build",
    "start": "bun dist/main.js"
  }
}
```

```ts
// kiln.config.ts (from create-kiln default template)
import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: 3000,
  pagesDir: './pages',
  fsr: {
    promoteAfterHits: 2,
    patchDebounceSecs: 5,
    revalidateSeconds: 300,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    postgresUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
  },
});
```

```tsx
// pages/_layout.tsx — root layout owns <html>; silcrow.js drives progressive enhancement
import React from 'react';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Kiln Application</title>
        <script src="/_silcrow/silcrow.js" defer></script>
      </head>
      <body><div id="app">{children}</div></body>
    </html>
  );
}
```

> **Redis/Postgres are only needed for FSR and `LiveProp` SSE.** A pure SSG/SSR/ISR app runs on the disk cache alone. See [`rendering-and-caching.md`](rendering-and-caching.md).

## The canonical page shape

```tsx
// pages/posts/[id].tsx
import React from 'react';
import { Live, AppError } from '@kiln/core';

export const promote_after = 2; // FSR: bake after 2 hits (omit for pure SSR)

export async function load(req) {
  const post = await db.posts.find(req.params.id);
  if (!post) throw AppError.notFound();
  return { post };
}

export default function PostPage({ post }: Awaited<ReturnType<typeof load>>) {
  return <main><h1>{post.title}</h1></main>;
}

export const actions = {
  async delete(req) {
    await db.posts.delete(req.params.id);
    return AppError.redirect('/posts'); // → 303
  },
};
```

---

## Topic index

| File | Read when you are… |
|------|--------------------|
| [`routing.md`](routing.md) | adding routes, dynamic/catch-all segments, layouts, `_error`/`_not-found` |
| [`data-loading.md`](data-loading.md) | writing `load()`, serving JSON, content negotiation, `json_first` |
| [`actions-and-forms.md`](actions-and-forms.md) | handling POST/mutations, forms, `useSilcrowForm`/`useSilcrowAction` |
| [`live-and-islands.md`](live-and-islands.md) | real-time fields (`LiveProp`/`Live.list`) or React interactivity (`island()`) |
| [`auth.md`](auth.md) | authentication/authorization: the `handle` hook, `req.locals`, mounting an auth library |
| [`rendering-and-caching.md`](rendering-and-caching.md) | choosing SSG/ISR/FSR/SSR, cache invalidation, when Redis is required |
| [`gotchas.md`](gotchas.md) | **always skim before assuming a feature exists** — typed-but-unwired traps |

## Source of truth

These docs distill the maintainer-facing, source-verified inventory at [`.memory/features.md`](../../.memory/features.md). When the two disagree, the source code wins, then `features.md`, then this guide. Keep these files in the repo so they ride normal review/CI — Kiln's surface moves fast.
