# Known Bugs, Blockers, & Type Errors

This file tracks compiler blockers, runtime issues, and type mismatches currently present in the codebase.

## 1. Type Mismatches & Compiler Errors

*   **`store.setBakedPaths` Nullability Conflict**:
    *   **File**: [packages/routekit/src/boot.ts#L303](file:///Users/jagjeet/Development/workspaces/Kiln/packages/routekit/src/boot.ts#L303)
    *   **Description**: In `boot.ts`, the page handler calls `await store.setBakedPaths(req.path, null, jsonPath)`. However, the definition of `setBakedPaths` in [store.ts](file:///Users/jagjeet/Development/workspaces/Kiln/packages/engine/src/store.ts#L349) defines `htmlPath` as a non-nullable `string` type (`htmlPath: string`). This results in a TypeScript compilation error.
    *   **Impact**: Blocks clean monorepo builds.
*   **Missing `setBakedPaths` on Test Double**:
    *   **File**: [packages/routekit/src/boot.test.ts](file:///Users/jagjeet/Development/workspaces/Kiln/packages/routekit/src/boot.test.ts)
    *   **Description**: The mock store double used for testing in `boot.test.ts` does not implement the `setBakedPaths` method.
    *   **Impact**: Causes unit tests inside `routekit` to fail when executing.
*   **Workspace-Wide `tsc` No-Emit Compilation Failures**:
    *   No-emit compiler checks fail across several packages:
        *   `packages/adapter-elysia`: Issues with binary `Buffer.from` typings.
        *   `packages/engine`: Typo or version mismatch regarding `drizzle-orm` and `bun-sql` dependencies and imports.
        *   `packages/routekit`: Type conflicts with the `CacheProvider` interface comparison.
        *   `packages/cli`: Missing file system (`fs`) module imports, and stale references to the `startKiln` configurations.
        *   `test-app`: Imports from `@kilnjs/react` which is obsolete (should be `@kiln/react`), and outdated `startKiln` option configurations.

---

## 2. Infrastructure & Integration Test Issues

*   **Database Invalidation Integration Failures**:
    *   **File**: `packages/engine/src/list-store.test.ts`
    *   **Description**: Integration database tests require a live PostgreSQL connection. If `DATABASE_URL` is not provided in the environment (or missing from `.env` in `test-app/`), tests crash.
    *   **Impact**: `bun run test:integration` crashes if the local database environment is not pre-configured.

---

## 3. Scaffolder & Asset Injection Inconsistencies

*   **Scaffold Name Drift**:
    *   **File**: `packages/create-kiln` template files
    *   **Description**: The scaffolder generates imports referencing old names such as `Fsr.js`, `fsr`, and `startFsr` instead of the updated `kiln` and `startKiln`.
*   **Stale Asset Links**:
    *   **Description**: `routekit` injects `/_kiln/client.js` or `/silcrow.js` but the corresponding packages (`@kiln/client`) do not export this cleanly, leading to resource fetching errors.

---

## 4. Playwright E2E Skips
*   The Playwright testing suite inside `examples/address-book` has an intentional desktop browser skip configured in its test suite that needs monitoring.
