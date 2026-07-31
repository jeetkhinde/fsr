# SSE User Scoping on Dynamic Routes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a subscribed concrete path to its registered route pattern so `bake='user'` pages on dynamic routes get a per-user SSE key instead of the shared one.

**Architecture:** A pure path→pattern matcher, plus one `resolveRouteUserKey` helper shared by the SSE and snapshot endpoints (currently duplicated logic). `identity(req)` stays the only source of the user key.

**Tech Stack:** TypeScript, Bun (`bun:test`).

**Spec:** `docs/superpowers/specs/2026-07-31-sse-user-scoping-design.md`

**Branch/worktree:** `fix/sse-user-scoping` at `.worktrees/fix-sse-user-scoping/`, from `main` @ `f5fa13a`.

## Global Constraints

- Work inside the worktree — `cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/fix-sse-user-scoping` at the start of every task; the shell resets between turns.
- First run needs `bun install`, `cp ../../test-app/.env test-app/.env`, then `bun run build` — `node_modules`, `dist/` and `.env` are all gitignored.
- Rebuild `@kiln/core` before running `routekit` tests if core changed; routekit consumes core through `dist/`.
- `bun run build` before any completion claim, alongside `bun run test:unit`.
- Never commit to `main`.
- **No `apps/jags-list` changes.** It cannot express this combination and must not be extended to host a framework test.

## Findings that shaped this plan

1. **Severity was mis-stated in earlier docs.** This is *not* cross-user exposure. `page-render.ts:211` sets `userKey = uid ?? ''` regardless of dynamic segments, so an authenticated render never populates the shared row, and `hub.ts:308` filters patches by exact `userKey`. Subscribers therefore receive **nothing**; the initial snapshot reads the shared row (absent, or the anonymous view). Already corrected in the sequencing doc, PR #33 and memory.
2. **Deviation from the spec's signature, deliberate.** The spec proposed module-level `compilePatterns` + `matchPattern`. A module-level memo would be shared across every `startKiln` instance in a process (and across tests), so this plan uses `createPatternMatcher(patterns)` returning an object that owns its own compiled list *and* memo. Same behaviour, no cross-instance leakage, smaller public surface.

---

### Task 1: The path → pattern matcher

**Files:**
- Create: `packages/routekit/src/match-pattern.ts`
- Create: `packages/routekit/src/match-pattern.test.ts`

**Interfaces:**
- Consumes: `DEDUP_SET_MAX` from `./dedup.js`.
- Produces: `interface PatternMatcher { match(path: string): string | null }` and `createPatternMatcher(patterns: string[]): PatternMatcher`.

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/fix-sse-user-scoping
bun install && cp ../../test-app/.env test-app/.env && bun run build
```

Expected: build exits 0.

- [ ] **Step 2: Write the failing tests**

Create `packages/routekit/src/match-pattern.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createPatternMatcher } from './match-pattern.js';

const PATTERNS = [
  '/',
  '/projects',
  '/projects/new',
  '/projects/:id',
  '/projects/:id/activity',
  '/docs/*',
];

