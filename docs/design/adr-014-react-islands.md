# ADR-014 Implementation Spec — React Islands over Baked HTML (Store-Bridge Hydration)

Status: ACCEPTED 2026-07-10 · Decision record: `.memory/decisions.md` ADR-014
Audience: any implementer (human or model). This document is deliberately
prescriptive — exact file paths, signatures, and acceptance criteria — so the
work can be executed phase by phase without re-deriving design decisions.

---

## 1. Goal

Let interactive parts of a Kiln page be real React components in the browser
(so React-ecosystem libraries work: Radix, MUI, react-hook-form, Motion,
charting, TanStack Query) **without** giving React ownership of the page.
Baked HTML stays canonical; React hydrates only declared *islands*; all live
data crosses one seam: the Silcrow store.

### Non-goals (explicitly out of scope — do not build these)

- Full-page hydration / app-shell React (contradicts FSR; see ADR-013).
- Streaming SSR / Suspense boundaries (ADR-013).
- Nested islands (an island inside another island) — v1 skips inner markers.
- React Router or any client router integration — silcrow owns navigation.
- Server Components.
- Per-island partial re-bake on the server.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Island** | A React component authored in the app's `islands/` directory, SSR'd into the baked HTML at bake time and hydrated client-side as its own React root. |
| **Marker** | The wrapper `<div data-kiln-island=...>` emitted around an island's SSR output. |
| **Bootstrap** | `packages/client/src/islands.js` — the react-free script that finds markers and triggers hydration. |
| **Manifest** | `kiln-islands.json` — maps island name → current chunk URL. Fetched with `no-store` at runtime (this is the version-skew defense). |
| **Seed** | `window.__kiln_seed` — the page's baked JSON snapshot data, already injected by `injectJsonSeed`. |
| **Store bridge** | The rule that data flows into islands via Silcrow atoms (`Live` fields with `target: 'store'`), never via silcrow DOM patches. |

---

## 3. Invariants (each one is testable; tests are listed in §12)

1. **I-1 Canonical HTML**: With JavaScript disabled, every page renders fully
   from baked HTML. Islands appear as their SSR output, just not interactive.
2. **I-2 Island-only React**: `hydrateRoot` is called only on island markers.
   No code path may hydrate `document`, `body`, or a layout element.
3. **I-3 Patch exclusion**: silcrow's DOM patchers (scalar + list) never
   modify any element inside a `[data-kiln-island]` subtree.
4. **I-4 Store-only liveness inside islands**: a `LiveProp` with
   `target: 'dom'` (default) rendered inside an island is a developer error —
   the framework warns at bake time and does not auto-tag it.
5. **I-5 Single data source**: hydration props come from the marker's
   `data-kiln-props` (baked values); post-hydration freshness comes only from
   store subscriptions. No island fetches its own initial data.
6. **I-6 Skew-safe**: markers embed island *names*, never chunk URLs. The
   bootstrap resolves names through the always-fresh manifest, so week-old
   cached HTML hydrates against today's bundles. A missing/failed chunk
   triggers at most one guarded full reload, then degrades to static HTML.
7. **I-7 Fail-static**: any error during import/hydration leaves the baked
   HTML untouched and emits a `kiln:island-error` CustomEvent on `window`.
8. **I-8 One codec**: everything embedded in HTML (seed, island props) goes
   through `encodeSeed`/`decodeSeed` from `@kiln/core` — never a bare
   `JSON.stringify` (XSS + future-codec discipline).

---

## 4. Authoring API (what app developers write)

```
app-root/
  pages/
    dashboard.tsx
  islands/            ← NEW convention: sibling of pages/
    Counter.tsx       ← file basename === island name (enforced by build)
```

```tsx
// islands/Counter.tsx — a perfectly ordinary React component, default export.
export default function Counter({ start }: { start: number }) {
  const [n, setN] = useState(start);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
```

```tsx
// pages/dashboard.tsx
import Counter from '../islands/Counter.js';
import { island } from '@kiln/react';

// name MUST equal the islands/ file basename. Options are optional.
const CounterIsland = island(Counter, 'Counter', { hydrate: 'visible' });

export async function load(req: KilnRequest) {
  return { startCount: 41, activeUsers: Live.value(0, ['sessions'], { target: 'store' }) };
}

export default function Dashboard({ startCount }: Awaited<ReturnType<typeof load>>) {
  return (
    <main>
      <h1>Dashboard</h1>
      <CounterIsland start={startCount} />
    </main>
  );
}
```

