# FSR.js Project Roadmap

This roadmap documents completed milestones, active feature branches, and future development priorities.

## Completed Milestones (V1 Baseline)

- [x] **Field-Selective Rendering Engine**: Event-driven watcher and SSE hub to stream field-level updates.
- [x] **Layout-Aware Route Swapping**: Request headers (`X-PS-Present`) and attributes (`data-ps-layout`) to preserve structural wraps during inner content navigation.
- [x] **Live Lists (`Live.list` V1)**: Dynamic list reconciliation comparing keys (`replace-row`, `insert`, `move`, `remove`) in an embedded watcher setup.
- [x] **Acceptance Testing App**: Standalone address book example with persistent database mutations and transactional events.

---

## Active & Isolated Feature Branches

*   **`codex/kiln-v1-freshness`**: Holds implementation files for:
    *   **Image Handling**: A custom `/_image` endpoint leveraging `sharp` to support quality adjustment and resizing with disk-cache storage.
    *   **Localisation**: Dynamic translations (`KilnI18n`) powered by `@fluent/bundle` loading `.ftl` resources.
    *   **Offline/Service Worker**: Custom Service Worker templates to enable SWR and offline caching without Workbox.
*   **`list-kiln-features`**: Temporary scratch branch to test scaffolding and run validation routines.

---

## Development Backlog & Next Steps

### Phase 1: Compile & Test Green-lighting (Critical Path)
1.  **Resolve setBakedPaths Type Mismatch**: Correct the `setBakedPaths` signature in [packages/engine/src/store.ts](file:///Users/jagjeet/Development/workspaces/Kiln/packages/engine/src/store.ts#L349) to allow `null` for `htmlPath` or fix [packages/routekit/src/boot.ts](file:///Users/jagjeet/Development/workspaces/Kiln/packages/routekit/src/boot.ts#L303) to supply a default route path.
2.  **Mock Store Implementation**: Add the missing `setBakedPaths` method to the unit test mock store in `packages/routekit/src/boot.test.ts`.
3.  **Fix Package-Wide No-Emit Errors**: Align typescript buffer typings, fix `drizzle-orm` / `bun-sql` dependencies, and fix CLI file system imports.

### Phase 2: Configuration & Hook Hardening (Completed)
1.  [x] **Remove Hardcoded Absolute Paths**: Replaced all hardcoded absolute repository paths inside `.claude/settings.json`, `.codex/config.toml`, `.codex/hooks.json`, `.gemini/settings.json`, `.mcp.json`, `.opencode.json`, `.vscode/mcp.json`, and Gemini shell hooks with relative (`.`) paths.
2.  [x] **Standardise Post-Tool Git Hooks**: Created and registered executable Git `post-commit` and `post-merge` hooks running `code-review-graph update`.

### Phase 3: Feature Branch Consolidation
1.  **Merge i18n & Images**: Review type safety and merge the localisation (`KilnI18n`) and image manipulation (`/_image`) features from the `codex/kiln-v1-freshness` branch into the `main` branch.
2.  **Export Client Assets**: Standardise package exports for `@kiln/client` so that `silcrow.js` is resolvable under monorepo workspace dependencies.

### Phase 4: Hardening & Scalability
1.  **Cache Partitioning (Personalisation)**: Introduce key namespaces or user session scopes for cached page artifacts. Since promoted paths bypass `load()`, the cache must be partitioned to prevent serving cached user-specific data to other visitors.
2.  **External Watcher Pipeline**: Transition the watcher to execute in a decoupled, separate thread/process instead of running embedded in the application thread.
3.  **Fine-Grained Debounce Scheduling**: Reconcile Redis watcher sweeps so that debounce sweeps correspond precisely to individual field invalidation windows rather than coarse intervals.
