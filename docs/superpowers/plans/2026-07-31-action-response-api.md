# Action/Response API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Kiln page action set cookies, headers, and a custom status by receiving the response object as a second argument.

**Architecture:** `buildActionHandler` already holds a `KilnResponse` it never passes to the action; pass it through. Because `KilnResponse.headers` is a `Record<string, string>` and cannot hold multiple `Set-Cookie` values, it becomes a web `Headers` (matching `KilnRequest.headers`), with a `res.cookies` helper that serializes and appends. The Elysia adapter translates that `Headers` back into Elysia's record on the way out, using an array for `set-cookie`.

**Tech Stack:** TypeScript, Bun (`bun:test`), Elysia 1.4.28, React 19.

**Spec:** `docs/superpowers/specs/2026-07-31-action-response-api-design.md`

**Branch/worktree:** `feat/action-response-api` at `.worktrees/feat-action-response-api/`

## Global Constraints

- **All work happens inside the worktree.** `cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/feat-action-response-api` at the start of every task — the shell's working directory resets between turns, and running tests in the main workspace validates the wrong tree.
- **Never commit to `main`.** All commits land on `feat/action-response-api`.
- **`bun run build` is mandatory before any completion claim**, in addition to `bun run test:unit`. Type-checking and unit tests have missed client-bundle breakage in this repo before.
- **Server-only code must never reach the `@kiln/core` barrel** (`packages/core/src/index.ts`). Islands import from it and Vite externalizes `node:async_hooks`/`bun` for the browser. The cookie module added in Task 2 is pure and safe; keep it that way.
- Integration tests (`bun run test:integration`, `RUN_APP_TESTS=1`) need live PostgreSQL and Redis, and `test-app/.env` present.
- Existing public behaviour must not change except as specified. One-argument actions must keep working untouched.

---

### Task 1: Prove Elysia emits multiple `Set-Cookie` from an array

Everything downstream assumes Elysia 1.4.28 turns `ctx.set.headers['set-cookie'] = [a, b]` into two real headers. That was read from Elysia's source, never executed. Prove it first, and keep the test as a regression guard for future Elysia upgrades.

**Files:**
- Create: `packages/adapter-elysia/src/multi-cookie.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no exports. Establishes the fact Task 3's `applyHeaders` relies on.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';

// Guards the assumption Task 3's applyHeaders() is built on: Elysia accepts a
// string[] at set.headers['set-cookie'] and expands it into one header per
// entry. If a future Elysia upgrade breaks this, this test fails loudly rather
// than silently collapsing two cookies into one.
describe('Elysia multi-value Set-Cookie', () => {
  it('emits one Set-Cookie header per array entry', async () => {
    const app = new Elysia().get('/two', (ctx: any) => {
      ctx.set.headers['set-cookie'] = ['a=1; Path=/', 'b=2; Path=/'];
      return { ok: true };
    });

    const res = await app.handle(new Request('http://localhost/two'));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies).toContain('a=1; Path=/');
    expect(cookies).toContain('b=2; Path=/');
  });

  it('still emits a single Set-Cookie when given a plain string', async () => {
    const app = new Elysia().get('/one', (ctx: any) => {
      ctx.set.headers['set-cookie'] = 'a=1; Path=/';
      return { ok: true };
    });

    const res = await app.handle(new Request('http://localhost/one'));
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/']);
  });
});
```

- [ ] **Step 2: Run it**

```bash
bun test packages/adapter-elysia/src/multi-cookie.test.ts
```

Expected: PASS, both tests.

**If it fails, stop and report.** The whole §2.3 decision rests on this. Do not work around it — the fallback (assigning a `Headers` instance to `ctx.set.headers`) was rejected in the spec because it silently breaks record-style header writes elsewhere in the codebase, and re-opening that decision is the user's call, not the implementer's.

- [ ] **Step 3: Commit**

```bash
git add packages/adapter-elysia/src/multi-cookie.test.ts
git commit -m "test(adapter): prove Elysia expands a set-cookie array into multiple headers"
```

---

### Task 2: Cookie serialization in `@kiln/core`

A pure module: no dependency on the response object or any adapter, so it is testable on its own.

