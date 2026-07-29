# Kiln Framework Backlog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the framework backlog in one unattended run — the `boot.ts` decomposition first, then every open correctness item and the Phase 5 DX list, ending with a fully green tree and a truthful set of memory files.

**Architecture:** Sequenced in five phases, hardest-and-most-invasive first (`boot.ts`), then cheap correctness wins, then config/DX, then the two remaining roadmap features, then bookkeeping. Each task is independently committable and independently revertible.

**Tech Stack:** Bun, TypeScript, Elysia, React 19 SSR, Postgres LISTEN/NOTIFY, Redis, bun:test.

## Global Constraints

- **Scope is framework only.** No changes under `apps/jags-list`. `examples/address-book` and `test-app` are in scope — they are framework fixtures, and two tasks target them directly.
- **Framework edits are authorised to unblock.** When a task cannot proceed as written, change the framework code needed to unblock it rather than stopping. Do not silently expand scope into app work.
- **Blocked-task policy: route around, never halt.** If a task genuinely cannot be completed, skip it, record why in the run report, and continue with every task that does not depend on it. Only Task 1 has hard dependents.
- **Every task ends green.** `bun run test:unit` and `bun run build` must pass before each commit. `bun run test:integration` needs live Postgres + Redis; run it at each phase boundary, not each task.
- **Do not touch `apps/jags-list`'s Redis DB index 3** and do not run `redis-cli FLUSHDB` — other work may be live in a sibling worktree.
- **Baseline for comparison** (2026-07-27, recorded in `.memory/bugs-active.md`): `test:unit` 208 pass / 51 skip / 0 fail; `test:integration` exit 0; `build` green. Re-establish this in Phase 0 before changing anything.

---

## Phase 0 — Sequencing guard and baseline

**This phase is mandatory and must not be skipped.** You chose `boot.ts`-first, which collides with in-flight work: a separate session is fixing the dynamic-segment layout cache bug in `packages/engine/src/cache.ts`, and its fix may also touch `boot.ts` (layout registration calls `cache.diskLayoutHtmlPath(layoutRoute)` at `boot.ts:671-672`). Refactoring `boot.ts` underneath that session would produce a conflict neither side can cleanly resolve.

