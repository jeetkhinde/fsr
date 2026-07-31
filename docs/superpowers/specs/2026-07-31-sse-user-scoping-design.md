# SSE User Scoping on Dynamic Routes — Design

**Date**: 2026-07-31
**Status**: Approved, pending implementation plan
**Scope**: Kiln framework. Item 1 of `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md`
**Branch**: `fix/sse-user-scoping`, from `main` @ `f5fa13a`

## Problem

On a `bake='user'` page whose route has a dynamic segment, live updates never reach the subscriber.

`bakeByPattern` is keyed by route **pattern** — `bakeByPattern.set(page.pattern, pageOptions.bake)`
(`packages/routekit/src/boot.ts:185`) — so its keys look like `/projects/:id/activity`. Both
consumers look it up with the **concrete** path the client subscribed with:

- `packages/routekit/src/boot.ts:301-302`, the SSE endpoint:
  `const routeBake = bakeByPattern.get(route)` where `route = req.query.route`, then
  `const sseUserKey = routeBake === 'user' && identity ? identity(req) ?? '' : ''`
- `packages/routekit/src/boot.ts:366-367`, the snapshot handler: the identical pair

The client sends `window.location.pathname` (`packages/routekit/src/live-client-script.ts:167`), so
for a dynamic route the lookup **misses**. `routeBake` is `undefined`, the `=== 'user'` guard fails,
and `sseUserKey` falls back to `''` — the shared key.

## What actually goes wrong — and what does not