**Files:**
- Create: `packages/core/src/cookies.ts`
- Create: `packages/core/src/cookies.test.ts`
- Modify: `packages/core/src/index.ts` (add one export line)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CookieOptions { path?, domain?, maxAge?, expires?, httpOnly?, secure?, sameSite? }`
  - `interface KilnCookies { set(name: string, value: string, opts?: CookieOptions): void; delete(name: string, opts?: Pick<CookieOptions, 'path' | 'domain'>): void }`
  - `function serializeCookie(name: string, value: string, opts?: CookieOptions): string`
  - `function createCookies(headers: Headers): KilnCookies`

Task 3 puts `KilnCookies` on `KilnResponse` and builds instances with `createCookies`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'bun:test';
import { createCookies, serializeCookie } from './cookies.js';

describe('serializeCookie', () => {
  it("defaults Path to / so a cookie set from a nested POST is visible app-wide", () => {
    expect(serializeCookie('sid', 'abc')).toBe('sid=abc; Path=/');
  });

  it('honours an explicit path', () => {
    expect(serializeCookie('sid', 'abc', { path: '/admin' })).toBe('sid=abc; Path=/admin');
  });

  it('url-encodes the value', () => {
    expect(serializeCookie('k', 'a b;c')).toBe('k=a%20b%3Bc; Path=/');
  });

  it('serializes every attribute in a stable order', () => {
    const out = serializeCookie('sid', 'abc', {
      path: '/',
      domain: 'example.com',
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(out).toBe(
      'sid=abc; Path=/; Domain=example.com; Max-Age=3600; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('maps sameSite values to their canonical casing', () => {
    expect(serializeCookie('a', '1', { sameSite: 'strict' })).toContain('SameSite=Strict');
    expect(serializeCookie('a', '1', { sameSite: 'none' })).toContain('SameSite=None');
  });

  it('formats expires as a UTC string', () => {
    const out = serializeCookie('a', '1', { expires: new Date(Date.UTC(2030, 0, 1)) });
    expect(out).toContain('Expires=Tue, 01 Jan 2030 00:00:00 GMT');
  });

  it('floors a fractional maxAge', () => {
    expect(serializeCookie('a', '1', { maxAge: 1.9 })).toContain('Max-Age=1');
  });

  it('omits attributes that were not supplied', () => {
    const out = serializeCookie('a', '1');
    expect(out).not.toContain('HttpOnly');
    expect(out).not.toContain('Secure');
    expect(out).not.toContain('SameSite');
    expect(out).not.toContain('Max-Age');
  });
});

describe('createCookies', () => {
  it('appends one Set-Cookie header per set() call', () => {
    const headers = new Headers();
    const cookies = createCookies(headers);

    cookies.set('a', '1', { httpOnly: true });
    cookies.set('b', '2');

    expect(headers.getSetCookie()).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/',
    ]);
  });

  it('expires the cookie on delete()', () => {
    const headers = new Headers();
    createCookies(headers).delete('sid');
    expect(headers.getSetCookie()).toEqual(['sid=; Path=/; Max-Age=0']);
  });

  it('carries path and domain through delete(), since a cookie only clears when they match', () => {
    const headers = new Headers();
    createCookies(headers).delete('sid', { path: '/admin', domain: 'example.com' });
    expect(headers.getSetCookie()).toEqual([
      'sid=; Path=/admin; Domain=example.com; Max-Age=0',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/core/src/cookies.test.ts
```

Expected: FAIL — cannot resolve `./cookies.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/cookies.ts`:

```ts
// Pure cookie serialization. No dependency on KilnResponse or any adapter, so
// this stays unit-testable on its own and safe on the client-reachable barrel.

export interface CookieOptions {
  /** Defaults to '/'. Without it the browser scopes the cookie to the request's
   * directory, so a session cookie set from POST /login would be confined to
   * /login and invisible everywhere else — a silent failure. */
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
}

export interface KilnCookies {
  set(name: string, value: string, opts?: CookieOptions): void;
  delete(name: string, opts?: Pick<CookieOptions, 'path' | 'domain'>): void;
}

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' } as const;

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${SAME_SITE[opts.sameSite]}`);
  return parts.join('; ');
}

/** Binds a KilnCookies façade to a Headers instance. Every adapter builds its
 * response cookies this way, so serialization lives in exactly one place. */
export function createCookies(headers: Headers): KilnCookies {
  return {
    set(name, value, opts) {
      headers.append('set-cookie', serializeCookie(name, value, opts));
    },
    delete(name, opts) {
      headers.append('set-cookie', serializeCookie(name, '', { ...opts, maxAge: 0 }));
    },
  };
}
```

- [ ] **Step 4: Add it to the barrel**

In `packages/core/src/index.ts`, add after the `export * from './config.js';` line:

```ts
export * from './cookies.js';
```

- [ ] **Step 5: Run to verify it passes**

```bash
bun test packages/core/src/cookies.test.ts
```

Expected: PASS, all 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cookies.ts packages/core/src/cookies.test.ts packages/core/src/index.ts
git commit -m "feat(core): add cookie serialization and the KilnCookies façade"
```

