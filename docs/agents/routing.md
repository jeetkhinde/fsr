# Routing

File-based, from `pages/` (configurable via `pagesDir`). Source: `packages/routekit/src/discover.ts`, `manifest.ts`.

## File → route

| File | Route |
|------|-------|
| `pages/index.tsx` | `/` |
| `pages/posts/index.tsx` | `/posts` |
| `pages/posts/[id].tsx` | `/posts/:id` (`req.params.id`) |
| `pages/files/[...path].tsx` | `/files/*` catch-all |
| `pages/(marketing)/about.tsx` | `/about` — `(group)` folders are stripped from the URL |

Route priority is resolved automatically: **static > dynamic (`:param`) > wildcard (`*`)**.

## Special files (per directory)

| File | Purpose |
|------|---------|
| `_layout.tsx` | Wraps all child routes; nested layouts inherit down the chain |
| `_error.tsx` | Rendered when a page in/below this dir throws; nearest wins. Receives `{ error: { status, message, type }, path }` |
| `_not-found.tsx` | Rendered for `AppError.notFound()`; falls back to `_error.tsx` |
| `_loading.tsx` | **Discovered but NOT wired** — no server-side effect today. Don't rely on it. |

## Layouts

```tsx
// pages/dashboard/_layout.tsx
import React from 'react';
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <div className="dash"><nav>…</nav>{children}</div>;
}
```

Layouts bake **once per URL pattern** and are shared by every route beneath them (ADR-011). The root `_layout.tsx` owns `<html>`/`<head>` and must include `<script src="/_silcrow/silcrow.js" defer>` for progressive enhancement.

A layout on a dynamic pattern may read the params **its own** pattern owns, and gets one baked entry per concrete value:

```tsx
// pages/projects/[id]/_layout.tsx — one bake per project id, shared by
// /projects/7/board and /projects/7/activity.
export async function load(req: KilnRequest) {
  return { project: await projectById(req.params.id) };
}
```

What a layout still must not read in `load()`: `req.query`, and any param belonging to a *descendant* page (`[taskId]` under this layout) — neither is in the layout's cache key, so both would serve one request's data to every other request. Push that data into the page's own `load()`. A `Live.list` inside a dynamic-segment layout is not supported yet either (its updates are identified by pattern, so every project would share one list); Kiln warns once per pattern — move the list into the page.

## Routes the file router can't own

Some endpoints are not pages: a third-party auth library's catch-all, a webhook that needs the untouched `Request`, a stylesheet outside `public/`. Declare them in `config.server.setup` rather than writing a custom entry point — the CLI is what wires Vite, islands, and the FSR supervisors, so leaving it costs an app all three:

```ts
// kiln.config.ts
export default defineConfig({
  server: {
    async setup({ adapter, mode }) {          // mode: 'dev' | 'start'
      const { auth } = await import('./lib/auth.js');
      adapter.registerRaw?.('/api/auth/*', (request) => auth.handler(request));
      adapter.registerRaw?.('/webhooks/stripe', handleStripe, { method: 'POST' });
      adapter.registerAsset('/assets/app.css', './styles/app.css');
    },
  },
});
```

- **Runs before pages are mounted**, so an app route wins over a page at the same path.
- **`registerRaw` bypasses the page pipeline entirely** — no `KilnRequest`, no `hooks.ts` `handle` hook, no request timeout. That is deliberate: a sign-in endpoint must be reachable without a session. Anything that *should* be gated belongs in a page or action instead.
- **`method` defaults to every method**; pass `{ method: 'POST' }` to narrow.
- A `setup` that throws aborts the boot rather than starting a half-wired server.

## Error handling from a route

Throw typed errors from `load()` or actions (`@kiln/core`):

```ts
import { AppError } from '@kiln/core';
throw AppError.notFound();       // → 404, renders nearest _not-found.tsx / _error.tsx
throw AppError.unauthorized();   // → 401
throw AppError.validation(msg);  // → 422
throw AppError.internal();       // → 500
return AppError.redirect('/x');  // → 303 (return from an action)
```

On page routes these map to the real HTTP status and render the error UI; JSON clients get `{ error, status }`. A non-`AppError` throw renders a generic 500.

See also: [data-loading.md](data-loading.md), [gotchas.md](gotchas.md).
