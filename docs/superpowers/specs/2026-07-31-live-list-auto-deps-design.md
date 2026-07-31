# Live.list Auto-Deps Parity — Design

**Date**: 2026-07-31
**Status**: Approved, pending implementation plan
**Scope**: Kiln framework, first item of `.memory/bugs-active.md` §1
**Branch**: `fix/live-list-auto-deps`, from `main` @ `f5fa13a`

## Problem

A scalar `LiveProp` gets automatic dependencies; a `Live.list` does not.

`registerLiveLists` passes `meta.dependsOn` straight through, at both of its `dependsOn:` sites
(`packages/routekit/src/live-registration.ts`). The scalar path, by contrast, unions the tables
observed during the request's `load()` into every live field's explicit deps
(`packages/routekit/src/page-render.ts`, step 12 — "Auto-deps (default on)"). The asymmetry is
invisible at the call site: omit `dependsOn` on a `Live.value` and it still works; omit it on a
`Live.list` and the list quietly stops tracking writes.

`apps/jags-list/pages/projects/[id]/activity.tsx` carries a comment explaining that `dependsOn` is
mandatory there — a workaround for this defect, written into an app that exists to exercise the
framework.

### Correction to the recorded bug description

`.memory/bugs-active.md` states that omitting `dependsOn` "registers a list that never updates".
**That is true only when `revalidate: false`.** Verified against source:

- `revalidate: false` persists as `revalidate_secs = 0` (`packages/engine/src/list-store.ts`, the
  `upsertSnapshot` INSERT).
- `fetchStaleLists` refreshes a list when `stale = TRUE` **OR**
  `COALESCE(revalidate_secs, <default>) > 0` and the timer has elapsed
  (`packages/engine/src/list-store.ts`), the default being `config.revalidateSeconds ?? 300`
  (`packages/engine/src/watcher.ts`).

So a dep-less list with default settings degrades to **~300s polling**, not death. Only
`revalidate: false` plus no deps is genuinely inert. The bug is real either way — a list advertised
as live that lags five minutes behind writes is a defect — but the severity claim should be
accurate, and the fix's warning text depends on this distinction.

## Non-goals

- The watcher's revalidate path re-runs `target.query` without re-capturing; deps are fixed at
  registration time. Out of scope.
- The other three `Live.list` constraints from the gap survey: `<li>`-only markup, patches dropped
  inside islands, and no `target` option.
- **Layout `load()` is not wrapped in `withDepCapture` at all** (`packages/routekit/src/page-render.ts`
  — the layout branch calls `lMod.load(tracker.proxied)` directly), so layout *scalar* live fields
  get no auto-deps either. Noticed during this survey; a separate defect, not fixed here. Note that
  the design below still gives layout **lists** auto-deps, because list capture is self-contained.

## 1. Where the deps come from

`materializeLiveLists` wraps each list's query execution in its own capture scope:

```ts
const { result: rows, tables } = await withDepCapture(
  () => store.executeLiveListQuery(meta.query),
);
```

`query` is required on every `Live.list` (`LiveListOptions` in `packages/live/src/list.ts`) and always
executes here, so this is the one point every list passes through.

### Why per-list capture, not the page's observed tables

Two alternatives were considered and rejected:

- **Union the page's `observedTables`** (an exact mirror of the scalar path). `initial` is
  *optional* on `LiveListOptions`, and the page's capture wraps only `module.load()` — the list's
  own query runs after it. A list that omits `initial` would therefore capture nothing and keep
  failing silently. Shipping a fix for a silent-failure bug that preserves a silent-failure case is
  not a fix.
- **Widen the capture boundary to enclose `materializeLiveLists`.** Closes the hole with a
  one-line move, but the list's tables then widen every *scalar* field's deps on the same page, so
  scalars revalidate on writes they have no interest in. Safe direction, real cost, and an
  invisible coupling that becomes its own bug report later.

Per-list capture also has a property neither alternative has: because the scope lives inside
`materializeLiveLists`, it behaves identically at both call sites — the page path and the layout
path — without depending on whether the caller established a capture scope. Given layout `load()`
establishes none, this matters.

## 2. How they reach registration

The captured tables ride on the value they describe rather than being threaded through call sites.

`LiveListMeta` (`packages/core/src/list.ts`) gains an optional field:

```ts
/** Tables observed while this list's own query ran, captured per-list in
 * materializeLiveLists. Unioned into dependsOn at registration unless
 * fsr.autoDeps is false. Absent when no capture ran. */
autoDeps?: string[];
```

