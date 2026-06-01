# Graph Report - fsr  (2026-06-01)

## Corpus Check
- 64 files · ~34,071 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 661 nodes · 920 edges · 59 communities (54 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `813e4ca0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 51|Community 51]]

## God Nodes (most connected - your core abstractions)
1. `FsrStore` - 27 edges
2. `navigate()` - 21 edges
3. `RedisCache` - 20 edges
4. `FsrWatcher` - 19 edges
5. `warn()` - 18 edges
6. `FSR — Field-Selective Rendering: Implementation Plan` - 17 edges
7. `FSR — Field-Selective Rendering: Implementation Plan` - 17 edges
8. `patch()` - 14 edges
9. `Phase 12 — Optimistic mutations + mutation-id envelope` - 14 edges
10. `connectSseHub()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `startDbNotificationPipeline()`  [INFERRED]
  test-app/src/main.ts → packages/engine/src/db-notify.ts
- `IndexPage()` --calls--> `useSilcrowForm()`  [INFERRED]
  test-app/pages/index.tsx → packages/react/src/hooks.ts
- `main()` --calls--> `startKiln()`  [INFERRED]
  test-app/src/main.ts → packages/routekit/src/boot.ts
- `main()` --calls--> `startPilcrow()`  [INFERRED]
  test-app/src/main.ts → packages/routekit/src/boot.ts
- `useSilcrowResource()` --calls--> `use()`  [INFERRED]
  packages/react/src/hooks.ts → packages/client/src/silcrow.js

## Communities (59 total, 5 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (28): escapeHtml(), findSLiveContentRange(), findSLiveSlots(), injectFsrSlots(), runTests(), InvalidatePayload, PatchPayload, startDbNotificationPipeline() (+20 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (45): abortMap, applyFragment(), applyHeadTemplate(), BLOCKED_ATOM_KEYS, buildMaps(), createSseHub(), DEBUG, destroy() (+37 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (47): Background, code:block1 (promote_after = 0 or absent  → SSG  (bake at startup, surgic), code:rust (use pilcrow::live::*;), code:rust (pub struct Props {), code:html (<!-- Static field — baked directly, no slot -->), code:block13 (ticket_list__42__status), code:html (<span s-live="ticket_list__42__status">Open</span>), code:json ({) (+39 more)

### Community 3 - "Community 3"
Cohesion: 0.05
Nodes (40): code:block31 (1. Client generates mutationId = crypto.randomUUID() per opt), code:rust (#[derive(Debug)]), code:rust (impl SilcrowEvent {), code:rust (EventKind::Patch { data, target, mutation_id } => match data), code:rust (#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)), code:rust (define_string_header!(SilcrowMutationId, "silcrow-mutation-i), code:rust (struct CommonParts {), code:rust (let mutation_id = parts) (+32 more)

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (33): actions, IndexPage(), appendActionName(), KilnReactContext, KilnReactContextValue, KilnReactProvider(), PilcrowReactContext, PilcrowReactContextValue (+25 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (25): appRequire, buildActionHandler(), buildPageHandler(), injectFsrScriptTag(), React, ReactDOMServer, startKiln(), startPilcrow() (+17 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (10): bodyLimit(), csrf(), FORM_CONTENT_TYPES, layoutIntercept(), timeout(), ElysiaAdapter, ElysiaResponseImpl, handleElysiaResponse() (+2 more)

### Community 7 - "Community 7"
Cohesion: 0.1
Nodes (14): DependencyKey, LiveProp, LiveTarget, ActionHandler, KilnRequest, KilnResponse, LiveFieldMeta, LoadResult (+6 more)

### Community 8 - "Community 8"
Cohesion: 0.11
Nodes (16): BackendConfig, CacheConfig, CacheProvider, ClientRuntimeConfig, DeepPartial, DEFAULT_CONFIG, FsrConfig, I18nConfig (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (19): buildFetchOptions(), cacheGet(), cacheSet(), collectLayoutPatterns(), getTarget(), getTimeout(), go(), hideLoading() (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (18): bindElementToScope(), bustCacheOnMutation(), evictPrefetch(), extractHTML(), initScopeBindings(), patch(), prepareSwapContent(), processToasts() (+10 more)

### Community 12 - "Community 12"
Cohesion: 0.2
Nodes (17): applyLivePatchPayload(), confirmOptimistic(), connectSseHub(), dispatchWsMessage(), finalizeNavigation(), hasPendingMutationForTarget(), invalidate(), normalizeSSEEndpoint() (+9 more)

### Community 13 - "Community 13"
Cohesion: 0.14
Nodes (4): AppError, AppResult, HookError, StartupError

### Community 14 - "Community 14"
Cohesion: 0.19
Nodes (14): connectWsHub(), createWsHub(), disconnectLive(), getOrCreateWsHub(), normalizeWsEndpoint(), openWsLive(), pauseLiveState(), reconnectLive() (+6 more)

### Community 15 - "Community 15"
Cohesion: 0.15
Nodes (12): Data model, DB — single table, Dependency key derivation, HTML shell attribute, Invalidation, JSON baking, List rows, Locked decisions (+4 more)

### Community 16 - "Community 16"
Cohesion: 0.17
Nodes (10): Background, code:block1 (promote_after = 0 or absent  → SSG  (bake at startup, surgic), code:block36 (live.rs), code:block37 (Phase 1   DB migration), code:rust (/// Implement this on any `Live` struct defined in a route's), Complete developer surface (nothing else needed), FSR — Field-Selective Rendering: Implementation Plan, Implementation order (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.18
Nodes (11): code:html (<!-- Static field — baked directly -->), code:toml ([cache]), code:rust (dep!(tickets, id, ticket_id)             // typed Dependency), code:rust (use pilcrow::live::*;), code:rust (// Optional JSON opt-in — only LiveProps fields baked into J), Developer surface — complete, nothing else needed, `live.rs`, Macros (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.18
Nodes (11): App startup (promote_after = 0 or absent), code:block13 (Request arrives), code:block14 (Request arrives), code:block15 (pilcrow::invalidate!(dep!(tickets, id, 123))), code:block16 (pilcrow_start()), code:block17 (10 Pilcrow pods running), Dep change → surgical patch (pub/sub driven), Multi-instance scaling (+3 more)

### Community 19 - "Community 19"
Cohesion: 0.2
Nodes (9): code:block18 (SSG              ★★★★★  Pilcrow matches — promoted routes ar), code:block5 (promote_after = 0 or absent  → SSG  (bake at startup, surgic), code:block7 (pages/), Comparison with other rendering models, File convention, FSR — Field-Selective Rendering: Design Decisions & DX Recap, Rendering lifecycle — single unified model, What FSR is (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.2
Nodes (10): code:block1 (Redis     = serve layer + pub/sub bus (REQUIRED — hot, fast,), code:block2 (pilcrow:html:<route>          → STRING  full baked HTML), code:block3 (pilcrow:invalidate   → watcher subscribers receive { route, ), code:toml ([cache]), Infrastructure (LOCKED), Layer roles, Redis key structure, Redis pub/sub channels (+2 more)

### Community 21 - "Community 21"
Cohesion: 0.29
Nodes (4): buildCommand, devCommand, __dirname, mainCommand

### Community 22 - "Community 22"
Cohesion: 0.29
Nodes (7): createAtom(), getOrCreateAtom(), init(), initLiveElements(), prefetchRoute(), seedAtomsFromSSR(), unbindElementAtoms()

### Community 23 - "Community 23"
Cohesion: 0.33
Nodes (7): hardenBlankTargets(), hasSafeProtocol(), hasSafeSrcSet(), isOnHandler(), sanitizeTree(), setValue(), throwErr()

### Community 25 - "Community 25"
Cohesion: 0.33
Nodes (5): distDir, gz, raw, src, watcher

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (5): graphify, Key Tools, MCP Tools: code-review-graph, When to use graph tools FIRST, Workflow

### Community 28 - "Community 28"
Cohesion: 0.4
Nodes (4): Key Tools, MCP Tools: code-review-graph, When to use graph tools FIRST, Workflow

### Community 29 - "Community 29"
Cohesion: 0.4
Nodes (4): Key Tools, MCP Tools: code-review-graph, When to use graph tools FIRST, Workflow

### Community 30 - "Community 30"
Cohesion: 0.4
Nodes (5): code:block25 (App loads), code:block26 (SUBSCRIBE pilcrow:patch (Redis)), code:json ({ "ticket_status": "In Progress" }), code:json ({ "ticket_list__42__status": "Closed" }), Phase 8 — SSE push via Silcrow.js (Redis pub/sub fanout)

### Community 31 - "Community 31"
Cohesion: 0.4
Nodes (5): code:html (<!-- Static field — baked directly, no slot -->), code:block13 (ticket_list__42__status), code:html (<span s-live="ticket_list__42__status">Open</span>), code:json ({), Phase 5 — HTML baking and `s-live` shell slots

### Community 32 - "Community 32"
Cohesion: 0.4
Nodes (4): Key Tools, MCP Tools: code-review-graph, When to use graph tools FIRST, Workflow

### Community 33 - "Community 33"
Cohesion: 0.5
Nodes (4): getStableId(), mergeOrRemoveItem(), reconcile(), resolvePath()

### Community 34 - "Community 34"
Cohesion: 0.5
Nodes (4): code:rust (pub struct RedisCache {), code:block23 (GET pilcrow:html:<route>), code:rust (fn pilcrow_start() {), Phase 7b — Redis cache layer

### Community 35 - "Community 35"
Cohesion: 0.5
Nodes (4): code:rust (use pilcrow::live::*;), code:rust (pub struct Props {), code:block9 (pages/), Phase 4 — `live.rs` file convention

### Community 36 - "Community 36"
Cohesion: 0.5
Nodes (4): code:rust (// Targeted — by dependency key), code:sql (UPDATE pilcrow_fsr), code:sql (UPDATE pilcrow_fsr), Phase 6 — Invalidation

### Community 37 - "Community 37"
Cohesion: 0.5
Nodes (4): code:toml ([cache]), code:rust (pub struct WatcherContext {), code:block21 (SUBSCRIBE pilcrow:invalidate), Phase 7 — Watcher process (Redis pub/sub driven)

### Community 38 - "Community 38"
Cohesion: 0.5
Nodes (4): code:rust (/// A field whose value is tracked, cached, and live-patched), code:rust (/// dep!(tickets, id, ticket_id)), code:rust (#[pilcrow::promote_after(50)]), Phase 2 — `LiveProps<T>` type and `DependencyKey`

### Community 39 - "Community 39"
Cohesion: 0.5
Nodes (4): code:rust (#[derive(Debug, Clone, PartialEq, Eq, Default)]), code:rust (pub const FSR_JSON: bool = true;   // in page.rs — opt in to), code:block31 (FSR_JSON = true  +  STREAMING = true   → build error (incomp), Phase 9 — `page_options.rs` integration

### Community 40 - "Community 40"
Cohesion: 0.67
Nodes (3): code:sql (UPDATE pilcrow_fsr), code:sql (UPDATE pilcrow_fsr), Phase 10 — `pilcrow_fsr` DB hit count and promotion

### Community 41 - "Community 41"
Cohesion: 0.67
Nodes (3): code:block2 (crates/core         — AppError, AppResult, PilcrowConfig), code:block3 (crates/runtime/src/fsr/          — LiveProps, DependencyKey,), Crate / file map (existing, do not change)

### Community 42 - "Community 42"
Cohesion: 0.67
Nodes (3): code:rust (pub use pilcrow_runtime::fsr::{), code:rust (use pilcrow::live::*;), Phase 11 — re-exports and developer surface

## Knowledge Gaps
- **246 isolated node(s):** `pilcrowFsr`, `actions`, `AppResult`, `HookError`, `DependencyKey` (+241 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `use()` connect `Community 4` to `Community 1`, `Community 12`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `FSR — Field-Selective Rendering: Implementation Plan` connect `Community 2` to `Community 3`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `pilcrowFsr`, `actions`, `AppResult` to the rest of the system?**
  _246 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._