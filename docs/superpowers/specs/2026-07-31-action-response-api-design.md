# Action/Response API — Design

**Date**: 2026-07-31
**Status**: Approved, pending implementation plan
**Scope**: Kiln framework, `P0 #2` in `.memory/active-work.md`
**Branch**: `feat/action-response-api`

## Problem

A page action cannot touch the response. `buildActionHandler` invokes it as
`actions[actionName](req)` (`packages/routekit/src/boot.ts:88`), so an action can set no cookies,
no headers, and no status of its own. The `res` it would need already exists one scope up — the
handler is built as `(req: KilnRequest, res: KilnResponse)` at `packages/routekit/src/boot.ts:72`
— it is simply never passed through.

Two consequences are already observed in the tree, not hypothesised:

1. **Auth endpoints cannot be actions.** `apps/jags-list/src/main.ts:24-56` hand-rolls
   `/auth/login` and `/auth/logout` as raw Elysia routes purely to emit `Set-Cookie`. The comment
   there names the reason: *"actions receive only `req` and cannot set Set-Cookie headers"*. Those
   raw routes are why the app owns a custom entry point at all, which in turn is why it forfeits
   the island build pipeline (`P0 #1`).
2. **Some status codes are unreachable.** `AppError` offers only 404/401/403/422/500/redirect
   (`packages/core/src/errors.ts`), so the 409 wanted in Plan 3b could not be returned.

A third problem blocks any fix and is not recorded in the gap survey: `KilnResponse.headers` is
`Record<string, string>` (`packages/core/src/types.ts:33`) — one value per header name. `Set-Cookie`
is inherently multi-value, and better-auth emits several at once (`apps/jags-list/src/main.ts:37`
loops `getSetCookie()`). **Passing `res` to actions alone would not fix the driving case.**

## Non-goals

Deliberately excluded, to keep this to one reviewable change:

- The CLI/custom-entry islands seam (`P0 #1`). Rewriting jags-list's auth onto actions (§6) is what
  will tell us how much of #1 survives; that reassessment happens after this ships, not inside it.
- Any change to how the silcrow client consumes action results.
- `AppError` status codes beyond the 409 named below.

## 1. The action contract

New exported type in `@kiln/core`:

```ts
export type KilnAction = (req: KilnRequest, res: KilnResponse) => unknown | Promise<unknown>;
```

Pages type their export as `Record<string, KilnAction>`. `packages/routekit/src/boot.ts:88` becomes:

```ts
const result = await actions[actionName](req, res);
```

`res` is the object `buildActionHandler` already holds; nothing new is constructed, and delivering
it to the action requires no adapter change. (The adapter work in §2.3 is for multi-value headers,
a separate concern that would exist even without this contract change.)

**Backward compatible in both directions.** TypeScript assigns a one-parameter function to a
two-parameter type, and JavaScript ignores surplus arguments at runtime. Existing actions
— `test-app/pages/index.tsx:39`, and every action in `apps/jags-list/pages/` — keep working with
no edit.

### Why `(req, res)` and not the alternatives

`(req, res)` is already the contract for all four of Kiln's other handler surfaces: the `handle`
hook (`packages/core/src/types.ts:61`), and `registerPage` / `registerAction` / `registerSSE`
(`packages/core/src/types.ts:87-97`). Adding a fifth, different shape for actions would be the
inconsistency, not the fix.

Two alternatives were considered and rejected:

- **Return a response descriptor** (`return { data, status, cookies }`). Pure and easy to test
  without a mock `res`, but it collides with the existing contract where a returned plain object
  *is* the JSON payload — `{ status: 409 }` becomes ambiguous between descriptor and data, needing
  a Symbol brand to disambiguate. Streaming and binary fit badly.
- **Return a web `Response`.** Standard, native multi-cookie, full control for free — but the least
  adapter-agnostic option (every adapter must translate it), and it leaves cookie construction as
  the manual string-building this design exists to remove.

## 2. Response model

### 2.1 `headers` becomes a `Headers`

`KilnResponse.headers` changes from `Record<string, string>` to a web `Headers` instance, giving
native `.append()` and `.getSetCookie()`. This also makes request and response symmetric —
`KilnRequest.headers` is already a `Headers` (`packages/core/src/types.ts:10`).