`island(Component, name, opts?)`:

```ts
export type HydrateStrategy = 'load' | 'idle' | 'visible';
export interface IslandOptions { hydrate?: HydrateStrategy }   // default 'load'
export function island<P extends Record<string, unknown>>(
  Component: React.ComponentType<P>,
  name: string,
  opts?: IslandOptions,
): React.ComponentType<P>;
```

Rules for authors (also enforced/warned per §7 and §12):
- Island props must be seed-codec-safe (plain JSON data — the dev-mode
  validator warns on `Date`/`Map`/`Set`/`undefined`/functions).
- Live data inside an island: declare the field with `target: 'store'` in
  `load()`, read it in the island with `useLiveValue()` (§9).
- Islands must not read `window.location` to route; use plain `<a>` links —
  silcrow's enhanced navigation handles them.

---

## 5. Server side: marker rendering

### 5.1 New file: `packages/react/src/island.tsx`

```tsx
import { createElement, type ComponentType } from 'react';
import { encodeSeed } from '@kiln/core';

export type HydrateStrategy = 'load' | 'idle' | 'visible';
export interface IslandOptions { hydrate?: HydrateStrategy }

export function island<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
  name: string,
  opts: IslandOptions = {},
): ComponentType<P> {
  const hydrate = opts.hydrate ?? 'load';
  function IslandWrapper(props: P) {
    // Server-only in practice (pages are never shipped to the client), but
    // must be render-safe anywhere. The marker div uses display:contents so
    // it never affects layout.
    return createElement(
      'div',
      {
        'data-kiln-island': name,
        'data-kiln-hydrate': hydrate,
        // encodeSeed escapes '<'; React escapes quotes/ampersands when it
        // serializes the attribute — no double-escaping needed here.
        'data-kiln-props': encodeSeed(props),
        style: { display: 'contents' },
      },
      createElement(Component, props),
    );
  }
  IslandWrapper.displayName = `Island(${name})`;
  return IslandWrapper;
}
```

Export `island`, `HydrateStrategy`, `IslandOptions` from
`packages/react/src/index.ts`.

Notes for the implementer:
- The marker div is the hydration container: its children are exactly
  `<Component {...props}/>`'s SSR output, which is what
  `hydrateRoot(container, element)` requires. Do not put anything else
  (comments, scripts) inside the marker.
- Multiple instances of the same island on one page are fine — each marker
  hydrates independently.
- Because markers are baked into cached HTML, `data-kiln-props` holds
  bake-time values. That is by design (I-5).

### 5.2 Bake-time guard in `packages/routekit/src/boot.ts`

Two additions:

1. **`applyLivePropMarkers` skips store-target fields.** In the loop, before
   auto-tagging, read the field's delivery target
   (`(raw as any).deliveryTarget`) and `continue` when it is `'store'` —
   store-target fields must not get `s-live` DOM slots at all.

2. **Warn on dom-target live slots inside islands (I-4).** After the page
   fragment is fully marked (right after `markedPageHtml` is computed), run:

```ts
function warnDomLiveInsideIslands(html: string, route: string): void {
  // Cheap scan: for each island marker region, look for s-live= inside it.
  const re = /<div[^>]*data-kiln-island="([^"]+)"[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const fragment = extractLayoutFragmentLike(html, m.index); // balanced-div slice, reuse extractLayoutFragment's technique
    if (fragment && fragment.includes('s-live="')) {
      warnOnce(
        `island-dom-live:${route}:${m[1]}`,
        `[kiln] route "${route}": island "${m[1]}" contains a dom-target LiveProp slot. ` +
          `Inside an island, use target: 'store' and useLiveValue() — silcrow will not patch DOM here.`,
      );
    }
  }
}
```

   Implementer note: `extractLayoutFragment` in boot.ts already implements
   balanced-`<div>` slicing from a marker index; factor its core into a shared
   helper rather than duplicating the depth-counting loop.

3. **Conditional bootstrap injection.** In step 9 of `buildPageHandler`
   (where silcrow.js is injected), add:

