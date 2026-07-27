# Active Bugs, Blockers & Type Errors

Open **framework** issues only. Resolved history → [bugs-resolved.md](bugs-resolved.md). App-level bugs live under `apps/<app>/.memory/`, not here.

> **Last verified**: 2026-07-27 @ `758eb44` — `bun run test:unit` 208 pass / 51 skip / 0 fail; `bun run build` green across all packages. §1 findings below came from a source audit on that commit and are each verified against source or a live Postgres (noted per item). `test:integration` was NOT run (needs live PG/Redis).

---

## 1. Auto-Deps / Trigger Correctness (found 2026-07-27 audit)

### 1.1 `kiln_emit_event` breaks writes on any table without a BIGINT-castable `id` — HIGH

*   **Files**: `packages/engine/src/schema.ts:33-41`, installed by `packages/cli/src/sync-triggers.ts`
*   **Description**: The trigger function declares `record_id BIGINT` and assigns `NEW.id` / `OLD.id`
    unconditionally. Any trigger-attached table whose PK is not a bigint-castable `id` raises inside
    the trigger. Because it is `AFTER … FOR EACH ROW`, the error **aborts the application's write**,
    not just the invalidation.
*   **Verified** (live Postgres, `kilnjs_test`, scratch tables dropped after):
    *   UUID PK → `ERROR: invalid input syntax for type bigint: "7bd006e6-…"`
    *   No `id` column (composite/natural key) → `ERROR: record "new" has no field "id"`
*   **Impact**: `kiln sync-triggers` installs the trigger with **zero preconditions checked**, so
    pointing it at a UUID-keyed or junction table turns every INSERT/UPDATE/DELETE on that table
    into a hard failure, discovered only at runtime. UUID PKs and composite-key join tables are
    both common; this is the single largest adoption blocker in the audit.
*   **Fix direction**: read the id defensively (`to_jsonb(NEW)->>'id'` into a TEXT `record_id`), or
    make the id column configurable per `TriggerTableConfig`; **plus** a precondition check in
    `syncTriggers` that fails at install time with an actionable message instead of at first write.

### 1.2 Auto-deps lowercases table names, trigger depKeys are verbatim — silent under-invalidation — MED

*   **Files**: `packages/core/src/sql.ts:15` (lowercases), `packages/cli/src/sync-triggers.ts:33`
    (`depKey = t.depKey ?? t.table`, verbatim), `packages/engine/src/store.ts:231`
    (`WHERE ${depKey} = ANY(depends_on)`, exact string match)
*   **Verified**: `extractTables("SELECT * FROM Contacts")` → `["contacts"]`.
*   **Description**: `extractTables` lowercases every captured name; the trigger emits the depKey
    exactly as written in `kiln.config.ts`. A config using any uppercase (`table: 'Contacts'`, or a
    mixed-case `depKey`) therefore emits `'Contacts'` while auto-deps recorded `'contacts'` — the
    `= ANY(depends_on)` match never fires.
