# Framework Fix Sequencing

**Date**: 2026-07-31
**Scope**: Kiln framework only. `apps/jags-list` is a test vehicle — it adopts whatever the
framework gives it, and appears below only as a falsifier, never as a deliverable.
**Baseline**: `main` @ `f5fa13a`. Two PRs open and unmerged: **#31** (`feat/action-response-api`),
**#32** (`fix/live-list-auto-deps`).

This document orders the remaining framework work and records, with evidence, which items can start
before those PRs merge. Each item gets its own spec + plan when it is started; this is the sequence,
not the design.

---

## Ordering principle

Ordered by **framework severity**, not by what the test vehicle happens to exercise. That
distinction is load-bearing here: the highest-severity item below (#1) has stayed open through two
sessions precisely because `apps/jags-list` cannot reach it — its only `bake='user'` page is
`pages/index.tsx`, and `/` has no dynamic segment. An app-led queue structurally cannot surface
bugs the app does not touch.

Conflict avoidance is a tie-breaker, never a reason to defer a correctness bug.

---

## Conflict map (measured, not estimated)

Files changed by the open PRs, from `gh pr view <n> --json files`:

| File | #31 | #32 |
|---|---|---|
| `packages/routekit/src/page-render.ts` | ✅ | ✅ |
| `packages/routekit/src/boot.ts` | ✅ | — |
| `packages/routekit/src/live-registration.ts` | — | ✅ |
| `packages/core/src/list.ts` | — | ✅ |
| `packages/core/src/types.ts`, `errors.ts`, `index.ts`, `cookies.ts` | ✅ | — |
| `packages/adapter-elysia/src/*` | ✅ | — |
| `packages/routekit/src/{html-markers,image-handler,loader-request,boot.test}.ts` | ✅ | — |
| `.memory/{active-work,bugs-active,bugs-resolved}.md`, `.codebase-memory/adr.md` | ✅ | ✅ |

Both PRs touch `page-render.ts`, but in disjoint regions — hunk headers:

- **#31**: `@@ -767,7 @@` (one line: a header write converted to `res.headers.set`)
- **#32**: `@@ -679,6 @@`, `@@ -709,6 @@` (the two `registerLiveLists` call sites)

`boot.ts` is touched only by #31, at `@@ -10 @@`, `@@ -57 @@`, `@@ -85 @@`, `@@ -254 @@`,
`@@ -282 @@`, `@@ -407 @@`.

**The `.memory` and ADR files will conflict between #31 and #32 themselves** — both rewrote the same
"Recommended starting point" section. Docs-only, trivial to resolve, but expect it on whichever
merges second. Every item below also touches those files at completion, so resolve the #31/#32
conflict before starting item work to avoid compounding it.

---

## The sequence

### 0. `.env.example` + preflight check — **DONE**

**Files**: new `test-app/.env.example`, `apps/jags-list/.env.example` (exists), a preflight check in
the test scripts. **Touched by neither PR — zero conflict.**

`.env` is gitignored, so a fresh clone or worktree cannot run `test:integration`; it fails with
`database "jagjeet" does not exist` until `test-app/.env` is copied in. This cost time on 2026-07-30
and again on 2026-07-31 (twice more, once per new worktree).

Listed at 0 rather than last because it is ~30 minutes and makes every later item's worktree setup
cheaper. It is DX, not correctness — if the queue is tight, it can slide to the end without harm.

---

### 1. SSE user scoping on dynamic routes — **DONE** (PR #34)

**Severity**: highest open defect. A `bake='user'` page on a dynamic route silently stops
delivering live updates entirely.

**Corrected 2026-07-31** — this was first written here, and in PR #33, as "cross-user data
exposure". That is **wrong**. `page-render.ts:211` sets `userKey = uid ?? ''` regardless of whether
the route is dynamic, so an authenticated render always writes under its own uid and can never
populate the shared row; `hub.ts:308` then filters patches by exact `userKey` match. A subscriber
holding `''` therefore matches **nothing**. On the initial snapshot (`hub.ts:395`) it reads the
shared row — absent, or holding the **anonymous** view if an anonymous request ever rendered that
route. Anonymous is the least-privileged view and there is no path for one user's data to reach
another, so there is no privacy breach. It stays item 1 because an entire class of routes silently
loses live updates — the same failure mode as the auto-deps gap — not because of exposure.

**Root cause, traced.** `bakeByPattern` is keyed by route **pattern**
(`packages/routekit/src/boot.ts:185` — `bakeByPattern.set(page.pattern, pageOptions.bake)`), so its
keys look like `/projects/:id/activity`. Both consumers look it up with the **concrete** path the
client subscribed with:

- `packages/routekit/src/boot.ts:301-302` (SSE) — `const routeBake = bakeByPattern.get(route)` where
  `route = req.query.route`, then
  `const sseUserKey = routeBake === 'user' && identity ? identity(req) ?? '' : ''`
- `packages/routekit/src/boot.ts:366-367` (snapshot handler) — the identical pair

For a dynamic route the lookup **misses**, so `routeBake` is `undefined`, the `=== 'user'` guard
fails, and `sseUserKey` falls back to `''` — the **shared** key. Every subscriber to that route then
reads the same shared slot row instead of their own. The framework already knows this is happening:
`packages/routekit/src/page-render.ts:661-668` detects the exact combination and `warnOnce`s that
patches "will not be correctly scoped to the subscribing user" — then proceeds.

**What the fix needs.** A concrete-path → registered-pattern matcher. **No such helper exists** —
searched `packages/routekit/src` and `packages/engine/src` for `matchPattern`/`matchRoute`/
`patternToRegex` and found nothing; the Elysia adapter does its own routing and does not expose it.
So this needs a small, tested matcher, used at both `boot.ts` sites. The `page-render.ts` `warnOnce`
then goes away — it becomes false once resolution works.

**Designed 2026-07-31**, see `docs/superpowers/specs/2026-07-31-sse-user-scoping-design.md`.
Server-side matching at subscribe time; the client contract is unchanged. Having the client send its
pattern was considered and rejected — a contract change for no real gain, and it puts a
client-supplied value into a server-side decision. `identity(req)` remains the only source of the
user key; the matched pattern selects a bake mode and nothing else.

**Conflict**: touches `boot.ts` (#31's file) and `page-render.ts` (both PRs' file), but at
**line 301/366 and 661** — outside every hunk listed above. #31's nearest `boot.ts` hunk covers
282-288, thirteen lines clear of 301. **Safe to start now, off `main`.**

**Falsification**: the resolution helper must return the subscriber's uid for a dynamic
`bake='user'` pattern subscribed with a concrete path — it returns `''` on `main`'s logic, so the
test fails before the fix. jags-list cannot express this combination (no dynamic `bake='user'` page)
and must **not** be extended to host a framework test; `test-app` is the correct home if an
end-to-end proof is ever wanted.

---

### 2. `Live.list` cannot mark non-`<ul>/<li>` markup — **DONE** (PR #35)

**Severity**: largest capability hole. `applyLiveListMarkers` finds rows by scanning for `<li>`
inside the nearest `<ul>`/`<ol>` (`packages/routekit/src/live-list-render.ts:90,131`), so a
div-based board or a table cannot be a live list at all. This is the constraint most likely to block
a real UI — a kanban board is divs.

**Conflict**: `live-list-render.ts` is touched by **neither** open PR. Zero overlap. This is the
safest item to run in parallel with anything else, including alongside item 1.

---

### 3. Layout scalar live fields get no auto-deps — **DONE**

**Wider than filed.** `extractLiveFields` only ever ran over the page's props, so a layout's
`Live.value` was DOM-marked and then never registered: no slot row, no loader. Capturing deps alone
would have been a no-op. Layout fields are now registered under the page's concrete route, each
taking its own layout's observed tables, and the outermost layout carries the `data-kiln-live`
container their `s-live` spans need (silcrow scopes slot discovery to each container's subtree, and
layouts wrap the page wrapper rather than sitting inside it).

<details><summary>Original entry</summary>


**Severity**: moderate; completes the parity story #32 began. Layout `load()` is never wrapped in
`withDepCapture` — the layout branch calls `lMod.load(tracker.proxied)` directly
(`packages/routekit/src/page-render.ts`, layout branch ~line 463), so layout **scalar** live fields
receive no automatic dependencies. Layout *lists* are unaffected, because #32's list capture is
self-contained inside `materializeLiveLists`.

Found while implementing #32 and deliberately excluded from it as a separate defect.

**Conflict**: `page-render.ts` at ~463, well clear of #31's 767 and #32's 679/709. No hunk overlap,
but it is conceptually a continuation of #32 and its test will read more naturally once #32 has
landed. **Prefer after #32 merges**; not blocked by it.
</details>

---

### 4. `Live.list` inside an island receives nothing, and has no `target` option — **DONE**

`Live.list({ target: 'dom' | 'store' | 'dom-and-store' })`, same vocabulary as `Live.value`. A
store-delivered list is left unmarked and declares itself in `data-kiln-list-store`; the client
publishes each patch to `live-list:<name>` *before* any DOM early-return. Patches are published
rather than reduced client-side, because reducing needs the list's `key(row)`, which lives in
`load()` and cannot be serialized — `useLiveList(name, { key, initial })` in `@kiln/react` reduces
with the app's own accessor and replays a bounded log so a patch landing before hydration is not
lost.


**Severity**: moderate. `_patchList` early-returns when the list is inside `[data-kiln-island]`
(`packages/routekit/src/live-client-script.ts:63`) and, unlike the scalar path, never publishes to
the Silcrow store, so a list inside an island gets nothing. `LiveListOptions` has no `target`
option, so there is no opt-in either (`packages/live/src/list.ts`).

**Conflict — this one is genuinely blocked.** It must change `packages/live/src/list.ts` and
`packages/core/src/list.ts` (adding `target` to the options and meta) and probably
`live-registration.ts`. **`packages/core/src/list.ts` and `live-registration.ts` are both modified
by #32**, and #32 changed the exact structures this item extends (`LiveListMeta`,
`cloneLiveListRows`'s signature, `resolveListDeps`). Starting before #32 merges means rebasing onto
a changed meta shape.

**Wait for #32 to merge, then branch from updated `main`.**

---

### 5. App owning its entry point cannot use islands — **DONE** (ADR-020)

`config.server.setup({ adapter, config, mode })` runs in both `kiln dev` and `kiln start`, before
pages are mounted; `ServerAdapter.registerRaw` mounts a handler outside the page pipeline. An app
no longer trades islands and the FSR supervisors for one raw route.


**Severity**: moderate, and **rescoped** by #31. The old framing — "an app needing cookies must own
its entry" — is dead: actions can set cookies now. What still forces a custom entry, read from
`apps/jags-list/src/main.ts` after #31's rewrite, is (a) better-auth's `/api/auth/*` catch-all,
which is not a Kiln page and has nowhere else to mount, and (b) hand-built FSR wiring plus
`registerAsset`, duplicating what the CLI's `initFsr` already does.

So the real problem is: **let app code contribute raw routes and assets under `kiln dev` /
`kiln start`.** Smaller and better-defined than the original entry.

**Conflict**: `packages/cli/src/cli.ts` is touched by neither PR. Likely also touches `boot.ts`
(#31's file) — check hunks at the time. **Prefer after #31 merges**, since the rescope depends on
#31's final shape.

---

### 6. Remaining warned-but-surprising combinations — **DONE** (one supported, two decided against)

- **`Live.list` in a dynamic-segment layout → supported.** Container stamp and registration both use
  `layoutInstancePath()` (`/projects/7`, not `/projects/:id`), so instances stop sharing a channel.
  Warning removed.
- **`cacheKey` + live fields → not supported, decided.** Live registrations write to the route's
  base cache paths.
- **`bake='user'` + `Live.list` → not supported, decided.** Scalar fields under `bake='user'` are
  fully supported and cover the real cases.

Both remaining warnings now state the decision and the two ways out instead of reading as a TODO.
They stay warnings rather than startup errors deliberately: neither is detectable before `load()`
runs, and throwing at first render would turn a degraded page into a production 500.


Three left once item 1 lands, each a live `warnOnce`: `cacheKey` + live fields (updates silently
skipped); `bake='user'` + `Live.list` (unsupported); `Live.list` in a dynamic-segment layout (all
instances share one channel). Each is warned, so none fails silently — which is why they rank below
everything above. Worth a single pass that decides, per combination, whether to support it or to
turn the warning into a hard startup error.

**Conflict**: to be measured when started; the third overlaps item 1's dynamic-segment work and may
partly fall out of it.

---

### 7. External watcher — **DECIDED: option (c), removed** (ADR-021)

`fsr.watcher: 'external'` is gone; `validateConfig` rejects it by name. Reviving an out-of-process
watcher is a designed feature with an RPC protocol, not a config string — see ADR-021 and
`.memory/roadmap.md` Phase 4.2. Original framing below.


`fsr.watcher: 'external'` is typed but has **no implementation** (confirmed 2026-07-29): the only
references are the type union, a read-path branch that re-runs `load()` on every cache hit, and the
`Live.list` guard. Setting it today means "no watcher, re-load every time", forfeiting the caching
that live routes exist for.

It cannot be implemented without an architecture call: an out-of-process watcher must invoke a
`Live.list`'s closures (`keyOf`, `query`, and a `renderRows` callback that SSRs the page component).
Closures cannot cross a process boundary, and `renderRows` needs the component graph loaded.

**Options, for the maintainer:** (a) RPC back into the app process; (b) restrict external mode to
scalar `Live.value` fields only and reject `Live.list`; (c) drop the option and delete the type.

Not startable until that is answered.

---

## Summary

| # | Item | Severity | Start before #31/#32 merge? |
|---|---|---|---|
| # | Item | Outcome |
|---|---|---|
| 0 | `.env.example` + preflight | **DONE** |
| 1 | SSE user scoping on dynamic routes | **DONE — PR #34** |
| 2 | `Live.list` non-`<li>` markup | **DONE — PR #35** |
| 3 | Layout scalar live fields (wider than filed) | **DONE** |
| 4 | `Live.list` in islands + `target` | **DONE** |
| 5 | App entry + islands | **DONE — ADR-020** |
| 6 | Three warned combos | **DONE** — 1 supported, 2 decided against |
| 7 | External watcher | **DONE — removed, ADR-021** |

**Every item in this sequence is closed.** Items 0 and 3-7 shipped on `fix/framework-dx`
(340 unit / 0 fail, integration exit 0, build exit 0). Two findings were wider than filed and are
recorded as such above: item 3 (layout live fields never registered at all, not merely un-dep'd)
and item 6's third combination (the shared channel was a routing identity bug, fixable rather than
a limitation to warn about).