---

### Task 3: `KilnResponse.headers` becomes a `Headers`, with `res.cookies`

This task is **deliberately atomic**: the type change breaks every call site at once, so the tree does not compile until all of them are converted. Splitting it would leave a non-compiling commit. The steps below are individually small.

**Files:**
- Modify: `packages/core/src/types.ts:31-44` (the `KilnResponse` interface)
- Modify: `packages/adapter-elysia/src/context.ts:51-104` (`ElysiaResponseImpl`, `handleElysiaResponse`)
- Modify: `packages/adapter-elysia/src/adapter.ts:70,76` (the SSE header loops)
- Modify: `packages/routekit/src/boot.ts:257,285,410,411`
- Modify: `packages/routekit/src/html-markers.ts:74,86`
- Modify: `packages/routekit/src/image-handler.ts:27,28,62,63`
- Modify: `packages/routekit/src/page-render.ts:770`
- Modify: `packages/routekit/src/boot.test.ts:25-38` (`makeRes`) and its header assertions at lines 368, 423, 497, 498, 563, 620, 1792

**Interfaces:**
- Consumes: `KilnCookies`, `createCookies` from Task 2.
- Produces:
  - `KilnResponse.headers: Headers` (was `Record<string, string>`)
  - `KilnResponse.cookies: KilnCookies` — **required**, not optional like `binary?`
  - `applyHeaders(headers: Headers, ctx: any): void`, exported from `packages/adapter-elysia/src/context.ts`

- [ ] **Step 1: Change the interface**

In `packages/core/src/types.ts`, add the import at the top of the file:

```ts
import type { KilnCookies } from './cookies.js';
```

Then change the first three members of `KilnResponse`:

```ts
export interface KilnResponse {
  status: number;
  /** Web Headers, matching KilnRequest.headers. A plain record cannot carry
   * multiple Set-Cookie values, which is what actions setting cookies need. */
  headers: Headers;
  /** Cookie helper bound to `headers`. Required of every adapter, so app code
   * can call it unconditionally. */
  cookies: KilnCookies;
  body?: string | unknown | AsyncIterable<SSEEvent>;
  // ...rest unchanged
```

- [ ] **Step 2: Update `ElysiaResponseImpl`**

In `packages/adapter-elysia/src/context.ts`, change the import on line 1 and the two field declarations. `headers` must be declared **before** `cookies`, since `createCookies` binds to it at construction:

```ts
import { createCookies, type KilnCookies, type KilnRequest, type KilnResponse, type SSEEvent } from '@kiln/core';
```

```ts
export class ElysiaResponseImpl implements KilnResponse {
  public status = 200;
  public headers = new Headers();
  public cookies: KilnCookies = createCookies(this.headers);
  public body?: any;
```

Leave `html()`, `json()`, `redirect()`, `sse()` and `binary()` exactly as they are — they write content-type onto `ctx.set.headers`, which remains a record and still works.

**Note:** every existing `@kiln/core` import in `packages/adapter-elysia` is `import type`, erased at compile time. `createCookies` is the adapter's first *runtime* import from core. The dependency already exists (`"@kiln/core": "workspace:*"`), but from here on a stale or missing `packages/core/dist` breaks the adapter at runtime, not merely at typecheck — which is why Step 9 runs `bun run build`, not just `tsc`.

- [ ] **Step 3: Replace the header-emit logic**

Still in `packages/adapter-elysia/src/context.ts`, replace `handleElysiaResponse` with:

```ts
/** Copies a Headers onto Elysia's plain-record `ctx.set.headers`. Single-valued
 * names go across directly; set-cookie goes as a string[], which Elysia expands
 * into one header per entry (proved by multi-cookie.test.ts).
 *
 * ctx.set.headers stays a record on purpose: assigning a Headers instance to it
 * would make the record-style writes elsewhere in this file and in
 * middleware/compression.ts set plain JS properties instead of headers, and be
 * dropped with no type error and no runtime error. See spec §2.3. */
export function applyHeaders(headers: Headers, ctx: any): void {
  for (const [key, value] of headers) {
    if (key === 'set-cookie') continue;
    ctx.set.headers[key] = value;
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    ctx.set.headers['set-cookie'] = cookies;
  }
}

export function handleElysiaResponse(res: ElysiaResponseImpl, ctx: any) {
  if (res.status) {
    ctx.set.status = res.status;
  }
  applyHeaders(res.headers, ctx);

  if (res.bodyType === 'redirect') {
    return;
  }

  return res.body;
}
```