Migration cost is contained and entirely internal to the framework: roughly twelve write sites
(`packages/routekit/src/boot.ts:257,285,410,411`, `packages/routekit/src/html-markers.ts:74,86`,
`packages/routekit/src/image-handler.ts:27,28,62,63`,
`packages/routekit/src/page-render.ts:770`) and roughly eight test assertions in
`packages/routekit/src/boot.test.ts` convert from `res.headers['x'] = y` to `res.headers.set('x', y)`.
**No application code writes `KilnResponse.headers`** — every `res.headers` hit under `apps/` is on
a `fetch` Response, not a `KilnResponse`.

The change is breaking for any third-party `ServerAdapter` implementation. Only
`packages/adapter-elysia` exists.

### 2.2 `res.cookies`

```ts
interface KilnCookies {
  set(name: string, value: string, opts?: CookieOptions): void;
  delete(name: string, opts?: Pick<CookieOptions, 'path' | 'domain'>): void;
}

interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
}
```

`set` serializes to a `Set-Cookie` value and appends it to `res.headers`; multiple calls produce
multiple headers. `delete` is empty-value plus `maxAge: 0`, carrying `path`/`domain` through
because a cookie is only cleared when those match the one that set it. Applications never build a
`Set-Cookie` string.

**`path` defaults to `/`** when not supplied, for both `set` and `delete`. Without a default the
browser scopes the cookie to the request's directory, so a session cookie set from
`POST /auth/login` would be confined to `/auth` and invisible to the rest of the app — a silent
failure, and the exact shape of bug this design exists to prevent. No other option is defaulted;
`httpOnly`, `secure` and `sameSite` are the application's call.

`cookies` is a **required** member of the `KilnResponse` interface, not optional like `binary?`
(`packages/core/src/types.ts:43`). Every adapter must provide it, so app code can rely on it
unconditionally.

Cookie serialization lives in `@kiln/core` alongside the types.

### 2.3 How the adapter emits multiple `Set-Cookie` values

The Elysia adapter emits headers by mutating `ctx.set.headers`, a plain record
(`packages/adapter-elysia/src/context.ts:95`, `packages/adapter-elysia/src/adapter.ts:70,76`),
which cannot hold two `Set-Cookie` values in one string slot.

Elysia 1.4.28 (the installed version) supports two ways out, both read from its source:

1. **An array at `set.headers['set-cookie']`** — typed as `'set-cookie'?: string | string[]` in
   `dist/types.d.ts`, and `handleSet` converts an array via
   `parseSetCookies(new Headers(set.headers), set.headers['set-cookie'])` in
   `dist/adapter/utils.js`.
2. **`set.headers` being a `Headers` instance** — `dist/adapter/utils.js` branches on
   `set.headers instanceof Headers` and passes `set` straight to `new Response(response, set)`;
   its `mergeHeaders` has a dedicated branch that iterates `getSetCookie()` and appends each value.

**Decision: use the array (option 1).** Option 2 is superficially tidier given `KilnResponse.headers`
is becoming a `Headers`, but it carries a silent-failure risk. Kiln writes `ctx.set.headers['x'] = y`
record-style outside the translation function — `packages/adapter-elysia/src/context.ts:46,63,69,77`
and `packages/adapter-elysia/src/middleware/compression.ts:22-24`. Against a `Headers` instance
those writes would set a plain JS property rather than a header and be **dropped with no type error
and no runtime error**. Option 2 would require converting every such write, in Kiln and in any
middleware added later; option 1 keeps `ctx.set.headers` a record, so all existing writes stay
correct and the change is confined to `handleElysiaResponse`.

Concretely, `handleElysiaResponse` reads the new `Headers` and writes the record: `.get()` for
single-valued names, plus `ctx.set.headers['set-cookie'] = res.headers.getSetCookie()` when any
cookies are present.

Related, and checked because it would have invalidated the above: `handleSet` overwrites
`set.headers['set-cookie']` from Elysia's own cookie jar whenever `set.cookie` is populated
(`dist/adapter/utils.js`). Kiln never uses that jar — there is no `ctx.cookie` or `set.cookie`
anywhere in `packages/adapter-elysia/src` — so it cannot clobber the array. Anyone reaching for
Elysia's native cookie API later must revisit this.