*   **Impact**: silent under-invalidation — stale data served with no error anywhere. Explicit
    `dependsOn` lists are unaffected (they're compared as written), so this only bites auto-deps,
    which is the path that is on by default.
*   **Fix direction**: normalize both sides (lowercase the depKey at emit or at compare), or have
    `sync-triggers` warn when a configured `table`/`depKey` is not already lowercase.

### 1.3 Redis SSE connection counter leaks on ungraceful shutdown — MED

*   **File**: `packages/engine/src/hub.ts:58-63` (INCR), `:267-273` (the only DECR)
*   **Description**: Admission does `INCR`; the matching `DECR` lives only in `fsrHubStream`'s
    `finally`. There is no TTL, no reconciliation, and no reset-at-boot on
    `kiln:<ns>:fsr:active-connections` (confirmed — no `EXPIRE` anywhere near it).
*   **Impact**: a SIGKILL / OOM / crash orphans every in-flight connection's INCR permanently. The
    counter drifts monotonically upward across restarts until it exceeds `maxSseConnections`
    (default 1000), at which point **every** new SSE connection is refused app-wide and the only
    remedy is manually deleting the Redis key. Fails closed, silently, and cumulatively.
*   **Note**: the key *is* correctly namespaced (`cache.fsrConnectionCountKey()`, covered by
    `cache.test.ts:304-305`) — namespacing is not the problem, lifetime is.
*   **Fix direction**: per-connection keys with TTL renewed by the existing keepalive (count via
    SCAN), or a per-process counter key deleted at boot, or a periodic reconciliation sweep.

### 1.4 `syncTriggers` DROP + CREATE is not transactional — MED

*   **File**: `packages/cli/src/sync-triggers.ts:61-64`
*   **Description**: the drift-repair path issues `DROP TRIGGER` and `CREATE TRIGGER` as two
    separate `sql.unsafe` calls with no surrounding transaction.
*   **Impact**: a crash/disconnect between them leaves the table with **no** trigger — invalidation
    silently stops for that table, and a later `--check` reports `missing` only if someone runs it.
*   **Fix direction**: wrap the pair in a transaction, or use `CREATE OR REPLACE TRIGGER` (PG 14+).

### 1.5 Non-`public` schemas unsupported, with a misleading error — LOW

*   **Files**: `packages/cli/src/sync-triggers.ts:97-100`, `packages/core/src/sql.ts:15`
*   **Description**: `assertIdent` rejects `app.contacts` as `unsafe SQL identifier` — accurate about
    the regex, misleading about the cause (a schema-qualified name is legitimate, not unsafe).
    Separately, `extractTables` strips the schema (**verified**: `app.Contacts` → `contacts`), so
    same-named tables in two schemas collide on one dep key.
*   **Fix direction**: support schema-qualified names end to end, or reject them with an error that
    says schemas aren't supported yet.

### 1.6 Dynamic table names are silently not captured — LOW

*   **File**: `packages/core/src/sql.ts:10-19`
*   **Verified**: the post-interpolation string `SELECT * FROM  ? ` yields `[]`.
*   **Description**: documented as best-effort, and over-capture is the safe direction — but this is
    the *under*-capture direction and it is silent.
*   **Fix direction**: when a capture scope is active and a template produces zero tables, warn once
    per call site in dev.

---

## 2. Infrastructure & Integration Test Issues

*   **Database Invalidation Integration Failures**:
    *   **File**: `packages/engine/src/list-store.test.ts`
    *   **Description**: Integration database tests require a live PostgreSQL connection. If `DATABASE_URL` is not provided in the environment (or missing from `.env` in `test-app/`), tests crash.
    *   **Impact**: `bun run test:integration` crashes if the local database environment is not pre-configured.

*   **Orphaned test file — runs in neither suite** (found 2026-07-27):
    *   **File**: `examples/address-book/db/contacts.integration.test.ts`
    *   **Description**: excluded from `test:unit` via `--path-ignore-patterns`, but never named in
        `test:integration` (which lists its files explicitly). It executes in no suite.
    *   **Fix**: add it to `test:integration`, or delete it if it's superseded.

## 3. Playwright E2E Skips
*   The Playwright testing suite inside `examples/address-book` has an intentional desktop browser skip configured in its test suite that needs monitoring.

---

## Carry-forward: known ADR-018 limitations (by design, not defects)

Recorded so they aren't re-filed as bugs. Full rationale in `.codebase-memory/adr.md` § ADR-018.

*   DELETE-driven tombstoning is not owner-scoped (`notifyDelete` → `tombstoneDependentRoutes`);
    only INSERT/UPDATE are.
*   Auto-deps is proven at the capture/trigger/watcher layer but **not exercised end-to-end**
    through a page with live fields in any app — `jags-list` still has zero `Live.value`/`Live.list`
    usage. §1.1 and §1.2 above are both the kind of defect that end-to-end use would have caught.
*   Dynamic-segment `bake='user'` + live fields falls back to shared-key SSE scoping (warned at
    runtime).
*   The dormant check costs one awaited Postgres SELECT per validated cache hit on routes with no
    local SSE-active mark. **Decision 2026-07-27: leave as-is** — correctness over a sub-ms indexed
    read; revisit only with profiling evidence.