- [ ] **Step 4: Update the SSE path**

In `packages/adapter-elysia/src/adapter.ts`, import `applyHeaders` alongside the existing imports from `./context.js`, then replace both loops.

Line 70 (`for (const [k, v] of Object.entries(res.headers)) ctx.set.headers[k] = v;`) becomes:

```ts
        applyHeaders(res.headers, ctx);
```

Line 76 (the identical loop after the handler runs) becomes:

```ts
      applyHeaders(res.headers, ctx);
```

- [ ] **Step 5: Convert the routekit write sites**

Nine mechanical edits, `res.headers['x'] = y` → `res.headers.set('x', y)`:

- `packages/routekit/src/boot.ts:257` → `res.headers.set('cache-control', 'no-store');`
- `packages/routekit/src/boot.ts:285` → `res.headers.set('content-type', 'application/javascript; charset=utf-8');`
- `packages/routekit/src/boot.ts:410` → `res.headers.set('content-type', 'application/javascript; charset=utf-8');`
- `packages/routekit/src/boot.ts:411` → `res.headers.set('cache-control', 'no-cache');`
- `packages/routekit/src/html-markers.ts:74` → `res.headers.set('silcrow-full-reload', 'true');`
- `packages/routekit/src/html-markers.ts:86` → `res.headers.set('content-type', 'text/html; x-ps-fragment=1');`
- `packages/routekit/src/image-handler.ts:27,28` → `res.headers.set('content-type', mimeType);` and `res.headers.set('cache-control', 'public, max-age=31536000, immutable');`
- `packages/routekit/src/image-handler.ts:62,63` → the same two lines
- `packages/routekit/src/page-render.ts:770` → `res.headers.set('x-kiln-layout-cache-hit', cacheHitPatterns.join(','));`

- [ ] **Step 6: Update the test double**

In `packages/routekit/src/boot.test.ts`, change `makeRes` (lines 25-38) so it matches the real interface — a fake that lies about the shape hides breakage:

```ts
function makeRes(): any {
  const headers = new Headers();
  const res: any = { status: 200, headers, cookies: createCookies(headers), captured: null };
  res.html = (b: string) => {
    res.captured = { type: 'html', body: b };
  };
  res.json = (b: unknown) => {
    res.captured = { type: 'json', body: b };
  };
  res.redirect = (url: string) => {
    res.captured = { type: 'redirect', url };
  };
  res.sse = () => {};
  return res;
}
```

Add `createCookies` to the existing `@kiln/core` import at the top of the file (add the import if there is none).

- [ ] **Step 7: Update the test assertions**

`Headers.get()` returns `null` for a missing header, not `undefined` — so the two `toBeUndefined()` assertions must become `toBeNull()`, or they will pass for the wrong reason.

- line 368: `expect(res.headers.get('content-type')).toContain('x-ps-fragment=1');`
- line 423: `expect(rootOnlyRes.headers.get('content-type')).toContain('x-ps-fragment=1');`
- line 497: `expect(resB.headers.get('x-kiln-layout-cache-hit')).toBe('/section');`
- line 498: `expect(resA.headers.get('x-kiln-layout-cache-hit')).toBeNull();`
- line 563: `expect(alphaBoard.headers.get('x-kiln-layout-cache-hit')).toBe('/projects/:id');`
- line 620: `expect(two.headers.get('x-kiln-layout-cache-hit')).toBeNull();`
- line 1792: `expect(res.headers.get('cache-control')).toBe('no-store');`

- [ ] **Step 8: Add an adapter test for the real path**

Append to `packages/adapter-elysia/src/multi-cookie.test.ts`:

```ts
import { ElysiaAdapter } from './adapter.js';

describe('ElysiaAdapter response cookies', () => {
  it('emits every cookie an action set, through the real adapter path', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerPage('/set', [], async (_req, res) => {
      res.cookies.set('sid', 'abc', { httpOnly: true, path: '/' });
      res.cookies.set('theme', 'dark');
      res.headers.set('x-custom', 'yes');
      res.json({ ok: true });
    });

    const res = await adapter.app.handle(new Request('http://localhost/set'));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies).toContain('sid=abc; Path=/; HttpOnly');
    expect(cookies).toContain('theme=dark; Path=/');
    expect(res.headers.get('x-custom')).toBe('yes');
  });

  it('keeps cookies on a redirect response', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerPage('/bye', [], async (_req, res) => {
      res.cookies.delete('sid');
      res.redirect('/login');
    });

    const res = await adapter.app.handle(
      new Request('http://localhost/bye', { redirect: 'manual' }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.getSetCookie()).toEqual(['sid=; Path=/; Max-Age=0']);
  });
});
```