- [ ] **Step 1: Check whether the layout fix has landed**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && git fetch origin --prune && git log origin/main --oneline -8
```

Look for a commit fixing layout pattern-caching (expect wording about layout cache keys, `diskLayoutHtmlPath`, or ADR-011 scoping).

- [ ] **Step 2: Branch from a tree that includes it**

**If the fix has landed:** `git pull --ff-only`, then create the worktree and proceed.

**If it has NOT landed:** do not start Task 1. Instead, run Phases 2 and 3 first (none of those tasks touch `boot.ts` or `cache.ts`), and return to Task 1 once the fix lands. Record this reordering in the run report. This is the one place the plan deliberately overrides its own stated order, because the alternative is a guaranteed conflict.

- [ ] **Step 3: Create the worktree**

Use the platform's worktree tool if available, otherwise `git worktree add`. Then build packages — `dist/` is gitignored, so a fresh worktree cannot resolve `@kiln/*` until you do:

```bash
bun install && bun run --filter '@kiln/*' build && bun install
```

The second `bun install` is deliberate: `test-app`'s build shells out to the `kiln` binary, whose bin symlink only appears once `packages/cli/dist/cli.js` exists. That is Task 12's subject; until it is fixed you must work around it here.

- [ ] **Step 4: Establish the baseline**

```bash
bun run test:unit 2>&1 | tail -5 && bun run build 2>&1 | grep -E "Exited with code [^0]" || echo "build clean"
```

Expected: 208 pass / 51 skip / 0 fail, build clean. **If the baseline is already red, stop and report** — a pre-existing failure would make every later result ambiguous.

---

## Phase 1 — Decompose `boot.ts`

### Task 1: Split `boot.ts` into cohesive modules

`packages/routekit/src/boot.ts` is 1527 lines, ~1.7× the next-largest file. It holds the request path, JSON negotiation, cache tiers, live-field upsert, SSE registration, and `startKiln` wiring. It is the main obstacle to reviewing changes there.

**Files:**
- Modify: `packages/routekit/src/boot.ts`
- Create: `packages/routekit/src/page-render.ts`, `packages/routekit/src/live-registration.ts`, `packages/routekit/src/html-markers.ts`, `packages/routekit/src/loader-request.ts`
- Modify: `packages/routekit/src/index.ts` (re-exports)

**Interfaces:** every currently-exported symbol keeps its name and its import path via `@kiln/routekit`. This is a pure move; no behaviour changes.

The seams, taken from the actual function boundaries:

| New module | Moves from `boot.ts` | Why it is cohesive |
|---|---|---|
| `html-markers.ts` | `wrapPageSegment`, `materializeLayoutSegment`, `respondWithNavigationShape`, `extractLayoutFragment`, `extractBalancedDiv`, `warnDomLiveInsideIslands`, `escapeAttribute`, `unwrapLiveProps`, `applyLivePropMarkers`, `countOccurrences`, `escapeHtml` (lines ~838–1034) | String/HTML manipulation with no I/O and no config |
| `loader-request.ts` | `makeLoaderRequest`, `makePrebakeRequest`, `makeNoopResponse` (~769–794, 1408–1436) | Synthetic request/response construction |
| `live-registration.ts` | `materializeLiveLists`, `assertEmbeddedLiveLists`, `hasLiveLists`, `registerLiveLists` (~1437–1527) | Live-list registration against the watcher |
| `page-render.ts` | `buildPageHandler` (~151–756) plus its private helpers `isDormantStale`, `computeLayoutSignature`, `addBounded`, `wantsJson` | The request path — the single biggest unit |
| `boot.ts` (remains) | `startKiln`, `buildActionHandler`, `respondWithErrorPage`, `warnOnce`, `nearestSpecialFile` | Wiring and app-level composition |

- [ ] **Step 1: Confirm the public surface before moving anything**

```bash
cd packages/routekit && grep -n "export" src/index.ts && grep -rn "from '@kiln/routekit'" ../../packages ../../test-app ../../examples --include=*.ts --include=*.tsx | grep -v /dist/ | sed 's/:.*from/ -> from/' | sort -u | head -20
```

Record this list. It is the contract the refactor must not break.

- [ ] **Step 2: Move one module at a time, rebuilding after each**

Work in the table's order — `html-markers.ts` first (pure functions, zero dependencies), `page-render.ts` last (largest, most entangled). After **each** module:

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && bun run --filter '@kiln/routekit' build && bun run test:unit 2>&1 | tail -4
```

Expected after every move: build clean, 208 pass / 0 fail. Moving all five before testing makes a failure impossible to localise — do not batch them.

- [ ] **Step 3: Verify no behaviour changed**

```bash
bun run test:unit 2>&1 | tail -4 && bun run build 2>&1 | grep -E "Exited with code [^0]" || echo "build clean"
```

Then confirm the file actually shrank and nothing was silently dropped:

```bash
wc -l packages/routekit/src/boot.ts packages/routekit/src/page-render.ts packages/routekit/src/live-registration.ts packages/routekit/src/html-markers.ts packages/routekit/src/loader-request.ts
```

Expected: `boot.ts` well under 600 lines; the five files' total within ~50 lines of the original 1527 (imports/exports add a little).

- [ ] **Step 4: Integration check — this is the one refactor that can break live behaviour**

```bash
bun run test:integration 2>&1 | tail -10
```

Expected: exit 0. `registerLiveLists` and `makeLoaderRequest` both moved, and both are load-bearing for the watcher.

- [ ] **Step 5: Commit**

```bash
git add packages/routekit/src && git commit -m "refactor(routekit): split boot.ts into page-render, live-registration, html-markers, loader-request"
```

---

## Phase 2 — Correctness

### Task 2: Adopt the orphaned integration test

`examples/address-book/db/contacts.integration.test.ts` is excluded from `test:unit` via `--path-ignore-patterns` but never named in `test:integration`, which lists its files explicitly. It runs in no suite at all.

- [ ] **Step 1: Confirm it still runs green standalone**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && bun --env-file=test-app/.env examples/address-book/db/contacts.integration.test.ts 2>&1 | tail -6
```

If it fails because it is stale rather than because the DB is absent, **delete it instead** and record that in the run report — the audit offered both outcomes.

- [ ] **Step 2: Add it to `test:integration`**

In root `package.json`, append to the `test:integration` chain:

```
 && bun --env-file=test-app/.env examples/address-book/db/contacts.integration.test.ts
```

- [ ] **Step 3: Verify and commit**

```bash
bun run test:integration 2>&1 | tail -6
git add package.json && git commit -m "test: run the orphaned address-book contacts integration test"
```

### Task 3: Fail clearly when `DATABASE_URL` is missing

Integration tests crash confusingly when `DATABASE_URL` is absent instead of skipping or explaining.

- [ ] **Step 1: Write the guard**

Add to `packages/engine/src/list-store.test.ts` and `packages/engine/src/store.test.ts`, at the top of each describe:

```ts
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[test] DATABASE_URL not set — skipping; see test-app/.env.example');
}
```

then gate the suite with `describe.skipIf(!hasDb)(...)`, matching the `RUN_APP_TESTS` pattern already used in `apps/jags-list/tests`.

- [ ] **Step 2: Verify both paths**

```bash
env -u DATABASE_URL bun packages/engine/src/store.test.ts 2>&1 | tail -4   # skips cleanly, exit 0
bun --env-file=test-app/.env packages/engine/src/store.test.ts 2>&1 | tail -4  # runs
```

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src && git commit -m "test(engine): skip DB integration suites cleanly when DATABASE_URL is unset"
```

### Task 4: Fresh clone builds in one pass

`test-app`'s build shells out to `kiln`, but `bun install` only creates that bin symlink once `packages/cli/dist/cli.js` exists — so the first `bun run build` in a clean tree fails with `kiln: command not found`. An existing workspace has the symlink from an earlier cycle, which hides this from everyone who already has one. **Confirmed live in this workspace on 2026-07-28.**

- [ ] **Step 1: Invoke the CLI by path rather than by bin name**

In `test-app/package.json`, change `"build": "kiln build"` to:

```json
"build": "bun ../packages/cli/dist/cli.js build"
```

This mirrors what `apps/jags-list` already does for `db:sync-triggers` (`bun ../../packages/cli/dist/cli.js sync-triggers`) — a pattern that already works precisely because it does not depend on the symlink.

- [ ] **Step 2: Prove it from a genuinely clean tree**

```bash
cd /tmp && rm -rf kiln-cleanclone && git clone /Users/jagjeet/Development/workspaces/Kiln kiln-cleanclone && cd kiln-cleanclone && bun install && bun run build 2>&1 | grep -E "command not found|Exited with code [^0]" || echo "CLEAN CLONE BUILDS IN ONE PASS"
```

This is the only way to verify — the working tree cannot reproduce it. Clean up `/tmp/kiln-cleanclone` afterwards.

- [ ] **Step 3: Commit**

```bash
git add test-app/package.json && git commit -m "build(test-app): invoke the kiln CLI by path so a clean clone builds in one pass"
```

---

## Phase 3 — Config and DX

### Task 5: Memoize bound methods in the `createKilnSql` Proxy

`packages/core/src/sql.ts` rebinds on every property access, so `sql.unsafe !== sql.unsafe` — a fresh bound function per `get`. That breaks identity comparison and memoization, and allocates on every access.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/sql.test.ts`:

```ts
it('returns a stable reference for bound methods', () => {
  const sql = createKilnSql('postgresql://localhost:5432/does-not-need-to-exist');
  // Identity must hold: memoizing callers and === comparisons depend on it.
  expect((sql as any).unsafe).toBe((sql as any).unsafe);
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
bun --env-file=test-app/.env packages/core/src/sql.test.ts 2>&1 | tail -6
```

- [ ] **Step 3: Add a per-property cache in the Proxy's `get` trap**

Hold a `Map<string | symbol, unknown>`; on a function-valued property, bind once, store, and return the stored value on subsequent accesses. Non-function properties pass through untouched.

- [ ] **Step 4: Verify and commit**

```bash
bun --env-file=test-app/.env packages/core/src/sql.test.ts 2>&1 | tail -4 && bun run test:unit 2>&1 | tail -4
git add packages/core/src && git commit -m "perf(core): memoize bound methods in the createKilnSql proxy"
```

### Task 6: Narrow `CacheProvider` to what ships

`packages/core/src/config.ts:106` types `'memory' | 'filesystem' | 'sqlite' | 'redis'`, but `startKiln` throws a boot error for `memory` and `sqlite` (`boot.ts:1097-1100`, or wherever Task 1 relocated it). Failing loudly is right; advertising them in the type is not.

- [ ] **Step 1: Narrow the type**

```ts
export type CacheProvider = 'filesystem' | 'redis';
```

- [ ] **Step 2: Follow the compiler**

```bash
bun run build 2>&1 | grep -E "error|Exited with code [^0]" | head -20
```

Fix every resulting error. Keep the runtime guard in `startKiln` — a JS-authored config can still pass `'sqlite'`, and the loud failure is still the right response.

- [ ] **Step 3: Verify and commit**

```bash
bun run test:unit 2>&1 | tail -4
git add packages/core/src && git commit -m "types(core): narrow CacheProvider to the providers that actually ship"
```

### Task 7: Env-var overrides for deployment-critical config

`loadConfigFromEnv` (`packages/core/src/config.ts:258-295`) covers only 6 web/backend vars. Nothing overrides `fsr.postgresUrl`, `fsr.redisUrl`, `cache.url`, or `fsr.buildId` — and `buildId` is meant to be a per-deploy git SHA (ADR-018), which is exactly the thing you want from the environment.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/config.test.ts` (create if absent):

```ts
it('overrides deployment-critical config from the environment', () => {
  const base = defineConfig({});
  process.env.KILN_FSR_POSTGRES_URL = 'postgresql://env-host:5432/envdb';
  process.env.KILN_FSR_BUILD_ID = 'deadbeef';
  try {
    const cfg = loadConfigFromEnv(base);
    expect(cfg.fsr?.postgresUrl).toBe('postgresql://env-host:5432/envdb');
    expect(cfg.fsr?.buildId).toBe('deadbeef');
  } finally {
    delete process.env.KILN_FSR_POSTGRES_URL;
    delete process.env.KILN_FSR_BUILD_ID;
  }
});
```

- [ ] **Step 2: Run it — expect FAIL, then implement**

Add `KILN_FSR_POSTGRES_URL`, `KILN_FSR_REDIS_URL`, `KILN_FSR_BUILD_ID`, and `KILN_CACHE_URL`. Copy `config.fsr` and `config.cache` into fresh objects first — the existing function already does exactly this for `web`/`backend`, with a comment explaining that a shallow spread would alias `DEFAULT_CONFIG` and let overrides bleed across calls. **The same hazard applies to the new sub-objects; do not skip it.**

- [ ] **Step 3: Verify and commit**

```bash
bun run test:unit 2>&1 | tail -4
git add packages/core/src && git commit -m "feat(core): env-var overrides for postgresUrl, redisUrl, cache.url, and buildId"
```

### Task 8: Runtime config validation

`defineConfig` merges without validating values. TypeScript catches typo'd keys, but nothing catches out-of-range values — they surface as obscure runtime failures, and JS-authored configs have no safety net at all.

- [ ] **Step 1: Write failing tests**

```ts
it('rejects an out-of-range image quality', () => {
  expect(() => defineConfig({ images: { quality: 150 } } as any)).toThrow(/quality/i);
});

it('rejects a non-numeric port', () => {
  expect(() => defineConfig({ port: 'nope' } as any)).toThrow(/port/i);
});
```

- [ ] **Step 2: Implement a validation pass**

Validate after merge, before return: `port` and `web.port`/`backend.port` are integers in 1–65535; `images.quality` is 1–100; `images.formats` contains only supported formats; the `fsr` second-based fields are non-negative numbers. Messages must name the offending key **and** the received value.

- [ ] **Step 3: Verify nothing in the repo trips it**

```bash
bun run test:unit 2>&1 | tail -4 && bun run build 2>&1 | grep -E "Exited with code [^0]" || echo "all in-repo configs valid"
```

If a fixture config trips the new validation, that is a real find — fix the config, and note it in the run report.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src && git commit -m "feat(core): validate config values at defineConfig time with actionable messages"
```

### Task 9: Retire the deprecated config surface

`fsr.idleEvictSecs`, `fsr.idleThresholdSecs`, and the whole `live` block warn on use (`config.ts:227-251`) but remain typed and merged.

- [ ] **Step 1: Confirm nothing in-repo still uses them**

```bash
grep -rn "idleEvictSecs\|idleThresholdSecs\|config.live\|live:" --include=*.ts --include=*.tsx packages examples test-app apps | grep -v /dist/ | grep -v "\.test\." | head -20
```

- [ ] **Step 2: Remove the types, the merge branches, and the warnings**

Delete `idleEvictSecs`/`idleThresholdSecs` from the `fsr` type and their bridging in `defineConfig`; delete the `live` block type and its `patchDebounceSeconds`/`purgeAfterSeconds` bridging. Keep `purgeSweepSeconds` and `purgeAfterSeconds` — those are the survivors.

- [ ] **Step 3: Follow the compiler, verify, commit**

```bash
bun run build 2>&1 | grep -E "error" | head -20; bun run test:unit 2>&1 | tail -4
git add packages/core/src && git commit -m "feat(core)!: remove the deprecated live block and idle* fsr fields"
```

Use the `!` marker — this is a breaking config change and the commit should say so.

### Task 10: Warn at sync time when a table has no `id` column

An `id`-less table silently gets only table-level invalidation, never the row-level `depKey:id` form. The write-breaking defect was already fixed, so a hard failure is not warranted — but `sync-triggers` should say so once, at install time, rather than leaving it to be discovered. `apps/jags-list`'s `task_labels` is the real-world instance.

**Files:** `packages/cli/src/sync-triggers.ts`, `packages/cli/src/sync-triggers.test.ts`

- [ ] **Step 1: Write the failing test**

Assert that syncing a table with no `id` column produces a warning naming the table and stating that only table-level invalidation applies. Follow the existing test's fixture style in `sync-triggers.test.ts`.

- [ ] **Step 2: Implement**

Before installing each trigger, query `information_schema.columns` for an `id` column on that table; when absent, warn once per table. Do not change the `SyncResult` action values — `created`/`exists`/`missing`/`updated`/`outdated` are consumed by callers.

- [ ] **Step 3: Verify and commit**

```bash
bun --env-file=test-app/.env packages/cli/src/sync-triggers.test.ts 2>&1 | tail -4
git add packages/cli/src && git commit -m "feat(cli): warn at sync time when a trigger table has no id column"
```

---

## Phase 4 — Roadmap features

These two are larger and less specified than Phases 2–3. If either proves to need design decisions beyond what is written here, **complete what you can, commit it, and record the open question in the run report** rather than inventing an architecture unattended.

### Task 11: Migrate the address-book contacts layout (Phase 4.4)

`examples/address-book/pages/contacts/_layout.tsx` `load()` reads `req.query.q`, `req.params.id`, **and** `req.path` — three per-request values — while layouts are cached per route pattern. This is the same root cause as the dynamic-segment layout bug fixed in the separate session.

- [ ] **Step 1: Re-read the layout-cache fix that landed in Phase 0**

Whatever that session chose — concrete-path keying, classifier demotion, or a hybrid — determines this task's correct shape. **Do not proceed on assumption; read the merged fix first**, then either (a) let the new classifier demote this layout and verify it, or (b) move the varying reads down into the pages that need them, leaving the layout genuinely pattern-invariant.

- [ ] **Step 2: Write a regression test asserting two concrete instances render their own data**

Two different contact ids must produce two different rendered layouts. This is the assertion whose absence let the bug live.

- [ ] **Step 3: Verify and commit**

```bash
bun run test:unit 2>&1 | tail -4 && bun run test:integration 2>&1 | tail -4
git add examples/address-book && git commit -m "fix(address-book): stop the contacts layout reading per-request state"
```

### Task 12: Fine-grained debounce scheduling (Phase 4.3)

Per-field invalidation windows instead of coarse sweep intervals. `LiveFieldMeta.debounce` and `LiveListMeta.debounce` already exist and are already persisted per slot (`upsertSlot`'s debounce argument) — so the data is there; the scheduler is what is coarse.

- [ ] **Step 1: Establish what is actually coarse**

```bash
grep -n "debounce\|Debounce\|sweep\|setInterval\|setTimeout" packages/engine/src/watcher.ts | head -25
```

Determine whether the watcher already honours per-slot debounce or applies one global window. **If per-slot debounce is already honoured, this task is already done** — verify with a test, record that finding, and skip the implementation.

- [ ] **Step 2: If genuinely coarse, schedule per slot**

Group stale slots by their own debounce value rather than sweeping all on one timer. Preserve the existing guarantee that a slot is never patched before its debounce elapses.

- [ ] **Step 3: Verify and commit**

```bash
bun --env-file=test-app/.env packages/engine/src/watcher.test.ts 2>&1 | tail -4 && bun run test:integration 2>&1 | tail -4
git add packages/engine/src && git commit -m "feat(engine): schedule live-field patches per-slot debounce"
```

Use `runOnce` rather than `start()` plus a sleep in any new watcher test — `start()` races the guard's own recovery tick and has put a ~50% flaky test into main before.

### Task 13: External watcher process (Phase 4.2)

`fsr.watcher: 'embedded' | 'external'` is typed, but external mode is only partially implemented — and `assertEmbeddedLiveLists` throws outright for `Live.list` under an external watcher, because the callbacks are not serializable.

- [ ] **Step 1: Map exactly what exists**

```bash
grep -rn "'external'\|external" packages/engine/src packages/routekit/src packages/core/src --include=*.ts | grep -v /dist/ | grep -v "\.test\." | head -20
```

- [ ] **Step 2: Decide honestly whether to finish or to scope it down**

Completing external mode means solving `Live.list` callback serialization — a genuine architecture question (RPC back to the app process? restrict external mode to scalar fields?). **This is the one task in this plan most likely to exceed what should be decided unattended.** If the answer is not obvious from the existing code's intent, implement the narrow version — external mode supported for scalar `LiveProp` only, with the existing `Live.list` guard kept and its error message improved to say *why* — commit that, and record the architectural question in the run report for a human decision.

- [ ] **Step 3: Verify and commit**

```bash
bun run test:unit 2>&1 | tail -4 && bun run test:integration 2>&1 | tail -4
```

---

## Phase 5 — Bookkeeping and final regression

### Task 14: Strike the stale backlog entries

Two entries assert something no longer true: *"jags-list has no `Live.value`/`Live.list` usage"* and call it the highest-value test gap. PR #24 closed exactly that — `apps/jags-list/tests/live.integration.test.ts` proves ADR-018 auto-deps end-to-end through a real page, and `pages/projects/[id]/activity.tsx` carries a `Live.list` with `dependsOn: 'activity'`.

- [ ] **Step 1: Verify the claim is genuinely dead before striking it**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && ls apps/jags-list/tests/live.integration.test.ts && grep -c "Live.list" 'apps/jags-list/pages/projects/[id]/activity.tsx'
```

- [ ] **Step 2: Remove roadmap Phase 5 item 8 and the matching `bugs-active.md` carry-forward bullet**

Replace both with a one-line pointer recording that it was closed by PR #24, so the history is not lost.

- [ ] **Step 3: Update the roadmap for everything this run completed**

Mark Phases 4.3/4.4 and each Phase 5 item done or explicitly deferred with a reason. Do not mark anything done that the run report says was skipped.

- [ ] **Step 4: Commit**

```bash
git add .memory && git commit -m "docs(memory): retire completed backlog items and the stale auto-deps test gap"
```

### Task 15: Full regression and run report

- [ ] **Step 1: Everything, from a clean build**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln && bun install && bun run --filter '@kiln/*' build && bun run build 2>&1 | grep -E "Exited with code [^0]" || echo "build clean"
bun run test:unit 2>&1 | tail -5
bun run test:integration 2>&1 | tail -8
```

Expected: build clean; `test:unit` at least the 208-pass baseline plus the tests this plan adds, 0 fail; `test:integration` exit 0.

- [ ] **Step 2: Confirm the apps still work — they consume every package touched here**

```bash
cd apps/jags-list && bun run build && bun run test && bun run test:db && bun run test:app && bun run test:purity && bun run test:crud && bun run test:freshness && bun run test:gate && bun run test:live
```

Expected: 0 failures. Tasks 1, 6, 7, and 9 all change surfaces jags-list uses; a green framework suite alone does not prove the apps survived. **This is a read-only verification — do not edit `apps/jags-list` to make it pass.** If it breaks, the framework change is what is wrong.

- [ ] **Step 3: Write the run report**

State, per task: completed / skipped-and-why / completed-differently-than-planned. Name every open architectural question raised by Tasks 12 and 13. Report failures plainly with their output — a partially-completed backlog reported honestly is worth more than an optimistic summary.

- [ ] **Step 4: Push and open a PR**

```bash
git push -u origin <branch> && gh pr create --base main --title "Kiln framework backlog — boot.ts decomposition, correctness fixes, and Phase 5 DX" --body "<summary from the run report>"
```

---

## Self-review notes

**Ordering deviates from the stated preference in exactly one case, deliberately.** `boot.ts`-first was chosen, but Phase 0 permits running Phases 2–3 ahead of Task 1 if the in-flight layout fix has not landed. Refactoring `boot.ts` under another session editing the same area produces a conflict neither side can resolve cleanly. Phases 2–3 touch neither `boot.ts` nor `cache.ts`, so the reordering costs nothing.

**Two tasks may be smaller than billed — check before building.** Task 12 may already be implemented (per-slot debounce values are already persisted), and Task 2 may end in a deletion rather than an addition. Both say so explicitly, because discovering it during execution is cheaper than the alternative.

**Task 13 is the least suitable for unattended work** and is placed last for that reason, with an explicit instruction to implement the narrow version and escalate the architecture question rather than invent an answer.

**Not covered, by scope decision:** all `apps/jags-list` work — Plan 3b (board island), the `/projects` restructure, and Plan 4. Also excluded: the dynamic-segment layout-cache fix itself, which a separate session owns and which Phase 0 treats as a precondition rather than a task.
