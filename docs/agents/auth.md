# Auth in a Kiln app — agent guide

> Read this when adding authentication/authorization to a Kiln app, or when
> deciding *where* per-request policy (auth, request-id, logging) belongs.
> Every code sample is verified against the current source.

## TL;DR (the shape to copy)

Kiln does **not** ship an auth system, and neither Bun nor Elysia ships a full
one — they give primitives (`Bun.password`, cookies, JWT plugins). Bring an auth
library (Jag's List uses **better-auth**) and wire it with **two** Kiln seams:

1. **Mount the auth library's HTTP handler** as a raw route (its own catch-all
   endpoints). Your own login/logout form handlers are ordinary Kiln actions.
2. **Put your per-request gate in `hooks.ts` → `handle(req, res)`** — resolve the
   session once, stash the user on `req.locals`, and short-circuit anonymous
   requests. `load()`/actions then read `req.locals.user` (no second lookup).

```ts
// hooks.ts — the single place app auth policy lives (SvelteKit's `handle`)
import type { KilnRequest, KilnResponse } from '@kiln/core';
import { getSessionUser } from './lib/session.js';

const PUBLIC = ['/login', '/invite/', '/_kiln/', '/assets/', '/favicon.ico'];
const isPublic = (p: string) => PUBLIC.some((x) => p === x || p.startsWith(x));

export async function handle(req: KilnRequest, res: KilnResponse): Promise<void> {
  if (isPublic(req.path)) return;                     // no session needed
  const user = await getSessionUser(req.headers);
  if (user) { req.locals.user = user; return; }       // authenticate ONCE → locals
  res.redirect('/login', 302);                        // short-circuit anon
}
```

```ts
// pages/index.tsx — read the user, never re-fetch it
export async function load(req) {
  const user = requireUser(req);   // reads req.locals.user (sync)
  return { user };
}
```

## Why two layers (hooks vs middleware)

Kiln has two request-time extension points. They are **different layers with
different owners** — not two ways to do the same thing. Do not collapse them.

| Layer | Owner | What it's for | Auth? |
|-------|-------|---------------|-------|
| **Adapter middleware** — `csrf`, `compression`, `timeout`, `tracing` (`applyMiddleware`) | The framework | Elysia-specific cross-cutting infra, identical for every app | **No.** Never put auth here — it would leak app policy (allowlists, roles) into the framework. |
| **App `handle` hook** — `hooks.ts` | Your app | Per-request policy: authentication, request-id, logging, redirects | **Yes.** This is the one place app auth lives. |

## How `handle` works (the contract)

`handle` is defined by the `KilnHandle` type in `@kiln/core`:

```ts
type KilnHandle = (req: KilnRequest, res: KilnResponse) => void | Promise<void>;
```

- The **adapter** runs it after it builds the `KilnRequest` and **before** every
  Kiln-registered route's `load()`/action — for pages, actions, **and** SSE,
  including framework-internal routes (`/__kiln/fsr`, `/__kiln/inspect`). So one
  allowlist gates everything; you don't gate route-by-route.
- **Attach data** by mutating `req.locals` (e.g. `req.locals.user = …`). It is
  always an object (`{}`), so no null-check needed before assigning.
- **Short-circuit** by writing to `res` — `res.redirect('/login')`, or
  `res.json(...)` + `res.status = 401`. If `res.bodyType` is set when `handle`
  returns, the adapter sends that response and **skips** the route handler.
- **Continue** by returning without touching `res`.

`req.locals` is per-request scratch space — Kiln's equivalent of SvelteKit's
`event.locals`. It carries whatever `handle` puts there into `load()`/actions.

## Authentication vs authorization — split them