- [ ] **Step 9: Typecheck, test, build**

```bash
bun run test:unit
```

Expected: PASS, no failures. Then:

```bash
bun run build
```

Expected: exit 0 across all packages.

If `tsc` reports remaining `res.headers[...]` index errors, they are write sites this plan missed — convert them the same way and note them in the commit body.

- [ ] **Step 10: Commit**

```bash
git add -A packages/core packages/adapter-elysia packages/routekit
git commit -m "feat(core)!: KilnResponse.headers is a Headers, with res.cookies

A Record<string, string> cannot carry multiple Set-Cookie values. Headers
also matches KilnRequest.headers, which was already a Headers.

The Elysia adapter translates back to its record on the way out, passing
set-cookie as a string[]; ctx.set.headers stays a record so record-style
writes in context.ts and compression.ts keep working."
```

---

### Task 4: Actions receive `res`

**Files:**
- Modify: `packages/core/src/types.ts` (add `KilnAction`)
- Modify: `packages/routekit/src/boot.ts:59-101` (`buildActionHandler`)
- Modify: `packages/routekit/src/boot.test.ts` (append tests)

**Interfaces:**
- Consumes: `KilnResponse` with `headers`/`cookies` from Task 3.
- Produces:
  - `type KilnAction = (req: KilnRequest, res: KilnResponse) => unknown | Promise<unknown>`, exported from `@kiln/core`.
  - `buildActionHandler(actions: Record<string, KilnAction>, opts?)` — the parameter type narrows from `Record<string, any>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/routekit/src/boot.test.ts`, inside the existing top-level `describe` block that already covers `buildActionHandler` (the one containing the read-your-own-writes test at line 262):

```ts
  it('passes res to the action, so it can set cookies', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      signin: async (_req: any, res: any) => {
        res.cookies.set('sid', 'abc', { httpOnly: true });
        return { ok: true };
      },
    });

    const res = makeRes();
    await handler(makeReq({ path: '/login', method: 'POST', query: { '/signin': '' } as any }) as any, res);

    expect(res.headers.getSetCookie()).toEqual(['sid=abc; Path=/; HttpOnly']);
    expect(res.captured).toEqual({ type: 'json', body: { ok: true } });
  });

  it('preserves a status the action set, so 409 is reachable', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      claim: async (_req: any, res: any) => {
        res.status = 409;
        return { error: 'already claimed' };
      },
    });

    const res = makeRes();
    await handler(makeReq({ path: '/t', method: 'POST', query: { '/claim': '' } as any }) as any, res);

    expect(res.status).toBe(409);
    expect(res.captured).toEqual({ type: 'json', body: { error: 'already claimed' } });
  });

  it('keeps cookies staged before an AppError.redirect', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const { AppError } = await import('@kiln/core');
    const handler = buildActionHandler({
      signout: async (_req: any, res: any) => {
        res.cookies.delete('sid');
        throw AppError.redirect('/login');
      },
    });

    const res = makeRes();
    await handler(makeReq({ path: '/login', method: 'POST', query: { '/signout': '' } as any }) as any, res);

    expect(res.captured).toEqual({ type: 'redirect', url: '/login' });
    expect(res.headers.getSetCookie()).toEqual(['sid=; Path=/; Max-Age=0']);
  });

  it('does not overwrite a body the action committed itself', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      csv: async (_req: any, res: any) => {
        res.headers.set('content-type', 'text/csv');
        res.html('a,b\n1,2');
      },
    });

    const res = makeRes();
    await handler(makeReq({ path: '/t', method: 'POST', query: { '/csv': '' } as any }) as any, res);

    expect(res.captured).toEqual({ type: 'html', body: 'a,b\n1,2' });
  });

  it('warns when an action both commits a body and returns a value', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const handler = buildActionHandler({
        both: async (_req: any, res: any) => {
          res.html('committed');
          return { ignored: true };
        },
      });
      const res = makeRes();
      await handler(
        makeReq({ path: '/warn-both', method: 'POST', query: { '/both': '' } as any }) as any,
        res,
      );
      expect(res.captured).toEqual({ type: 'html', body: 'committed' });
    } finally {
      console.warn = original;
    }

    expect(warnings.some((w) => w.includes('both wrote to res and returned a value'))).toBe(true);
  });

  it('still supports a one-argument action', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      legacy: async (_req: any) => ({ greeting: 'hi' }),
    });

    const res = makeRes();
    await handler(makeReq({ path: '/t', method: 'POST', query: { '/legacy': '' } as any }) as any, res);

    expect(res.captured).toEqual({ type: 'json', body: { greeting: 'hi' } });
  });
```