`materializeLiveLists` already builds a fresh list through `cloneLiveListRows`; it attaches a meta
carrying `autoDeps`. Note `cloneLiveListRows` currently reuses the source meta **by reference**, so
this must construct a new meta object rather than mutate the shared one — mutating it would leak
per-request capture results onto a value other requests may hold.

`registerLiveLists` then unions at both existing `dependsOn:` sites:

```ts
const dependsOn = Array.from(new Set([
  ...meta.dependsOn,
  ...(input.autoDeps !== false ? meta.autoDeps ?? [] : []),
]));
```

Explicit deps are preserved and never replaced, matching the rule the scalar path already states.
`registerLiveLists` gains one `autoDeps?: boolean` input, passed from `kilnConfig?.fsr?.autoDeps`
at both call sites, so `fsr.autoDeps: false` opts a list out exactly as it opts a scalar out.

**Capture runs unconditionally**, even when auto-deps is disabled; only the union is gated. An
`AsyncLocalStorage` run plus a `Set` is not worth threading config into `materializeLiveLists` to
avoid, and it keeps that function's signature unchanged.

## 3. Killing the silence

`warnOnce` in `registerLiveLists`, keyed `live-list-no-deps:${route}:${name}`, when the final
`dependsOn` is empty. This is the half that matters most: the defect is filed as a bug rather than
a gap precisely because it is invisible.

The message states the real consequence, which differs by configuration. The value to branch on is
the **effective** revalidate — `meta.revalidate ?? input.defaultRevalidate` — the same expression
`registerLiveLists` already uses when building the target, not `meta.revalidate` alone:

- effective revalidate is `false` — the list **will never update**;
- otherwise — the list **refreshes only on the revalidate timer (~300s by default), not on writes**.

A list registered while `store` is absent also reaches here with no `autoDeps` (`materializeLiveLists`
returns early without a store), and warning in that case is correct — it has no deps and nothing
captured them.

It should also say why capture may have found nothing: a query built with plain `new SQL(url)` is
invisible to auto-deps by design (`packages/core/src/sql.ts`), and a dynamically-interpolated table
name is invisible to `extractTables` — the case `warnUnresolvedTableRef` already warns about. The
remedy in both cases is an explicit `dependsOn`.

## 4. Isolation and boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `LiveListMeta.autoDeps` (`packages/core/src/list.ts`) | Carries captured tables with the list value | Nothing |
| `materializeLiveLists` (`packages/routekit/src/live-registration.ts`) | Runs each list's query inside a capture scope; attaches `autoDeps` | `withDepCapture`, `FsrStore` |
| `registerLiveLists` (same file) | Unions explicit + auto deps, gates on config, warns when empty | `LiveListMeta` |

`materializeLiveLists` and `registerLiveLists` already live in one focused module and stay there;
no restructuring is warranted.

## 5. Verification

**The falsifying experiment is already on record, and this inverts it.** `.memory` documents that
deleting `dependsOn: 'activity'` from `apps/jags-list/pages/projects/[id]/activity.tsx` makes
`bun run test:live` fail on a 20s timeout. After this change, that deletion must make the suite
**pass** — auto-deps carrying what the explicit dep carried before.

Delete it permanently. jags-list is a test vehicle, and both the `dependsOn: 'activity'` line and
its "dependsOn is MANDATORY here" comment become false the moment this ships. Leaving them would
also mean the app never exercises the new path.

Unit tests, in `packages/routekit`:

- `materializeLiveLists` populates `autoDeps` from tables the list's query touched;
- a list that omits `initial` still gets deps (the case the rejected alternative would have missed);
- the union preserves an explicit `dependsOn` and adds to it;
- `autoDeps: false` suppresses the union but leaves explicit deps intact;
- two lists on one page do not contaminate each other's deps;
- an empty final dep list warns exactly once, and the message reflects `revalidate: false` when set.

Per project discipline: `bun run test:unit`, `bun run test:integration`, and `bun run build`.
jags-list suites must be run **one file at a time** — a single `bun test tests/` invocation collides
on Postgres connections, pre-existing on `main`.

## 6. Documentation

- Update the `Live.list` auto-deps entry in `.memory/bugs-active.md` §1 on completion, including the
  "never updates" correction above, and move it to `bugs-resolved.md`.
- ADR-018 records auto-deps; add a note there that list deps are captured per-list at
  materialization, since ADR-018 describes only the `load()`-scoped capture.
- `docs/agents/` — any guidance stating that `Live.list` requires an explicit `dependsOn` becomes
  wrong and must be updated.