The framework detects this exact combination and warns that patches "will not be correctly scoped to
the subscribing user" (`packages/routekit/src/page-render.ts:661-668`), then proceeds. That wording
is ambiguous, and an earlier survey (including
`docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md` as first written, and PR #33)
escalated it to "cross-user data exposure". **That is wrong, and this spec corrects it.**

Tracing both sides:

- **Writer.** `const userKey = uid ?? ''` (`packages/routekit/src/page-render.ts:211`), where
  `uid = identity(req)`. This does not depend on whether the route is dynamic, so an authenticated
  render **always** writes its slots under its own uid and can never populate the shared row.
- **Reader.** The stream filters by exact match —
  `if ((patch.userKey ?? '') !== userKey) continue` (`packages/engine/src/hub.ts:308`). A subscriber
  holding `''` therefore matches none of the patches published under a real uid.

So the real failure is that **subscribers on dynamic `bake='user'` routes receive no live patches at
all**. On the initial snapshot (`fetchSlotsForSnapshot(route, slots, userKey)`,
`packages/engine/src/hub.ts:395`) they read the shared row, which is either absent or — if an
anonymous request ever rendered that route — holds the **anonymous** view. Anonymous is the
least-privileged view, and no authenticated render can write the shared row, so there is no
user-to-user leak.

This remains the highest-priority open framework defect: an entire class of routes silently loses
live updates, the same failure mode that made the `Live.list` auto-deps gap a bug rather than a
documented limitation. It is a **correctness** defect, not a privacy breach, and the sequencing
doc, PR #33 and the memory notes are being corrected accordingly.

## Non-goals

- `Live.list` in a dynamic-segment layout (all instances share one channel) — different mechanism,
  keyed on layout patterns.
- `bake='user'` + `Live.list` (unsupported), `cacheKey` + live fields (updates skipped). These are
  item 6 of the sequencing doc and keep their own warnings.
- Any change to the client/server subscribe contract. Considered and rejected: having the client
  send its route **pattern** alongside the concrete path would avoid per-connection matching, but it
  is a contract change for no real gain, and it introduces a client-supplied value into a
  server-side authorization-shaped decision.

## 1. A path → pattern matcher

New module `packages/routekit/src/match-pattern.ts`. No such helper exists anywhere today — searched
`packages/routekit/src` and `packages/engine/src` for `matchPattern` / `matchRoute` /
`patternToRegex`; the Elysia adapter does its own routing and does not expose it.

```ts
export interface CompiledPattern {
  pattern: string;
  regex: RegExp;
}

/** Compile once at startup, sorted most-specific first. */
export function compilePatterns(patterns: string[]): CompiledPattern[];

/** First match wins, so ordering carries the precedence rule. Null when nothing matches. */
export function matchPattern(compiled: CompiledPattern[], path: string): string | null;
```

**Precedence must agree with what the adapter would actually serve**, or the bake mode gets resolved
from a different page than the one that rendered. The comparator, stated exactly so it cannot be
read two ways:

1. Compare segments left to right. Rank each: literal `0`, `:param` `1`, `*` `2`. The first index
   where two patterns differ decides, lower rank first. So `/projects/new` sorts ahead of
   `/projects/:id` — the same answer Elysia gives.
2. If neither pattern differs at any shared index, the one with **more** segments sorts first (a
   wildcard pattern is necessarily shorter and must lose to a longer literal one).
3. Ties remaining after both rules are impossible for distinct patterns, but sort them
   lexicographically anyway so ordering is deterministic across runs rather than dependent on
   filesystem discovery order.

Trailing slashes are normalized before matching (`/a/` and `/a` resolve alike); the empty path is
normalized to `/`.

**The concrete-path lookup is memoized in a bounded Map.** `route` arrives as a query parameter, so
an unbounded cache would be a memory-growth vector from arbitrary subscribe paths. Note that
`packages/routekit/src/dedup.ts`'s `addBounded` takes a **`Set`** and so cannot be used directly
here; its own comment records the convention for this case — *"not every dedup structure is a Set:
the request path's `lastTouched` is a Map and caps itself directly against this bound."* Follow that
precedent: import the exported `DEDUP_SET_MAX` and cap the Map against it, rather than duplicating
the constant or reshaping `addBounded`.

## 2. One resolution helper, used by both call sites

`boot.ts:301-302` and `boot.ts:366-367` are the same logic written twice. They collapse into a
single exported function so the two cannot drift:

```ts
export function resolveRouteUserKey(input: {
  route: string;
  compiled: CompiledPattern[];
  bakeByPattern: Map<string, BakeMode | undefined>;
  identity?: KilnIdentity;
  req: KilnRequest;
}): string;
```

It resolves the concrete path to a pattern, reads that pattern's bake mode, and returns
`identity(req) ?? ''` when the mode is `'user'`, otherwise `''`. Pure and unit-testable with no
server — the same reason `resolveListDeps` was extracted in the `Live.list` auto-deps work.

**`identity(req)` remains the only source of the user key.** The matched pattern selects a bake mode
and nothing else, so no client-supplied value can influence whose data is read. This property is the
reason the client-sends-pattern alternative was rejected, and it must survive review.

The existing guarantee at `boot.ts:297-300` — a shared route resolves `''` even when an identity
hook is configured for other routes — is preserved: only `bake === 'user'` narrows the key.

## 3. Unmatched routes warn, and stay shared

When the concrete path matches no registered pattern, behaviour is unchanged (`userKey = ''`) but a
`warnOnce` names the route. Nothing that works today breaks — including an old client briefly
outliving a removed route during a rolling deploy — and a case that was previously silent becomes
visible.

Rejected: rejecting the subscription with a 400. It converts a degraded-but-working page into a
broken one, and a stale client during deploy is the common cause rather than a programming error.

## 4. Delete the warning that is no longer true

`packages/routekit/src/page-render.ts:661-668` warns that a `bake='user'` route with a dynamic
segment and `LiveProp` fields will not be correctly scoped. Once resolution works this is false, and
a false warning is worse than none — it teaches app authors to avoid a combination that now works.

Note its guard is `pageLiveFields.length > 0`, i.e. **scalars**. The separate `bake='user'` +
`Live.list` warning is a different code path and stays untouched.

## 5. Isolation and boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `match-pattern.ts` | Compile patterns; match a concrete path to one | `dedup.ts` (`addBounded`) only |
| `resolveRouteUserKey` (`boot.ts`) | Bake mode → user key, for both endpoints | matcher, `KilnIdentity` |
| SSE + snapshot handlers (`boot.ts`) | Call the helper; otherwise unchanged | the above |

The matcher has no knowledge of bake modes, identity or SSE; it is a pure string function and is
testable on its own. `resolveRouteUserKey` has no knowledge of streams.

## 6. Verification

**Matcher unit tests:** static path; single param; multiple params; wildcard; precedence
(`/projects/new` beats `/projects/:id`); trailing-slash normalization; no match returns null; the
memo returns the same answer as a cold lookup.

**`resolveRouteUserKey` unit tests — this is the falsifier:**

- a dynamic `bake='user'` pattern subscribed with a **concrete** path returns the identity's uid.
  **On `main`'s logic this returns `''`**, so the test must be confirmed to fail before the fix
  rather than assumed to — check that direction explicitly.
- a `bake='shared'` route returns `''` even with an identity hook configured (protects the
  `boot.ts:297-300` guarantee).
- a `bake='user'` route with no identity hook returns `''`.
- an anonymous request (`identity` returns null) on a `bake='user'` route returns `''`.
- an unmatched route returns `''` and warns once.

**No jags-list changes.** jags-list is a test vehicle and cannot express this combination today — its
only `bake='user'` page is `pages/index.tsx` and `/` has no dynamic segment. Adding a page there to
host a framework test would invert the relationship: the app adopts what the framework gives it, not
the reverse.

An end-to-end proof would need a new `test-app` fixture page (dynamic + `bake='user'` + a live
field) plus a spawn test. **Deliberately skipped**: the pure-helper test falsifies the actual defect
— a wrong user key — and the fixture adds substantial machinery for the same assertion. If review
disagrees, `test-app` is the correct home, never jags-list.

Per project discipline: `bun run test:unit`, `bun run test:integration`, and `bun run build`.

## 7. Documentation

- Correct the severity claim in `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md`
  (item 1 and the summary table), in PR #33's description, and in the memory notes. It is a silent
  correctness defect, not cross-user exposure.
- `.memory/bugs-active.md` §1: the "four warned-but-surprising combinations" entry calls the
  `bake='user'` + dynamic + live case "SSE scoped to the wrong user" and "the most severe — wrong-user
  data". Both need correcting, and the item moves to `bugs-resolved.md` on completion.
- ADR-017 covers per-user artifacts; add a note that SSE and snapshot user-key resolution matches the
  concrete request path against registered patterns rather than looking up the path directly.