Note: `makeRes` does not set `bodyType`, but the precedence rule reads it. Extend the test double in the same edit so `html`, `json` and `redirect` set it, mirroring the real implementation:

```ts
  res.html = (b: string) => {
    res.bodyType = 'html';
    res.captured = { type: 'html', body: b };
  };
  res.json = (b: unknown) => {
    res.bodyType = 'json';
    res.captured = { type: 'json', body: b };
  };
  res.redirect = (url: string) => {
    res.bodyType = 'redirect';
    res.captured = { type: 'redirect', url };
  };
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/routekit/src/boot.test.ts
```

Expected: the cookie, status, redirect-cookie, committed-body and warning tests FAIL (the action never receives a second argument, so `res.cookies` is `undefined`). The one-argument test passes already.

- [ ] **Step 3: Add the `KilnAction` type**

In `packages/core/src/types.ts`, after the `KilnHandle` definition (around line 61):

```ts
/**
 * A page action: the named handlers a page exports as `actions`. Receives the
 * same (req, res) pair as every other Kiln handler, so an action can set
 * cookies, headers and a custom status.
 *
 * Return a value and Kiln sends it as JSON. Alternatively commit a response
 * yourself (res.html/json/redirect/binary) and Kiln sends that instead —
 * the same rule KilnHandle uses. Doing both warns; the return value loses.
 */
export type KilnAction = (
  req: KilnRequest,
  res: KilnResponse,
) => unknown | Promise<unknown>;
```

- [ ] **Step 4: Pass `res` through and apply the precedence rules**

In `packages/routekit/src/boot.ts`, add to the imports near the top:

```ts
import { warnOnce } from './dedup.js';
```

Apply the new type to the handler's parameter so `KilnAction` is actually load-bearing rather than a type nobody references. Add `KilnAction` to the existing `import type { ... } from '@kiln/core'` block (lines 12-18), then change the signature on line 60:

```ts
export function buildActionHandler(
  actions: Record<string, KilnAction>,
  opts?: { cache?: KilnCache; identity?: KilnIdentity; bake?: BakeMode }
) {
```

Then replace the `try` block of the returned handler (lines 87-90) with:

```ts
    try {
      const result = await actions[actionName](req, res);
      await invalidateActor(req);
      // Same rule as the `handle` hook (KilnHandle): if the action committed a
      // response itself, send that. Warn rather than silently discarding a
      // returned value — an invisible asymmetry is how the Live.list auto-deps
      // gap became a bug rather than a documented limitation.
      if (res.bodyType) {
        if (result !== undefined) {
          warnOnce(
            `action-body-conflict:${req.path}:${actionName}`,
            `[kiln] action "${actionName}" on ${req.path} both wrote to res and returned a value; the return value was ignored.`,
          );
        }
        return;
      }
      res.json(result || { success: true });
    } catch (err: any) {
```

Leave the `catch` block untouched: cookies live in `res.headers`, independent of the body, so they survive `res.redirect` and the error path with no extra work.

- [ ] **Step 5: Run to verify they pass**

```bash
bun test packages/routekit/src/boot.test.ts
```

Expected: PASS, including the pre-existing tests.

- [ ] **Step 6: Full suite and build**

```bash
bun run test:unit && bun run build
```

Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/routekit/src/boot.ts packages/routekit/src/boot.test.ts
git commit -m "feat(routekit): pass res to page actions

Actions were invoked as actions[name](req), so they could set no cookies,
headers or status. The res was already in scope one level up.

Precedence follows the existing KilnHandle rule: a committed body wins over
the return value, and doing both warns instead of silently discarding."
```

---

### Task 5: `AppError.conflict`

Throwing is how code deep in a call stack signals an outcome, where `res` is out of reach — a db helper detecting a duplicate cannot set `res.status`. 409 is the case observed as unreachable in Plan 3b.

**Files:**
- Modify: `packages/core/src/errors.ts:1-33`
- Create: `packages/core/src/errors.test.ts` (if it does not exist; otherwise append)

**Interfaces:**
- Consumes: nothing.
- Produces: `AppError.conflict(message?: string): AppError` with `type: 'Conflict'`, `status: 409`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { AppError } from './errors.js';

describe('AppError.conflict', () => {
  it('carries a 409 and the Conflict type', () => {
    const err = AppError.conflict('already claimed');
    expect(err.status).toBe(409);
    expect(err.type).toBe('Conflict');
    expect(err.message).toBe('already claimed');
    expect(err).toBeInstanceOf(AppError);
  });

  it('has a default message', () => {
    expect(AppError.conflict().message).toBe('Conflict');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/core/src/errors.test.ts
```