```ts
if (html.includes('data-kiln-island') && !html.includes('src="/_silcrow/islands.js"')) {
  html = injectKilnScript(html, '/_silcrow/islands.js');
}
```

   `injectKilnScript` already dedupes; the extra `includes` check just avoids
   the call. Note the cached promoted shell will contain this tag — good,
   that's exactly what we want (cache-hit requests need it too).

### 5.3 Snapshot version bump

In `packages/engine/src/baking.ts`, bump `BAKED_RENDER_VERSION` from `1` to
`2` in the same PR that ships marker rendering. `normalizeSnapshot` already
rejects mismatched versions, which forces a clean re-bake of every cached
route on deploy — old snapshots have no island metadata and must not be
materialized against new expectations.

---

## 6. Build pipeline: chunks + manifest

### 6.1 Virtual hydration wrappers (keeps the bootstrap React-free)

For each `islands/<Name>.tsx`, the build defines a virtual module:

```ts
// virtual:kiln-island/<Name>
import { hydrateRoot } from 'react-dom/client';
import { createElement } from 'react';
import Component from '<abs path to islands/<Name>.tsx>';
export function hydrate(el, props) {
  return hydrateRoot(el, createElement(Component, props));
}
```

React/ReactDOM get code-split by Vite into a shared chunk automatically —
do not hand-roll vendor splitting.

### 6.2 Extend `packages/routekit/src/vite-plugin.ts`

Add to `kilnVitePlugin` (or a sibling `kilnIslandsPlugin` exported from the
same file and registered by the CLI in both dev and build):

- `resolveId`/`load` for the `virtual:kiln-island/<Name>` scheme, resolving
  `<Name>` against `<appRoot>/islands/<Name>.{tsx,ts,jsx,js}` (error if the
  file is missing).
- Build mode: add each virtual module as a Rollup input named
  `islands/<Name>`, and emit `dist/client/kiln-islands.json`:

```json
{
  "version": "<sha1 of the sorted name→fileName pairs>",
  "islands": { "Counter": "/_kiln/client/islands/Counter-<hash>.js" }
}
```

  (Use `generateBundle` to walk the bundle for chunks whose `name` starts
  with `islands/` and `this.emitFile({ type: 'asset', fileName: 'kiln-islands.json', ... })`.)
- Dev mode: expose the same JSON via `configureServer` middleware at
  `/kiln-islands.json` on the Vite server, with URLs of the form
  `/_kiln/client/@id/__x00__virtual:kiln-island/<Name>` — **implementer
  note:** verify the exact dev URL Vite serves for virtual ids in the Vite
  major version in use (`import.meta.resolve` on the dev server, or use
  `server.moduleGraph`); write one integration test against the dev server
  rather than trusting the URL shape.

### 6.3 CLI wiring (`packages/cli/src/cli.ts`)

- `dev`: `kilnVitePlugin` already runs; islands support comes with it. Add an
  Elysia route `GET /_kiln/islands.json` that proxies
  `http://localhost:5173/kiln-islands.json` (same pattern as the existing
  `/_kiln/client/*` proxy).
- `build`: include the islands plugin in the `viteBuild` plugins array so the
  manifest and chunks land in `dist/client/`.
- `start`: `startKiln` serves the manifest (§6.4) — nothing extra.

### 6.4 Serving in `startKiln` (`packages/routekit/src/boot.ts`)

```ts
// After asset registration. no-store is the version-skew defense (I-6):
// stale cached HTML must always resolve island names against the manifest
// of the currently deployed build.
adapter.registerPage('/_kiln/islands.json', [], async (_req, res) => {
  res.headers['cache-control'] = 'no-store';
  const f = Bun.file('dist/client/kiln-islands.json');
  if (await f.exists()) { res.json(JSON.parse(await f.text())); return; }
  res.json({ version: 'none', islands: {} });
});
```

Also register the bootstrap asset next to silcrow:

```ts
const islandsPath = fileURLToPath(import.meta.resolve('@kiln/client/islands.js'));
adapter.registerAsset('/_silcrow/islands.js', islandsPath);
```

(Wrap in the same try/catch as the silcrow registration; add
`"./islands.js": "./dist/islands.js"` to `packages/client/package.json`
exports and build it in `packages/client/build.ts` alongside silcrow.)