describe('createPatternMatcher', () => {
  const m = createPatternMatcher(PATTERNS);

  it('matches a static path exactly', () => {
    expect(m.match('/projects')).toBe('/projects');
  });

  it('matches the root', () => {
    expect(m.match('/')).toBe('/');
  });

  it('matches a single dynamic segment', () => {
    expect(m.match('/projects/42')).toBe('/projects/:id');
  });

  it('matches a dynamic segment followed by a literal', () => {
    expect(m.match('/projects/42/activity')).toBe('/projects/:id/activity');
  });

  it('prefers a literal segment over a dynamic one', () => {
    // /projects/new must not resolve to /projects/:id, or bake mode is read
    // from the wrong page.
    expect(m.match('/projects/new')).toBe('/projects/new');
  });

  it('matches a wildcard across slashes', () => {
    expect(m.match('/docs/guides/live')).toBe('/docs/*');
  });

  it('prefers a more specific pattern over a wildcard', () => {
    const wide = createPatternMatcher(['/docs/*', '/docs/intro']);
    expect(wide.match('/docs/intro')).toBe('/docs/intro');
  });

  it('normalizes a trailing slash', () => {
    expect(m.match('/projects/')).toBe('/projects');
    expect(m.match('/projects/42/')).toBe('/projects/:id');
  });

  it('returns null when nothing matches', () => {
    expect(m.match('/nope/at/all')).toBeNull();
  });

  it('does not let a dynamic segment span slashes', () => {
    expect(m.match('/projects/42/extra')).toBeNull();
  });

  it('treats regex metacharacters in a literal segment literally', () => {
    const dotted = createPatternMatcher(['/a.b']);
    expect(dotted.match('/a.b')).toBe('/a.b');
    expect(dotted.match('/axb')).toBeNull();
  });

  it('returns the same answer on a repeat lookup (memo consistency)', () => {
    expect(m.match('/projects/7')).toBe('/projects/:id');
    expect(m.match('/projects/7')).toBe('/projects/:id');
    expect(m.match('/zzz')).toBeNull();
    expect(m.match('/zzz')).toBeNull();
  });

  it('keeps separate matchers independent', () => {
    const a = createPatternMatcher(['/x']);
    const b = createPatternMatcher(['/y']);
    expect(a.match('/x')).toBe('/x');
    expect(a.match('/y')).toBeNull();
    expect(b.match('/y')).toBe('/y');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
bun test packages/routekit/src/match-pattern.test.ts
```

Expected: FAIL — cannot resolve `./match-pattern.js`.

- [ ] **Step 4: Implement**

Create `packages/routekit/src/match-pattern.ts`:

```ts
// Concrete request path -> registered route pattern. Needed because
// bakeByPattern is keyed by pattern ('/projects/:id') while the live client
// subscribes with window.location.pathname ('/projects/42').
import { DEDUP_SET_MAX } from './dedup.js';

export interface PatternMatcher {
  /** The matching pattern, or null when none matches. */
  match(path: string): string | null;
}

function normalize(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  if (!withoutQuery) return '/';
  const trimmed =
    withoutQuery.length > 1 && withoutQuery.endsWith('/')
      ? withoutQuery.slice(0, -1)
      : withoutQuery;
  return trimmed || '/';
}

function segmentsOf(pattern: string): string[] {
  return normalize(pattern).split('/').filter(Boolean);
}

/** literal < :param < * — lower sorts (and matches) first. */
function rank(segment: string): number {
  if (segment === '*') return 2;
  if (segment.startsWith(':')) return 1;
  return 0;
}

function toRegex(segments: string[]): RegExp {
  const body = segments.map((segment) => {
    if (segment === '*') return '.*';
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^/${body.join('/')}$`);
}

export function createPatternMatcher(patterns: string[]): PatternMatcher {
  // Sorted most-specific first, so the first regex hit is the right answer —
  // this ordering IS the precedence rule, and it must agree with what the
  // adapter would serve or bake mode gets read from a different page.
  const compiled = patterns
    .map((pattern) => ({ pattern, segments: segmentsOf(pattern) }))
    .sort((a, b) => {
      const shared = Math.min(a.segments.length, b.segments.length);
      for (let i = 0; i < shared; i++) {
        const delta = rank(a.segments[i]!) - rank(b.segments[i]!);
        if (delta !== 0) return delta;
      }
      // A wildcard pattern is necessarily shorter; longer must win.
      if (a.segments.length !== b.segments.length) {
        return b.segments.length - a.segments.length;
      }
      // Deterministic across runs rather than dependent on discovery order.
      return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
    })
    .map(({ pattern, segments }) => ({ pattern, regex: toRegex(segments) }));

  // `route` arrives as a query parameter, so an unbounded memo would grow
  // without limit from arbitrary subscribe paths. dedup.ts's addBounded takes
  // a Set, so cap this Map directly against the same bound — the convention
  // its own comment records for `lastTouched`.
  const memo = new Map<string, string | null>();

  return {
    match(path: string): string | null {
      const key = normalize(path);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;

      let found: string | null = null;
      for (const candidate of compiled) {
        if (candidate.regex.test(key)) {
          found = candidate.pattern;
          break;
        }
      }

      if (memo.size >= DEDUP_SET_MAX) memo.clear();
      memo.set(key, found);
      return found;
    },
  };
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
bun test packages/routekit/src/match-pattern.test.ts
```

Expected: PASS, all 13 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/routekit/src/match-pattern.ts packages/routekit/src/match-pattern.test.ts
git commit -m "feat(routekit): add a concrete-path to route-pattern matcher"
```

---

### Task 2: Resolve the user key from the matched pattern

**Files:**
- Modify: `packages/routekit/src/boot.ts` (new export; SSE site ~301-302; snapshot site ~366-367; matcher construction after `bakeByPattern` is built ~186)
- Modify: `packages/routekit/src/page-render.ts` (delete the warning at 661-668)
- Create: `packages/routekit/src/route-user-key.test.ts`

**Interfaces:**
- Consumes: `createPatternMatcher`, `PatternMatcher` (Task 1).
- Produces:
  ```ts
  export function resolveRouteUserKey(input: {
    route: string;
    matcher: PatternMatcher;
    bakeByPattern: Map<string, BakeMode | undefined>;
    identity?: KilnIdentity;
    req: KilnRequest;
  }): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/routekit/src/route-user-key.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createPatternMatcher } from './match-pattern.js';
import { resolveRouteUserKey } from './boot.js';

const bakeByPattern = new Map<string, any>([
  ['/projects/:id/activity', 'user'],
  ['/projects/:id/board', 'shared'],
  ['/settings', 'user'],
]);
const matcher = createPatternMatcher([...bakeByPattern.keys()]);
const req = { locals: { user: { id: 'u1' } } } as any;
const identity = (r: any) => (r.locals.user as { id: string } | undefined)?.id ?? null;

function resolve(route: string, opts: { identity?: any; req?: any } = {}) {
  return resolveRouteUserKey({
    route,
    matcher,
    bakeByPattern,
    identity: 'identity' in opts ? opts.identity : identity,
    req: opts.req ?? req,
  });
}

describe('resolveRouteUserKey', () => {
  // THE falsifier: on main's logic this returns '' because
  // bakeByPattern.get('/projects/42/activity') misses.
  it("returns the subscriber's uid for a dynamic bake='user' route", () => {
    expect(resolve('/projects/42/activity')).toBe('u1');
  });

  it("returns the uid for a static bake='user' route", () => {
    expect(resolve('/settings')).toBe('u1');
  });

  it("returns '' for a shared route even with an identity hook configured", () => {
    // Protects the guarantee at boot.ts:297-300 — a shared route must read the
    // shared row, or its patches never reach this subscriber.
    expect(resolve('/projects/42/board')).toBe('');
  });

  it("returns '' when no identity hook is configured", () => {
    expect(resolve('/projects/42/activity', { identity: undefined })).toBe('');
  });

  it("returns '' for an anonymous request", () => {
    expect(resolve('/projects/42/activity', { req: { locals: {} } })).toBe('');
  });

  it("returns '' and warns once for an unmatched route", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      expect(resolve('/no/such/route')).toBe('');
      expect(resolve('/no/such/route')).toBe('');
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((w) => w.includes('matches no registered route pattern'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/routekit/src/route-user-key.test.ts
```

Expected: FAIL — `resolveRouteUserKey` is not exported from `./boot.js`.

- [ ] **Step 3: Implement the helper**

In `packages/routekit/src/boot.ts`, add the import:

```ts
import { createPatternMatcher, type PatternMatcher } from './match-pattern.js';
```

`warnOnce` is already imported by `boot.ts` on this branch — if not, add `import { warnOnce } from './dedup.js';`.

Add the helper next to the other exported helpers, above `startKiln`:

```ts
/** The SSE user key for a subscribed concrete path.
 *
 * bakeByPattern is keyed by PATTERN, but the live client subscribes with
 * window.location.pathname, so the path must be matched to a pattern first —
 * without that, every dynamic route missed the lookup and fell back to the
 * shared key, and subscribers silently received nothing.
 *
 * identity(req) is the ONLY source of the user key. The matched pattern
 * selects a bake mode and nothing else, so no client-supplied value can
 * influence whose data is read. */
export function resolveRouteUserKey(input: {
  route: string;
  matcher: PatternMatcher;
  bakeByPattern: Map<string, BakeMode | undefined>;
  identity?: KilnIdentity;
  req: KilnRequest;
}): string {
  const pattern = input.matcher.match(input.route);
  if (pattern === null) {
    warnOnce(
      `sse-unmatched-route:${input.route}`,
      `[kiln] live subscription for "${input.route}" matches no registered route pattern; ` +
        `treating it as a shared route. If this is a bake='user' page, its live updates will ` +
        `not be scoped to the subscriber.`,
    );
    return '';
  }
  const bake = input.bakeByPattern.get(pattern);
  return bake === 'user' && input.identity ? input.identity(input.req) ?? '' : '';
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/routekit/src/route-user-key.test.ts
```

Expected: PASS, all 6 tests.

- [ ] **Step 5: Confirm the falsifier had teeth**

The first test must fail against the old logic, or it is not testing anything. Temporarily replace the body of `resolveRouteUserKey` with the pre-fix expression:

```ts
  const bake = input.bakeByPattern.get(input.route);   // OLD: raw path lookup
  return bake === 'user' && input.identity ? input.identity(input.req) ?? '' : '';
```

Run the suite. Expected: the dynamic-route test **FAILS** (`'' !== 'u1'`) while the static and shared tests still pass. Then restore the real body.

If it passes with the old expression, stop and report — the test is not exercising the defect.

- [ ] **Step 6: Wire both call sites**

In `packages/routekit/src/boot.ts`, immediately after the loop that fills `bakeByPattern` (around line 186), build the matcher once:

```ts
  // Built once from the registered patterns; the live client subscribes with a
  // concrete path, which must be matched back to its pattern before bake mode
  // can be read.
  const routeMatcher = createPatternMatcher([...bakeByPattern.keys()]);
```

Replace the SSE pair (~301-302):

```ts
      const sseUserKey = resolveRouteUserKey({
        route,
        matcher: routeMatcher,
        bakeByPattern,
        identity,
        req,
      });
```

Replace the snapshot pair (~366-367):

```ts
      const snapshotUserKey = resolveRouteUserKey({
        route,
        matcher: routeMatcher,
        bakeByPattern,
        identity,
        req,
      });
```

Delete the now-stale `const routeBake = ...` line at each site. Keep the surrounding comments — the shared-route rationale they explain is still exactly why `resolveRouteUserKey` gates on `bake === 'user'`.

- [ ] **Step 7: Delete the warning that is no longer true**

In `packages/routekit/src/page-render.ts`, delete the whole `if (bakeMode === 'user' && watcher && pageMeta.pattern.includes(':') && pageLiveFields.length > 0) { warnOnce(...) }` block at 661-668, and the comment above it that explains it.

That warning says the combination "will not be correctly scoped to the subscribing user". It now is, and a false warning teaches app authors to avoid something that works.

Do **not** touch the `bake='user'` + `Live.list` warning — different code path, still true.

- [ ] **Step 8: Full verification**

```bash
bun run test:unit && bun run build
```

Expected: both green. Unit count should rise by 19 (13 matcher + 6 resolver) from the 225 baseline on `main`.

```bash
bun run test:integration
```

Expected: exit 0. Needs live PostgreSQL and Redis.

- [ ] **Step 9: Commit**

```bash
git add packages/routekit/src/boot.ts packages/routekit/src/page-render.ts packages/routekit/src/route-user-key.test.ts
git commit -m "fix(routekit): scope SSE and snapshot user keys on dynamic routes

bakeByPattern is keyed by pattern but was looked up with the concrete path
the client subscribes with, so every dynamic bake='user' route missed and
fell back to the shared key — subscribers received nothing.

Both endpoints now share one resolveRouteUserKey helper instead of
duplicating the logic. identity(req) remains the only source of the key."
```

---

### Task 3: Documentation and memory

**Files:**
- Modify: `.memory/bugs-active.md` (§1), `.memory/bugs-resolved.md`, `.memory/active-work.md`
- Modify: `.codebase-memory/adr.md` (ADR-017)
- Modify: `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md` (mark item 1 done)

- [ ] **Step 1: Correct and move the bug entry**

`.memory/bugs-active.md` §1's "four warned-but-surprising combinations" entry describes this case as "SSE scoped to the wrong user" and "the most severe — wrong-user data". **Both are wrong** — see Findings. Rewrite the entry as three remaining combinations, and move this one to `.memory/bugs-resolved.md` with the accurate description: a silent loss of live updates on dynamic `bake='user'` routes, fixed by matching the subscribed path to its pattern.

- [ ] **Step 2: Amend ADR-017**

ADR-017 covers per-user artifacts. Add that SSE and snapshot user-key resolution matches the concrete request path against registered patterns rather than looking the path up directly, and that `identity(req)` remains the only source of the user key.

- [ ] **Step 3: Update the sequence and priorities**

Mark item 1 done in `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md` (section and summary table). In `.memory/active-work.md`, note the fix and that item 2 (`Live.list` non-`<li>` markup) is next.

- [ ] **Step 4: Verify and commit**

```bash
bun run test:unit && bun run build
```

```bash
git add -A .memory .codebase-memory docs
git commit -m "docs: record SSE user-key resolution for dynamic routes"
```

---

## Finishing

Push and open a PR against `main` — no menu, per standing preference. Lead with the corrected severity: silent loss of live updates, not cross-user exposure.

Expect no conflicts: `boot.ts` is touched only by #31 (nearest hunk 282-288, clear of 301), and `page-render.ts:661` is clear of #31's 767 and #32's 679/709.