Expected: FAIL — `AppError.conflict is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/errors.ts`, add `'Conflict'` to the union in the constructor:

```ts
    public readonly type: 'NotFound' | 'Unauthorized' | 'Forbidden' | 'Validation' | 'Conflict' | 'Internal' | 'Redirect',
```

and add the factory after `validation`:

```ts
  static conflict(message = 'Conflict'): AppError {
    return new AppError('Conflict', message, 409);
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/core/src/errors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/errors.test.ts
git commit -m "feat(core): add AppError.conflict for 409"
```

---

### Task 6: Move jags-list auth onto actions (the falsification)

This is what proves the feature. If cookies do not survive the action path, this task fails loudly.

**Files:**
- Modify: `apps/jags-list/src/main.ts:21-56` (delete the two raw routes)
- Modify: `apps/jags-list/pages/login.tsx` (add `actions`, retarget the form)
- Modify: `apps/jags-list/pages/_layout.tsx:24` (retarget the logout form)
- Modify: `apps/jags-list/hooks.ts:12-23` (update `PUBLIC_PREFIXES` and its comment)
- Modify: `apps/jags-list/tests/app.integration.test.ts:68,89,100` (new URLs, same assertions)

**Interfaces:**
- Consumes: `res.cookies` (Task 3), actions receiving `res` (Task 4).
- Produces: no framework exports. Login moves to `POST /login?/signin`, logout to `POST /login?/signout`.

**Why logout lives on the login page:** actions are registered against a *page* pattern, and the logout form sits in `_layout.tsx`, which renders on every page and has no actions of its own. Pointing it at an absolute `/login?/signout` works from any page, and `/login` is already public so the action is reachable while signed in or out.

- [ ] **Step 1: Add the actions to the login page**

In `apps/jags-list/pages/login.tsx`, add to the imports:

```tsx
import { AppError, type KilnRequest, type KilnResponse } from '@kiln/core';
import { auth } from '../lib/auth.js';
```

and add after `load`:

```tsx
// Login and logout are ordinary Kiln actions: they set cookies through
// res.cookies, so they no longer need raw adapter routes in src/main.ts.
export const actions = {
  async signin(req: KilnRequest, res: KilnResponse) {
    const form = await req.formData();
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    let upstream: Response;
    try {
      upstream = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    } catch {
      throw AppError.redirect('/login?error=1');
    }
    if (!upstream.ok) throw AppError.redirect('/login?error=1');

    // better-auth returns fully-formed Set-Cookie strings; pass them through
    // verbatim rather than re-serializing and risking an attribute mismatch.
    for (const cookie of upstream.headers.getSetCookie()) {
      res.headers.append('set-cookie', cookie);
    }
    throw AppError.redirect('/');
  },

  async signout(req: KilnRequest, res: KilnResponse) {
    try {
      const upstream = await auth.api.signOut({ headers: req.headers, asResponse: true });
      for (const cookie of upstream.headers.getSetCookie()) {
        res.headers.append('set-cookie', cookie);
      }
    } catch {
      // no/invalid session — still land on /login
    }
    throw AppError.redirect('/login');
  },
};
```

- [ ] **Step 2: Retarget the forms**

In `apps/jags-list/pages/login.tsx`, change line 19:

```tsx
      <form method="post" action="/login?/signin">
```

In `apps/jags-list/pages/_layout.tsx`, change line 24:

```tsx
          <form method="post" action="/login?/signout" className="logout-form">
```

- [ ] **Step 3: Delete the raw routes**

In `apps/jags-list/src/main.ts`, delete lines 21-56 — the comment block and both `adapter.app.post('/auth/login', ...)` and `adapter.app.post('/auth/logout', ...)` handlers. Keep the `/api/auth/*` better-auth handler on line 19; it is unrelated.

- [ ] **Step 4: Update the gating list**

In `apps/jags-list/hooks.ts`, remove `'/auth/login'` and `'/auth/logout'` from `PUBLIC_PREFIXES` (they no longer exist as routes), keep `'/login'` — it now covers the actions too — and replace the stale NOTE comment:

