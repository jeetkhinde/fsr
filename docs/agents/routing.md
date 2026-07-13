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