---

## 7. Client bootstrap: `packages/client/src/islands.js`

Plain JS module (ESM, served as `<script type="module">` via
`injectKilnScript` — **implementer note:** `injectKilnScript` emits
`<script src defer>`; either extend it with an optional `{module: true}` arg
or add a sibling `injectModuleScript` in `assembler.ts`; module scripts are
deferred by default).

Required behavior, in order:

```js
// Pseudocode contract — implement exactly this state machine.
const RELOAD_GUARD = 'kiln-island-reload:' + location.pathname;
let manifestPromise = null;

function getManifest() {
  // no-store fetch, memoized per page load
  manifestPromise ??= fetch('/_kiln/islands.json', { cache: 'no-store' }).then(r => r.json());
  return manifestPromise;
}

function decodeProps(el) {
  // data-kiln-props was written via encodeSeed; JSON.parse reads the
  // < escapes transparently. Attribute value arrives already
  // HTML-unescaped from the DOM API.
  return JSON.parse(el.getAttribute('data-kiln-props') || '{}');
}

async function hydrateIsland(el) {
  if (el.__kilnHydrated) return;            // idempotency
  el.__kilnHydrated = true;
  const name = el.getAttribute('data-kiln-island');
  try {
    const manifest = await getManifest();
    const url = manifest.islands[name];
    if (!url) throw new Error(`island "${name}" not in manifest`);
    const mod = await import(url);
    mod.hydrate(el, decodeProps(el));
    sessionStorage.removeItem(RELOAD_GUARD);
    el.setAttribute('data-kiln-hydrated', '');
  } catch (err) {
    // I-6: one guarded reload for skew, then fail static (I-7).
    if (!sessionStorage.getItem(RELOAD_GUARD)) {
      sessionStorage.setItem(RELOAD_GUARD, '1');
      location.reload();
      return;
    }
    window.dispatchEvent(new CustomEvent('kiln:island-error', { detail: { name, error: String(err) } }));
    console.error('[kiln] island hydration failed:', name, err);
  }
}

function schedule(el) {
  const strategy = el.getAttribute('data-kiln-hydrate') || 'load';
  if (strategy === 'visible' && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.disconnect(); hydrateIsland(el); }
    });
    io.observe(el);
  } else if (strategy === 'idle' && 'requestIdleCallback' in window) {
    requestIdleCallback(() => hydrateIsland(el));
  } else {
    hydrateIsland(el);
  }
}

function boot() {
  document.querySelectorAll('[data-kiln-island]').forEach((el) => {
    // v1: skip nested islands — outermost marker wins.
    if (el.parentElement && el.parentElement.closest('[data-kiln-island]')) return;
    schedule(el);
  });
}
// run on DOMContentLoaded (or immediately if already loaded), and re-run
// after silcrow fragment navigation (listen for silcrow's navigation event;
// if none exists yet, patch _subscribe-style: also run boot() on popstate
// and pushState/replaceState wraps, mirroring live-client-script.ts).
```

### 7.1 Silcrow patch exclusion (I-3)

In **both** `packages/client/src/silcrow.js` and
`packages/routekit/src/live-client-script.ts`, every DOM patch site
(`_patchScalar`'s querySelectorAll loop, `_patchList`'s container lookup, and
the fallback object patcher) must skip elements for which
`el.closest('[data-kiln-island]')` is non-null. One shared guard function per
file; do not fork behavior between the two clients.

---

## 8. Seed codec: `packages/core/src/seed-codec.ts` (new)

```ts
/** Single serialization boundary for anything embedded in HTML (I-8). */
export function encodeSeed(value: unknown): string;   // JSON.stringify + '<' → <
export function decodeSeed<T = unknown>(text: string): T;  // JSON.parse
/** Dev-only deep walk; console.warn for values JSON silently corrupts:
 *  Date, Map, Set, undefined (dropped), function, bigint, NaN/Infinity. */
export function assertSeedSafe(value: unknown, context: string): void;
```

- Export from `packages/core/src/index.ts`.
- `packages/engine/src/assembler.ts`: `toScriptJson` becomes a re-export of
  `encodeSeed` (keep the name exported for compat; engine already depends on
  `@kiln/core` — verify `packages/engine/package.json` lists it, add if not).