```ts
// NOTE: the better-auth handler (/api/auth/*) is a raw Elysia route registered
// in src/main.ts, NOT a Kiln route, so `handle` never runs for it — it's public
// by construction. Login/logout are Kiln actions on the /login page, so they
// ARE gated by `handle` and depend on '/login' staying in this list.
```

- [ ] **Step 5: Update the integration test URLs**

In `apps/jags-list/tests/app.integration.test.ts`, change the three fetch URLs — line 68 `/auth/login` → `/login?/signin`, line 89 `/auth/logout` → `/login?/signout`, line 100 `/auth/login` → `/login?/signin`. **Change nothing else.** The assertions around them (status, `Set-Cookie` present, session works afterwards, bad credentials land on `/login?error=1`) are the falsification and must stay byte-identical.

- [ ] **Step 6: Run the falsifying suite**

```bash
cd apps/jags-list && RUN_APP_TESTS=1 bun test tests/app.integration.test.ts
```

Expected: PASS. Needs live PostgreSQL and Redis.

If login now 403s, check CSRF: `applyMiddleware` gates POSTs by origin, and the raw routes bypassed it while Kiln actions do not. Report it rather than disabling CSRF — that is a genuine finding about the action path, and exactly what this task exists to surface.

- [ ] **Step 7: Run the regression guards**

```bash
cd apps/jags-list && RUN_APP_TESTS=1 bun test tests/
```

Expected: PASS. These suites (`gate`, `crud`, `purity`, `live`) sign in via `auth.api.signInEmail` directly, so they do **not** exercise the new login route — they only confirm the rest of the app is unaffected. Do not report them as evidence the action-based login works.

- [ ] **Step 8: Full framework verification**

```bash
bun run test:unit && bun run test:integration && bun run build
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add -A apps/jags-list
git commit -m "refactor(jags-list): move login/logout from raw routes onto Kiln actions

Proves actions can set cookies. Deletes the raw Elysia routes whose only
reason to exist was that actions could not reach the response.

app.integration.test.ts keeps its assertions and only changes URLs — it is
the falsifying evidence for the whole feature."
```

---

### Task 7: Documentation, ADR, and memory

**Files:**
- Modify: `.codebase-memory/adr.md` (append a new ADR)
- Modify: `docs/agents/auth.md`
- Modify: `.memory/bugs-active.md` (§1)
- Modify: `.memory/active-work.md` (§ Next Priorities, § Current State)

- [ ] **Step 1: Write the ADR**

Append to `.codebase-memory/adr.md`, following the numbering and format of the existing entries (the next free number after ADR-018). Cover: actions receive `(req, res)`; the precedence rule shared with `KilnHandle`; `KilnResponse.headers` becoming a `Headers` and why a record could not work; why the Elysia adapter keeps `ctx.set.headers` a record and passes `set-cookie` as an array; and the cookie `path` default of `/`.

- [ ] **Step 2: Update the auth guide**

In `docs/agents/auth.md`, replace the raw-route login/logout recipe with the action-based one from Task 6. Anything telling app authors that actions cannot set cookies, or that auth requires owning the server entry, is now wrong and must go.

- [ ] **Step 3: Update the bug list**

In `.memory/bugs-active.md` §1, remove the "Actions cannot touch the response" entry and move it to `.memory/bugs-resolved.md` with the date and the commit range.

Also correct the neighbouring "An app that owns its entry point cannot use islands" entry: it claims an app needing cookies must own its entry, which is no longer true. Whether jags-list still needs a custom entry at all is now an open question for the next session — say so plainly rather than assuming either answer.

- [ ] **Step 4: Update active work**

In `.memory/active-work.md`, move P0 #2 to done, note the new `main` state, and rewrite the "Recommended starting point" — it currently says #1 and #2 collapse together. Record what Task 6 actually showed about how much of #1 survives.

- [ ] **Step 5: Commit**

```bash
git add -A .codebase-memory docs .memory
git commit -m "docs: record the action/response contract (ADR) and update memory"
```

---

## Finishing

Use `superpowers:finishing-a-development-branch` → "Push and create PR". Do not push to `main`.

The PR description should lead with the falsification: the raw auth routes in `apps/jags-list/src/main.ts` are gone, and `app.integration.test.ts` passes with its assertions unchanged.

## Open question this work answers

`.memory/active-work.md` recommends collapsing P0 #1 into #2 on the theory that cookie-capable actions remove the need for a custom entry point. Task 6 tests that theory. Record the answer in Task 7 — the follow-up scope for #1 depends on it.