The above is read from Elysia's source, not executed. The plan's first task is therefore an
adapter-level test asserting two `Set-Cookie` headers actually reach the wire, which settles it
empirically before the rest is built on top.

The SSE path (`packages/adapter-elysia/src/adapter.ts:70,76`) iterates `res.headers` too and must
be converted alongside it.

## 3. Precedence rules

These are deliberately the same rule the `handle` hook already documents at
`packages/core/src/types.ts:56`, so the framework has one rule rather than two.

1. **The action throws `AppError`** → unchanged behaviour (`boot.ts:91-99`): `Redirect` becomes
   `res.redirect`, anything else becomes `res.status` + a JSON error body. Cookies staged on `res`
   still go out, because they live in `res.headers` independently of the body. So
   `res.cookies.set(...)` followed by `throw AppError.redirect('/')` works — and that is precisely
   the login case and the logout case.
2. **`res.bodyType` is set when the action returns** → the framework sends what the action
   committed and ignores the return value. If the action also returned a non-`undefined` value,
   emit a `warnOnce`: a silently discarded return is the same class of invisible asymmetry that
   made `Live.list`'s missing auto-deps a bug rather than a gap.
3. **Otherwise** → unchanged: `res.json(result || { success: true })`. Because `res.json()` does not
   touch `res.status`, an action can set `res.status = 409` and return a body; this is how custom
   status codes become reachable.
4. `invalidateActor` (`boot.ts:67-71`) runs on every path, exactly as it does today.

## 4. Errors

`AppError` keeps its role: throwing is how code *deep* in a call stack signals an outcome, where
`res` is not in reach — a db helper that detects a duplicate cannot set `res.status`.

One addition: `AppError.conflict(message)` and `'Conflict'` in the type union, for the 409 observed
as unreachable in Plan 3b. Every status beyond that uses `res.status`; the union is not opened up
further.

## 5. Isolation and boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `@kiln/core` types + cookie serializer | Declares `KilnAction`, `KilnCookies`, `CookieOptions`; serializes a cookie to a `Set-Cookie` string | Nothing (pure; unit-testable in isolation) |
| `KilnResponse` implementations | Own `headers: Headers`, expose `cookies` backed by it | Core types + serializer |
| `buildActionHandler` (routekit) | Passes `res` through; applies the §3 precedence rules | Core types |
| `ElysiaAdapter` emit path | Faithfully emits multi-value headers onto the wire | Core types; §2.3 spike |

The cookie serializer is pure and has no dependency on either the response object or the adapter,
so it is testable on its own. `buildActionHandler`'s precedence logic is testable with a fake
`KilnResponse` and no server.

## 6. Verification

Tests for each precedence rule and for cookie serialization (attributes, `sameSite`, `delete`
semantics), plus the adapter-level test from §2.3 that two `Set-Cookie` headers actually reach the
wire — which runs first, since everything else depends on it.

**The real verification is falsification, not added tests.** Delete the raw Elysia `/auth/login`
and `/auth/logout` routes from `apps/jags-list/src/main.ts:24-56` and reimplement them as ordinary
Kiln actions. jags-list's existing integration suites already drive the full cookie dance —
`tests/gate.integration.test.ts:21`, `tests/app.integration.test.ts:44,107`,
`tests/crud.integration.test.ts:19`, `tests/purity.integration.test.ts:25` all read
`getSetCookie()` — so they pass unchanged only if this genuinely works end to end.

Per the project's verification discipline: `bun run test:unit`, `bun run test:integration`, **and**
`bun run build` — tsc and tests alone have missed client-bundle breakage before.

That rewrite also answers the deferred scope question: if login and logout no longer need raw
routes, we learn how much of `P0 #1` remains.

## 7. Documentation

- An ADR recording the action/response contract and the `headers` type change, following the
  ADR-011 / ADR-015 / ADR-018 precedent for public-surface decisions.
- `docs/agents/auth.md` and the auth how-to currently teach the raw-route workaround; both need
  updating to the action-based recipe.
- `.memory/bugs-active.md` §1 and `.memory/active-work.md` § Next Priorities on completion.