- `injectJsonSeed` and `injectFsrSlots` keep working unchanged through the
  re-export.
- `boot.ts` calls `assertSeedSafe(snapshotProps, req.path)` before
  `injectJsonSeed` when `process.env.NODE_ENV !== 'production'`.
- Reserve (document, don't implement) `codecVersion: 2` = devalue-style
  codec for Date/Map/Set support; when introduced it must bump
  `BAKED_SNAPSHOT_VERSION`.

---

## 9. Store bridge hook: `useLiveValue`

New hook in `packages/react/src/hooks.ts`:

```ts
/**
 * Read a live field inside an island. Initial value comes from the baked
 * seed; updates arrive via the Silcrow store (fields declared with
 * target: 'store'). Never reads or writes the DOM.
 */
export function useLiveValue<T>(field: string, fallback?: T): T;
```

Implementation contract:
- Initial: `window.__kiln_seed?.[field] ?? fallback`.
- Subscribe: `window.Silcrow.subscribe('live:' + field, cb)` using
  `useSyncExternalStore` (match the existing `useSilcrowAtom` implementation
  style in the same file).
- Publisher side: in **both** SSE clients (silcrow.js's SSE handler and
  `live-client-script.ts`), when a scalar patch arrives, additionally call
  `window.Silcrow.publish('live:' + field, value)` when `window.Silcrow`
  exists. (DOM patching for that field is independently governed by I-3/I-4.)
- **Implementer note:** `Silcrow.subscribe(scope, fn)` / `Silcrow.publish` /
  `Silcrow.snapshot(scope)` already exist in silcrow.js (~lines 225, 2787).
  Read those implementations first and reuse their scope semantics; do not
  invent a parallel event bus.

---

## 10. Ecosystem adapters (deferred, design constraint only)

TanStack Query / Redux / etc. integrate **at the store**: hydrate their
caches from `window.__kiln_seed`, invalidate/refetch on `live:*` publishes.
They never own initial fetching (I-5). Ship later as separate packages
(`@kiln/react-query` first); nothing in this ADR's phases depends on them —
but nothing may preclude them either (which is why `live:` publishes go
through the public `Silcrow.publish`).

---

## 11. Security notes

- `encodeSeed` escaping (I-8) covers script contexts; for the
  `data-kiln-props` attribute React performs attribute escaping when
  rendering the marker — both layers are required, neither alone suffices.
- Island props are visible in HTML source exactly like the seed — same
  secrecy rules apply: `load()` must not return secrets.
- The manifest endpoint reveals island names + hashed URLs; that is
  equivalent to any bundler's public asset graph. No auth needed.

---

## 12. Phased implementation plan

Execute phases in order; each ends with `tsc --noEmit` clean in all packages,
`bun run test:unit` green, and `bun run build` succeeding. Rebuild `dist/`
before testing cross-package behavior (see `.memory/bugs.md` — stale `dist/`
has silently invalidated test runs before).

### Phase 0 — seed codec
Files: `packages/core/src/seed-codec.ts` (new), `packages/core/src/index.ts`,
`packages/engine/src/assembler.ts` (re-export), `packages/routekit/src/boot.ts`
(dev-mode `assertSeedSafe`).
Tests (`packages/core/src/seed-codec.test.ts`):
- round-trips plain data; output contains no raw `<`;
- `decodeSeed(encodeSeed(x))` deep-equals `x` for JSON-safe `x`;
- `assertSeedSafe` warns (spy on `console.warn`) for `Date`, `undefined`,
  `Map`, function — silent for plain data.
Acceptance: engine's existing `assembler.test.ts` XSS test still passes
unmodified.

### Phase 1 — `island()` + bake-time guards
Files: `packages/react/src/island.tsx` (new), `packages/react/src/index.ts`,
`packages/routekit/src/boot.ts` (store-target skip in
`applyLivePropMarkers`, `warnDomLiveInsideIslands`, shared balanced-div
helper), `packages/engine/src/baking.ts` (`BAKED_RENDER_VERSION = 2`).
Tests:
- `packages/react/src/island.test.tsx`: SSR of an islanded component yields
  `data-kiln-island`, `data-kiln-hydrate`, decodable `data-kiln-props`, and
  the component's markup as the marker's children; props containing
  `</script>` produce no raw `<` in the attribute payload.
- `packages/routekit/src/boot.test.ts`: (a) a store-target LiveProp gets no
  `s-live` auto-tag; (b) a dom-target LiveProp rendered inside an island
  marker triggers the warnOnce (spy `console.warn`).
Acceptance: existing promoted-cache tests still pass (render-version bump
just forces re-bake, which the tests already tolerate as a cache miss).

### Phase 2 — build pipeline + serving
Files: `packages/routekit/src/vite-plugin.ts`, `packages/cli/src/cli.ts`,
`packages/routekit/src/boot.ts` (manifest route, islands.js asset,
conditional injection), `packages/client/build.ts` + `package.json`
(islands.js entry — the file lands in Phase 3; ship a stub `export {}` now so
wiring is testable).
Tests:
- vite plugin unit test: `load('virtual:kiln-island/Counter')` emits a module
  importing the island file and exporting `hydrate`;
- boot test: page HTML containing `data-kiln-island` gets exactly one
  `/_silcrow/islands.js` script tag; page without markers gets none;
- manifest route returns `{version:'none', islands:{}}` when no build exists.
Acceptance: `kiln build` in `test-app` (after adding `islands/Counter.tsx`)
emits `dist/client/kiln-islands.json` + a `Counter-*.js` chunk.

### Phase 3 — bootstrap + patch exclusion
Files: `packages/client/src/islands.js` (real implementation per §7),
`packages/client/src/silcrow.js` + `packages/routekit/src/live-client-script.ts`
(closest-island guard).
Tests (happy-dom, like `packages/react/src/hooks.test.tsx`):
- markers with `hydrate='load'` call the imported `hydrate(el, props)` with
  decoded props (mock `fetch` for the manifest and `import` via injectable
  loader — structure islands.js so the loader/fetch are overridable for
  tests, e.g. `window.__KILN_ISLANDS_TEST_HOOKS`);
- missing manifest entry → first failure sets the reload guard, second
  failure dispatches `kiln:island-error` and leaves DOM unchanged;
- scalar patch targeting a field whose only DOM occurrence is inside an
  island marker does not mutate it (test via live-client-script string eval,
  same technique as `live-client.test.ts`).
Acceptance (manual, `test-app`): `kiln dev`, visit a page with
`islands/Counter.tsx` — SSR text visible pre-hydration, button interactive
post-hydration, no hydration-mismatch warning in console.

### Phase 4 — store bridge + example + docs
Files: `packages/react/src/hooks.ts` (`useLiveValue`),
`packages/client/src/silcrow.js` + `live-client-script.ts` (`live:` atom
publish on scalar patches), `test-app/islands/Counter.tsx` +
`test-app/pages/islands-demo.tsx` (uses one static-prop island and one
`useLiveValue` field with `target:'store'`), `.memory/features.md` (new
"React Islands" section).
Tests:
- `hooks.test.tsx`: `useLiveValue` returns seed value initially and re-renders
  on `Silcrow.publish('live:field', v)`;
- extend the Phase-3 patch-exclusion test: the same SSE scalar patch that is
  DOM-ignored inside the island IS delivered via the `live:` publish.
Acceptance (manual): with Postgres+Redis running, a DB mutation updates the
`useLiveValue` field inside the island via SSE while silcrow never touches
the island's DOM.

### Definition of done (whole ADR)
- All invariants I-1…I-8 have at least one automated test.
- `test-app` islands demo works in `kiln dev` and after `kiln build && kiln start`.
- Skew drill: rename the built chunk file, reload the page → exactly one
  automatic reload attempt, then static HTML + `kiln:island-error`.
- `.memory/features.md` documents the authoring API and the four island
  rules from §4.

---

## 13. Alternatives considered (summary — full reasoning in ADR-014)

- **Full-page hydration (Next.js model)** — rejected: React would own the DOM,
  silcrow patches would be overwritten, promoted routes would re-run
  component code client-side, and FSR's cost model evaporates.
- **No React on the client (silcrow-only)** — rejected: locks out the
  React-dependent ecosystem, which is the explicit motivation.
- **Web-components wrapper per widget** — rejected: adds a second component
  model without removing the need for hydration or the store bridge.