- **`handle` = authentication** ("who are you") + the coarse gate ("is there a
  session at all"). Runs once, centrally.
- **`load()`/actions = authorization** ("can *you* do *this*") — role checks read
  from `req.locals.user`, no session re-fetch:

```ts
// lib/session.ts — sync helpers over req.locals (handle already resolved it)
export function requireUser(req: KilnRequest): SessionUser {
  const user = req.locals.user as SessionUser | undefined;
  if (!user) throw AppError.unauthorized('Sign in required');
  return user;
}
export function requireAdmin(req: KilnRequest): SessionUser {
  const user = requireUser(req);
  if (!isAtLeastAdmin(user.role)) throw AppError.unauthorized('Admin access required');
  return user;
}
```

## Login and logout are ordinary actions

Actions receive `(req, res)` and can set cookies (ADR-019), so form handlers are
plain Kiln actions on a page — no raw routes. Because they are Kiln routes,
`handle` **does** run for them, so the page they live on must be in your public
list (`/login` below), or sign-in would require a session to reach.

```tsx
// pages/login.tsx
import { AppError, type KilnRequest, type KilnResponse } from '@kiln/core';
import { auth } from '../lib/auth.js';

export const actions = {
  async signin(req: KilnRequest, res: KilnResponse) {
    const form = await req.formData();
    const upstream = await auth.api.signInEmail({
      body: { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') },
      asResponse: true,
    });
    if (!upstream.ok) throw AppError.redirect('/login?error=1');

    // better-auth returns fully-formed Set-Cookie strings — pass them through
    // verbatim rather than re-serializing. For cookies you own, prefer
    // res.cookies.set('name', value, { httpOnly: true, sameSite: 'lax' }).
    for (const cookie of upstream.headers.getSetCookie()) {
      res.headers.append('set-cookie', cookie);
    }
    throw AppError.redirect('/');
  },
};
```

```html
<form method="post" action="/login?/signin">
```

Cookies staged on `res` survive `AppError.redirect` — they live in `res.headers`,
independent of the body — which is what makes the sign-in-then-redirect flow work.

**A logout form in a layout must target a page's action absolutely.** Actions
register against a *page* pattern and layouts have none, so a logout form in
`_layout.tsx` posts to `/login?/signout` rather than a relative action.

### The auth library's own handler is still a raw route

It's a catch-all owned by the library, not a Kiln page, so it can't be a file
route. Mount it from `config.server.setup` — no custom entry point needed, and
the app keeps `kiln dev` / `kiln start` (and therefore islands):

```ts
// kiln.config.ts
export default defineConfig({
  server: {
    async setup({ adapter }) {
      const { auth } = await import('./lib/auth.js');
      adapter.registerRaw?.('/api/auth/*', (request) => auth.handler(request)); // better-auth
      adapter.registerAsset('/assets/app.css', './styles/app.css');
    },
  },
});
```

`setup` runs after the FSR runtime is up and **before** pages are mounted, so an
app route wins over a page at the same path. `registerRaw` hands the untouched
`Request` straight to the library and `handle` never runs for it — public by
construction, which is what a sign-in endpoint needs.

## Gotchas

- **Don't reach for the Elysia `better-auth` macro** (`macro({ auth: { resolve }})`
  + `auth: true` per route). It's Elysia-specific and per-route opt-in; Kiln is
  file-based/SvelteKit-shaped and already has `hooks.ts`. Use `handle` + `locals`
  — it stays adapter-agnostic (works for any future `ServerAdapter`).
- **Layout `load()` never sees `req.locals.user`.** Layout loads run with a
  stripped, cache-safe request (empty headers *and* empty `locals`) because a
  layout can be baked into a shared cache entry — per-user data there would leak
  to every visitor. Keep auth-dependent rendering in page `load()`, not layouts.
- **Per-user pages are never baked automatically** — their `load()` reads `req.locals`, so the classifier keeps them pure SSR (ADR-016); no export needed. To CACHE them per user, export `bake = 'user'` and add an `identity` export to hooks.ts (`(req) => req.locals.user?.id ?? null` — ADR-017); only for query-free loads. `export const bake = false`
  on any page whose `load()` reads `req.locals.user`, or one user's baked HTML is
  served to everyone. See [`rendering-and-caching.md`](rendering-and-caching.md).
- **Form POSTs need CSRF origin headers** — Kiln's csrf middleware checks
  `origin`. This applies to action-based login too, not just raw routes.

## Related

- [`data-loading.md`](data-loading.md) — `load()`, content negotiation (the 401-JSON
  vs 302-redirect branch in `handle` mirrors it).
- [`gotchas.md`](gotchas.md) — action/response gotchas.
- `.memory/decisions.md` ADR-015 — the architectural rationale for `handle`+`locals`.
