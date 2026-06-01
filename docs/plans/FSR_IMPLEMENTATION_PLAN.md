# FSR — Field-Selective Rendering: Implementation Plan

> Hand this document to Claude as the complete implementation spec.
> Work phase by phase. Stop at each **STOP** boundary for review before proceeding.

---

## Background

FSR is Pilcrow's original rendering paradigm. It extends the existing
SSR / ISR / SSG / Streaming pipeline with **field-level granularity**:

- Static fields are baked directly into HTML — never tracked
- Watched fields (`LiveProps<T>`) get a shell slot in HTML, a DB cache row, and live SSE updates
- One integer (`promote_after`) controls the full rendering lifecycle

```
promote_after = 0 or absent  → SSG  (bake at startup, surgical patch on dep change)
promote_after = 1            → ISR  (bake after first request, surgical patch on dep change)
promote_after = N            → FSR  (bake after N hits, surgical patch on dep change)

No live.rs file              → pure SSR (existing Pilcrow behaviour, untouched)
```

---

## Crate / file map (existing, do not change)

```
crates/core         — AppError, AppResult, PilcrowConfig
crates/routekit     — build-time pipeline, codegen, page_options
crates/runtime      — Req, Res, ISR, SSE, assets
crates/macros       — #[handler] proc-macro
crates/client       — PilcrowClient
crates/web          — pilcrow_web facade
```

New code lives in:

```
crates/runtime/src/fsr/          — LiveProps, DependencyKey, PilcrowLive trait, watcher
crates/runtime/migrations/       — SQLx migration for pilcrow_fsr table
crates/routekit/src/fsr/         — live.rs discovery, FsrOpts codegen
```

---

## Phase 1 — DB migration

**File:** `crates/runtime/migrations/0001_pilcrow_fsr.sql`

```sql
CREATE TABLE IF NOT EXISTS pilcrow_fsr (
    route           TEXT        NOT NULL,
    slot            TEXT        NOT NULL  DEFAULT '',
    query           TEXT,
    query_params    JSONB,
    depends_on      TEXT[]      NOT NULL  DEFAULT '{}',
    stale           BOOLEAN     NOT NULL  DEFAULT FALSE,
    version         INTEGER     NOT NULL  DEFAULT 0,
    hit_count       INTEGER     NOT NULL  DEFAULT 0,
    promoted        BOOLEAN     NOT NULL  DEFAULT FALSE,
    promote_after   INTEGER,
    debounce_secs   INTEGER,
    html_path       TEXT,
    json_path       TEXT,
    checksum        TEXT,
    last_hit        TIMESTAMPTZ,
    purge_after     INTEGER,
    PRIMARY KEY (route, slot)
);

CREATE INDEX IF NOT EXISTS pilcrow_fsr_stale_idx
    ON pilcrow_fsr (stale)
    WHERE stale = TRUE;

CREATE INDEX IF NOT EXISTS pilcrow_fsr_depends_on_idx
    ON pilcrow_fsr USING GIN (depends_on);
```

**Rules:**
- `slot = ''` is the route-level row (`html_path`, `hit_count`, `promoted` live here)
- Slot rows have `slot = 'field_name'` or `slot = 'list__rowid__field'`
- `query` + `query_params` store the SQL to re-execute when `stale = TRUE`
- `value` is **never stored** — source of truth stays in the real DB tables

**STOP — review schema before Phase 2.**

---

## Phase 2 — `LiveProps<T>` type and `DependencyKey`

**File:** `crates/runtime/src/fsr/live_props.rs`

```rust
/// A field whose value is tracked, cached, and live-patched by Pilcrow.
///
/// `T` must implement `serde::Serialize + serde::de::DeserializeOwned`.
pub struct LiveProps<T> {
    pub value: T,
    pub depends_on: Vec<DependencyKey>,
    /// Override framework default (`pilcrow.toml → [fsr] promote_after_hits`).
    /// 0 or absent = SSG (bake at startup), 1 = ISR, N = FSR.
    /// All modes get surgical patch on dep change.
    pub promote_after: Option<u32>,
    /// Override framework default (`pilcrow.toml → [fsr] patch_debounce_secs`).
    pub patch_debounce: Option<u32>,
}

/// Typed dependency key. Serialises to `"table:column=value"`.
pub struct DependencyKey {
    pub table: &'static str,
    pub column: &'static str,
    pub value: String,
}

impl std::fmt::Display for DependencyKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}={}", self.table, self.column, self.value)
    }
}
```

**`dep!` macro** — in `crates/macros/src/dep.rs`:

```rust
/// dep!(tickets, id, ticket_id)
/// → DependencyKey { table: "tickets", column: "id", value: ticket_id.to_string() }
#[macro_export]
macro_rules! dep {
    ($table:ident, $col:ident, $val:expr) => {
        ::pilcrow_web::fsr::DependencyKey {
            table: stringify!($table),
            column: stringify!($col),
            value: $val.to_string(),
        }
    };
}
```

**Attributes** — read by routekit codegen, stripped before emit (same pattern as `REVALIDATE`):

```rust
#[pilcrow::promote_after(50)]
#[pilcrow::patch_debounce(30)]
#[pilcrow::depends_on(dep!(tickets, id, id))]
pub ticket_status: LiveProps<String>,
```

**STOP — review types before Phase 3.**

---

## Phase 3 — `PilcrowLive` trait and `live_query!`

**File:** `crates/runtime/src/fsr/live_trait.rs`

```rust
/// Implement this on any `Live` struct defined in a route's `live.rs`.
pub trait PilcrowLive: Sized {
    /// Returns the SQL query and bound params used to populate all LiveProps fields.
    fn query(params: &RouteParams) -> LiveQuery;

    /// Extract field values from a query result row.
    /// Generated by routekit codegen — developer does not implement this manually.
    fn from_row(row: &PilcrowRow) -> Self;
}

pub struct LiveQuery {
    pub sql: &'static str,
    pub params: Vec<serde_json::Value>,
}

/// live_query!("SELECT status FROM tickets WHERE id = $1", id)
#[macro_export]
macro_rules! live_query {
    ($sql:expr $(, $param:expr)*) => {
        ::pilcrow_web::fsr::LiveQuery {
            sql: $sql,
            params: vec![$( serde_json::json!($param) ),*],
        }
    };
}
```

**Deduplication rule:** if two `LiveProps` fields share the same `sql` + `params`, the query
executes once and both fields are populated from the single result row.

**STOP — review trait before Phase 4.**

---

## Phase 4 — `live.rs` file convention

routekit discovers `live.rs` alongside `page.rs` in any route directory.

**Directory layout:**

```
pages/
  tickets/
    [id]/
      page.rs       ← existing, unchanged
      live.rs       ← new, optional
      page.html     ← existing, s-live attrs added by dev
```

**`live.rs` developer surface:**

```rust
use pilcrow::live::*;

pub struct Live {
    #[pilcrow::promote_after(50)]
    #[pilcrow::patch_debounce(30)]
    #[pilcrow::depends_on(dep!(tickets, id, id))]
    pub ticket_status: LiveProps<String>,

    #[pilcrow::depends_on(dep!(tickets, id, id))]
    pub ticket_priority: LiveProps<String>,
}

impl PilcrowLive for Live {
    fn query(params: &RouteParams) -> LiveQuery {
        live_query!(
            "SELECT status, priority FROM tickets WHERE id = $1",
            params.id
        )
    }
}
```

**routekit codegen tasks for `live.rs`:**

1. Detect presence of `live.rs` in route directory → set `FsrOpts { has_live_file: true }`
2. Parse `Live` struct fields, extract attributes (`promote_after`, `patch_debounce`, `depends_on`)
3. Strip all `#[pilcrow::*]` attributes before emitting — they never reach Rust compiler
4. Generate `from_row()` impl on `Live` (maps SQL columns → struct fields by name)
5. Detect `pub const FSR_JSON: bool = true` in `page.rs` → set `FsrOpts { json: true }`

**`page.rs` load function — dev writes this:**

```rust
pub struct Props {
    pub title: String,     // static — baked into HTML only
    pub live: Live,        // watched — shell slots + pilcrow_fsr rows
}

pub async fn load(
    Path(id): Path<i32>,
    live: Live,            // injected by Pilcrow automatically
) -> AppResult<Props> {
    Ok(Props {
        title: "Ticket".into(),
        live,
    })
}
```

**Codegen injects `Live` extractor** via `FromRequestParts` — same pattern as `PilcrowClient`.
Dev never calls `Live::query()` manually.

**STOP — review convention before Phase 5.**

---

## Phase 5 — HTML baking and `s-live` shell slots

**Template convention in `page.html`:**

```html
<!-- Static field — baked directly, no slot -->
<h1>{{ title }}</h1>

<!-- Watched field — shell slot -->
<span s-live="ticket_status">{{ live.ticket_status.value }}</span>
<span s-live="ticket_priority">{{ live.ticket_priority.value }}</span>
```

**List row slot naming:**

```
ticket_list__42__status
ticket_list__42__priority
```

```html
<span s-live="ticket_list__42__status">Open</span>
```

**Slot name derivation:** `field_name` by default. For list rows: `list_field__row_id__field_name`.
Dev can override with `#[pilcrow::slot("custom_name")]`.

**At serve time (SSR routes):**

1. Read `pilcrow_fsr` rows for this route where `slot != ''`
2. For each stale slot — re-execute stored query, get fresh value
3. Inject fresh value into `s-live` shell in HTML before serving
4. HTML served is always fresh at request time

**Promoted routes:**

- Serve baked HTML file from `html_path` directly
- `s-live` slots already contain latest value (patched by watcher)

**JSON opt-in (`FSR_JSON = true`):**

Baked JSON at `json_path` contains only `LiveProps` fields:

```json
{
  "ticket_status": "In Progress",
  "ticket_priority": "High"
}
```

Static fields (`title`) never appear in baked JSON.

**STOP — review baking before Phase 6.**

---

## Phase 6 — Invalidation

**`pilcrow::invalidate!` macro:**

```rust
// Targeted — by dependency key
pilcrow::invalidate!(dep!(tickets, id, 123));

// Route-level — all slots on a route
pilcrow::invalidate!(route = "/tickets/123");
```

**SQL executed (targeted):**

```sql
UPDATE pilcrow_fsr
SET    stale   = TRUE,
       version = version + 1
WHERE  depends_on @> ARRAY['tickets:id=123']
```

**SQL executed (route-level):**

```sql
UPDATE pilcrow_fsr
SET    stale   = TRUE,
       version = version + 1
WHERE  route = '/tickets/123'
```

**Rules:**
- Synchronous — no event log, no queue
- Direct DB update only
- Watcher picks up `stale = TRUE` on next poll

**STOP — review invalidation before Phase 7.**

---

## Phase 7 — Watcher process

**Configuration in `pilcrow.toml`:**

```toml
[fsr]
watcher              = "embedded"   # "embedded" | "external"
poll_interval_ms     = 500
promote_after_hits   = 100          # framework default
patch_debounce_secs  = 30           # framework default
purge_after_seconds  = 2592000      # 30 days
```

**Watcher loop (embedded mode — runs as Tokio task inside Pilcrow):**

```
LOOP every poll_interval_ms:
  SELECT route, slot, query, query_params, depends_on, promoted, debounce_secs, html_path, json_path
  FROM pilcrow_fsr
  WHERE stale = TRUE

  FOR each stale row:
    re-execute stored query with stored params via SQLx pool
    extract field value from result
    update s-live slot in HTML (always)
    update json_path file (if set)
    SET stale = FALSE, version = version + 1
    push SSE to connected clients on this route

  FOR promoted routes after debounce:
    patch baked HTML file on disk at html_path
    patch baked JSON file on disk at json_path (if set)
```

**External mode:** Pilcrow exposes `pilcrow_fsr_watcher_tick(pool)` as a public async fn.
External process calls it on its own schedule.

**STOP — review watcher before Phase 8.**

---

## Phase 8 — SSE push via Silcrow.js

**Silcrow.js is auto-injected** when `live.rs` is present in any route.
Dev never references Silcrow.js explicitly — it works like a tiny script.

**Detection in routekit:** if any route has `FsrOpts { has_live_file: true }` →
inject Silcrow.js `<script>` tag in `<head>` of every page (same as dev-reload injection).

**Hub model — one persistent SSE connection per app:**

```
App loads
→ Silcrow opens ONE SSE connection to /__pilcrow/live

On each navigation
→ Silcrow sends current route + active slot names to server:
  { "route": "/tickets/123", "slots": ["ticket_status", "ticket_priority"] }

Server updates slot subscription for this client connection.
Server pushes only slots relevant to current route.
```

**SSE push payload from watcher:**

```json
{ "ticket_status": "In Progress" }
```

For list rows:
```json
{ "ticket_list__42__status": "Closed" }
```

**Silcrow patches DOM** via `querySelectorAll('[s-live="ticket_status"]')` → sets `textContent`.
No changes to existing Silcrow.js patch path — `s-live` is handled identically to existing
reactive binding attributes.

**STOP — review SSE before Phase 9.**

---

## Phase 9 — `page_options.rs` integration

**Add `FsrOpts` to `PageOptions`** in `crates/routekit/src/templating/page_options.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FsrOpts {
    /// `live.rs` was found alongside this page's `page.rs`.
    pub has_live_file: bool,
    /// `pub const FSR_JSON: bool = true` was declared in `page.rs`.
    pub json: bool,
}
```

**Constants detected and stripped (same pattern as `REVALIDATE`, `PRERENDER`, `STREAMING`):**

```rust
pub const FSR_JSON: bool = true;   // in page.rs — opt in to baked JSON
```

**Compatibility matrix — build errors:**

```
FSR_JSON = true  +  STREAMING = true   → build error (incompatible)
live.rs present  +  STREAMING = true   → build error (incompatible)
live.rs present  +  REVALIDATE         → valid (ISR + field-level live)
live.rs present  +  PRERENDER = true   → valid (treated as promote_after = 0)
promote_after absent on LiveProps      → treated as 0, baked at startup
```

**STOP — review page_options before Phase 10.**

---

## Phase 10 — `pilcrow_fsr` DB hit count and promotion

**On every request to a route with `live.rs`:**

```sql
UPDATE pilcrow_fsr
SET    hit_count = hit_count + 1,
       last_hit  = NOW()
WHERE  route = $1
AND    slot  = ''
```

**Promotion check (after update):**

```sql
UPDATE pilcrow_fsr
SET    promoted = TRUE
WHERE  route         = $1
AND    slot          = ''
AND    hit_count    >= COALESCE(promote_after, 0)
AND    promoted      = FALSE
```

When `promoted` flips to `TRUE`:
- Watcher bakes full HTML to `html_path` on next tick
- Subsequent requests served from `html_path` file directly (no DB read for static fields)

**`promote_after = 0` or absent special case:**

Both treated identically — bake at server startup in `pilcrow_start()`, same path as `PRERENDER = true`.
All routes/slots with `promote_after = 0` or `promote_after = NULL` are baked before server accepts traffic.
All three modes (SSG/ISR/FSR) receive surgical patch on dep change — no exceptions.

---

## Phase 11 — re-exports and developer surface

**Add to `crates/web/src/lib.rs`:**

```rust
pub use pilcrow_runtime::fsr::{
    LiveProps,
    DependencyKey,
    PilcrowLive,
    LiveQuery,
};
pub use pilcrow_macros::{dep, live_query, invalidate};
```

**Developer imports one line:**

```rust
use pilcrow::live::*;
```

---

## Phase 12 — Optimistic mutations + mutation-id envelope

> Adds optimistic local cache with server-authoritative reconciliation on top of
> the existing `window.Silcrow` atom layer. No new transport, no CRDT, no new
> storage primitive. SSE and WS gain a single optional `mutation_id` field on
> their envelopes. Fixes JS backlog #17 (raw `innerHTML` in `revertOptimistic`)
> and Rust backlog #3 (`trigger_event`/`patch_target` overwrite on multi-call).

### Design contract

```
1. Client generates mutationId = crypto.randomUUID() per optimistic write.
2. Client stashes prior atom snapshot, publishes optimistic data.
3. Client sends `silcrow-mutation-id: <id>` header on the request.
4. Server handler reads req.mutation_id() and threads it into SilcrowEvent /
   WsEvent / Res::patch_target outgoing patches.
5. Server-emitted patches carry mutation_id back to the client.
6. Client's SSE/WS handler:
     a. mutation_id matches a pending entry → confirmOptimistic, then apply
     b. mutation_id present but unknown    → apply normally (other tab / external)
     c. mutation_id absent                 → apply normally (DB watcher / external)
7. On submit() throw or !ok → revertOptimistic restores snapshot via publish.
8. Stale-patch guard: if a server patch targets a scope with a pending
   mutation whose timestamp is newer than the patch, drop the patch.
```

Server is always truth. The optimistic layer is a UX optimisation, never a
state source.

---

### Phase 12.1 — `SilcrowEvent.mutation_id`

**File:** `crates/runtime/src/sse/server_sent_events.rs`

Extend `EventKind::Patch` with an optional mutation id. Other kinds remain
unchanged.

```rust
#[derive(Debug)]
pub(crate) enum EventKind {
    Patch {
        data: Result<serde_json::Value, String>,
        target: String,
        mutation_id: Option<String>,
    },
    Html        { markup: String, target: String },
    Invalidate  { target: String },
    Navigate    { path: String },
    Custom {
        event: String,
        data: Result<serde_json::Value, String>,
    },
}
```

**Constructor:** `SilcrowEvent::patch` keeps its signature. Add a new builder:

```rust
impl SilcrowEvent {
    pub fn patch(data: impl serde::Serialize, target: &str) -> Self {
        Self {
            kind: EventKind::Patch {
                data: serde_json::to_value(data).map_err(|e| e.to_string()),
                target: target.to_owned(),
                mutation_id: None,
            },
            id: None,
        }
    }

    /// Attach the mutation id that this patch confirms.
    /// Echoes the client's `silcrow-mutation-id` header.
    pub fn with_mutation_id(mut self, mutation_id: impl Into<String>) -> Self {
        if let EventKind::Patch { mutation_id: ref mut slot, .. } = self.kind {
            *slot = Some(mutation_id.into());
        }
        self
    }
}
```

**Serialization** (`From<SilcrowEvent> for Event`): the `Patch` arm gains
the field. Emit only when present.

```rust
EventKind::Patch { data, target, mutation_id } => match data {
    Err(e) => { /* unchanged */ }
    Ok(data) => {
        let mut payload = serde_json::json!({ "target": target, "data": data });
        if let Some(mid) = mutation_id {
            payload["mutation_id"] = serde_json::Value::String(mid);
        }
        apply_id(
            Event::default()
                .event("patch")
                .json_data(payload)
                .unwrap_or_else(|_| Event::default().comment("pilcrow:encode_error")),
            id,
        )
    }
}
```

**Tests** (`crates/runtime/tests/sse_events.rs`):
- `sse_patch_with_mutation_id_appears_in_body`
- `sse_patch_without_mutation_id_omits_key` (regression: existing payloads stay byte-identical)

---

### Phase 12.2 — `WsEvent.mutation_id`

**File:** `crates/runtime/src/ws/ws.rs`

`WsEvent` is already a typed enum with full serde derives. Extend the `Patch`
variant the same way:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    Patch {
        target: String,
        data: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mutation_id: Option<String>,
    },
    Html       { target: String, markup: String },
    Invalidate { target: String },
    Navigate   { path: String },
    Custom     { event: String, data: serde_json::Value },
}

impl WsEvent {
    pub fn patch(data: impl serde::Serialize, target: &str) -> Self {
        let value = crate::serialize_or_null(data, "WsEvent::patch");
        Self::Patch {
            target: target.to_owned(),
            data: value,
            mutation_id: None,
        }
    }

    /// Attach the mutation id that this patch confirms.
    pub fn with_mutation_id(mut self, mid: impl Into<String>) -> Self {
        if let Self::Patch { mutation_id, .. } = &mut self {
            *mutation_id = Some(mid.into());
        }
        self
    }
}
```

The `#[serde(default, skip_serializing_if = "Option::is_none")]` keeps existing
WS payloads byte-identical when no mutation id is present — important because
WS payloads are public wire format consumed by handlers in user code.

**Tests** (`crates/runtime/tests/ws_events.rs`):
- `ws_event_patch_with_mutation_id_serializes`
- `ws_event_patch_round_trips_with_mutation_id`
- `ws_event_patch_without_mutation_id_omits_key`

---

### Phase 12.3 — `SilcrowMutationId` request header

**File:** `crates/runtime/src/response/headers.rs`

Append one line to the existing block:

```rust
define_string_header!(SilcrowMutationId, "silcrow-mutation-id");
```

**File:** `crates/runtime/src/context.rs`

Add to `CommonParts`:

```rust
struct CommonParts {
    // ... existing fields
    mutation_id: Option<String>,
}
```

Populate in `extract_common_parts`:

```rust
let mutation_id = parts
    .headers
    .typed_get::<SilcrowMutationId>()
    .map(|h| h.0);
```

Add to `Req`:

```rust
pub struct Req {
    // ... existing fields
    pub mutation_id: Option<String>,
}
```

Wire it through everywhere `Req` is constructed:
- `FromRequest for Req` extraction
- `__from_error_parts`
- `__synthetic`
- `ReqBuilder::build` (default `None`)

Add a sugar method:

```rust
impl Req {
    /// Return the client-supplied `silcrow-mutation-id` header, if any.
    pub fn mutation_id(&self) -> Option<&str> {
        self.mutation_id.as_deref()
    }
}
```

**Tests** (`crates/runtime/tests/context.rs` or new `mutation_id.rs`):
- `req_mutation_id_extracts_header`
- `req_mutation_id_absent_returns_none`
- `req_for_test_default_mutation_id_is_none`

---

### Phase 12.4 — `Res::patch_target` mutation-id propagation

**File:** `crates/runtime/src/response/response.rs`

`Res::patch_target` currently accumulates into the `silcrow-patch` header.
Add the mutation id to the JSON entry when present.

```rust
pub fn add_patch_target(&mut self, selector: &str, data: &impl Serialize) {
    self.add_patch_target_internal(selector, data, None);
}

pub fn add_patch_target_with_mutation(
    &mut self,
    selector: &str,
    data: &impl Serialize,
    mutation_id: &str,
) {
    self.add_patch_target_internal(selector, data, Some(mutation_id));
}

fn add_patch_target_internal(
    &mut self,
    selector: &str,
    data: &impl Serialize,
    mutation_id: Option<&str>,
) {
    let mut list = self
        .headers
        .typed_get::<SilcrowPatch>()
        .and_then(|h| serde_json::from_str::<Vec<serde_json::Value>>(&h.0).ok())
        .unwrap_or_default();
    let mut entry = serde_json::json!({ "data": data, "target": selector });
    if let Some(mid) = mutation_id {
        entry["mutation_id"] = serde_json::Value::String(mid.to_string());
    }
    list.push(entry);
    self.headers
        .typed_insert(SilcrowPatch(serde_json::Value::Array(list).to_string()));
}
```

This is also the natural place to fix backlog #3 (`patch_target`/`trigger_event`
overwrite on multi-call). The list accumulation is already correct; the fix is
in **silcrow.js** (Phase 12.6) where multiple patches in the same response must
be applied in order without later patches overwriting earlier in-flight optimistic
state for the same target.

`ResponseExt::patch_target` on `Response` gets a sibling:

```rust
fn patch_target_with_mutation(
    self,
    selector: &str,
    data: &impl Serialize,
    mutation_id: &str,
) -> Self;
```

**Tests** (`crates/runtime/tests/response.rs`):
- `response_ext_patch_target_with_mutation_id_accumulates`
- `response_ext_patch_target_without_mutation_id_omits_key`

---

### Phase 12.5 — Silcrow.js `pendingMutations` registry

**File:** `crates/runtime/assets/silcrow.js`

Add a top-level registry near other module state:

```javascript
// Pending optimistic mutations: mutationId → { scope, prevSnapshot, ts }
const pendingMutations = new Map();

// Secondary index: scope → mutationId (most recent), for stale-patch guard
const pendingByScope = new Map();
```

Public API extensions on `window.Silcrow`:

```javascript
publishOptimistic(scope, data, mutationId) {
  if (!mutationId) {
    mutationId = (crypto.randomUUID && crypto.randomUUID())
              || ("m_" + Math.random().toString(36).slice(2));
  }
  const prevSnapshot = window.Silcrow.snapshot
    ? window.Silcrow.snapshot(scope)
    : undefined;
  pendingMutations.set(mutationId, {
    scope,
    prevSnapshot,
    ts: performance.now(),
  });
  pendingByScope.set(scope, mutationId);
  window.Silcrow.publish(scope, data);
  return mutationId;
},

confirmOptimistic(mutationId) {
  const entry = pendingMutations.get(mutationId);
  if (!entry) return false;
  pendingMutations.delete(mutationId);
  // Only clear the scope index if this id is still the latest
  if (pendingByScope.get(entry.scope) === mutationId) {
    pendingByScope.delete(entry.scope);
  }
  return true;
},

revertOptimistic(mutationId) {
  const entry = pendingMutations.get(mutationId);
  if (!entry) return false;
  pendingMutations.delete(mutationId);
  if (pendingByScope.get(entry.scope) === mutationId) {
    pendingByScope.delete(entry.scope);
  }
  // Restore via the same atom publish path — no innerHTML.
  window.Silcrow.publish(entry.scope, entry.prevSnapshot);
  return true;
},
```

**Critical rule:** the existing `revertOptimistic` that uses raw `innerHTML`
(backlog #17) is replaced by this implementation. Remove the old code path
entirely. Audit `submitAction` and any DOM-error fallbacks to ensure they
call the new `revertOptimistic(mutationId)` form, not the old DOM-restore form.

**Tests** (new file `crates/runtime/tests/silcrow_optimistic.test.js` or
add to existing JS test harness):
- `publishOptimistic stashes snapshot and publishes`
- `confirmOptimistic clears registry without republishing`
- `revertOptimistic restores prior snapshot`
- `revertOptimistic on unknown id is a no-op`
- `secondary scope index tracks latest mutation`

---

### Phase 12.6 — `submitAction` integration

**File:** `crates/runtime/assets/silcrow.js`, function `submitAction`
(~L389–449).

Add an `optimistic` option:

```javascript
// New options shape:
//   options.optimistic = { scope, data, mutationId? }
```

**Integration points (mirror the existing `options.scope` pattern):**

```javascript
async function submitAction(url, body, options = {}) {
  let mutationId = null;
  if (options.optimistic) {
    mutationId = window.Silcrow.publishOptimistic(
      options.optimistic.scope,
      options.optimistic.data,
      options.optimistic.mutationId,
    );
  }

  const headers = { /* existing */ };
  if (mutationId) {
    headers["silcrow-mutation-id"] = mutationId;
  }

  try {
    const response = await fetch(url, { method, headers, body: serializedBody });
    if (!response.ok) {
      if (mutationId) window.Silcrow.revertOptimistic(mutationId);
      return { ok: false, status: response.status, data: null };
    }

    // ... existing parse / atom-resolve logic ...

    // Server-confirmation path: if no SSE/WS is wired, confirm here so the
    // pending entry doesn't leak. SSE/WS patch path (Phase 12.7) also confirms,
    // but is idempotent on already-cleared ids.
    if (mutationId) window.Silcrow.confirmOptimistic(mutationId);

    return { ok: true, status: response.status, data: parsed };
  } catch (err) {
    if (mutationId) window.Silcrow.revertOptimistic(mutationId);
    throw err;
  }
}
```

**Header name:** lowercase, hyphenated — `silcrow-mutation-id`, matching the
existing convention (`silcrow-target`, `silcrow-trigger`, etc.).

**Idempotency:** `confirmOptimistic(id)` on an already-cleared id is a no-op
returning `false`. Both the HTTP success path and the SSE/WS patch path may
fire; whichever runs first wins, the second is a silent no-op.

---

### Phase 12.7 — SSE and WS patch reconciliation

**File:** `crates/runtime/assets/silcrow.js`

**SSE — `applyLivePatchPayload(payload, fallbackTarget)` (~L931):**

```javascript
function applyLivePatchPayload(payload, fallbackTarget) {
  const mutationId = payload && payload.mutation_id;
  const target = (payload && payload.target) || fallbackTarget;
  const scope = scopeForTarget(target); // existing helper

  // Stale-patch guard (fixes backlog #3 echo): if a newer optimistic mutation
  // exists for this scope and this patch is not its confirmation, drop it.
  const pendingId = pendingByScope.get(scope);
  if (pendingId && pendingId !== mutationId) {
    // A newer local mutation supersedes this server patch. Drop.
    return;
  }

  // Confirm before apply: clear pending so subsequent renders are stable.
  if (mutationId) {
    window.Silcrow.confirmOptimistic(mutationId);
  }

  patch(payload.data, target);
}
```

**WS — `dispatchWsMessage(hub, rawData)` (~L1470), the `type === "patch"` branch
(~L1483):**

```javascript
if (msg.type === "patch") {
  const mutationId = msg.mutation_id;
  const scope = scopeForTarget(msg.target);

  const pendingId = pendingByScope.get(scope);
  if (pendingId && pendingId !== mutationId) {
    return; // newer local mutation supersedes
  }

  if (mutationId) {
    window.Silcrow.confirmOptimistic(mutationId);
  }

  patch(msg.data, el);
}
```

Both insertion points are single-responsibility functions of ~15 lines; the
mutation-id check adds ~6 lines each. No restructuring of the surrounding code
needed.

**`scopeForTarget` helper:** if no equivalent helper exists, add one that
returns the canonical scope key for a target — typically the route path or
target selector. The exact mapping must match what `useSilcrowAtom` /
`useSilcrowRoute` resolve scopes to, otherwise the stale-patch guard misses.

---

### Phase 12.8 — React hook: `useSilcrowMutation`

**File:** `crates/routekit/src/templating/react.rs` — the embedded
`pilcrow/react` module source.

```typescript
export type SilcrowMutationOptions<T> = {
  /** Atom scope the optimistic value lives in. */
  scope: string;
  /** Optimistic value to publish before the request resolves. */
  optimisticData: T;
  /** Optional method / headers / Silcrow scope passthrough. */
  submit?: Omit<SilcrowSubmitOptions, "optimistic">;
};

export type SilcrowMutationState<T> = {
  mutate: (url: string, body?: BodyInit | object | null, opts?: SilcrowMutationOptions<T>) => Promise<SilcrowSubmitResult<T>>;
  pending: boolean;
  error: Error | null;
};

/**
 * React 19 hook that wraps Silcrow.submit with optimistic publish/confirm/revert.
 *
 * @example
 * const { mutate, pending } = useSilcrowMutation<Cart>();
 * await mutate("/cart/add/1", { qty: 1 }, {
 *   scope: "route:/cart",
 *   optimisticData: { count: cart.count + 1, total: cart.total },
 * });
 */
export function useSilcrowMutation<T>(): SilcrowMutationState<T> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(async (url, body, opts) => {
    if (!window.Silcrow?.submit) {
      throw new Error("Silcrow is not loaded");
    }
    setPending(true);
    setError(null);
    try {
      const result = await window.Silcrow.submit<T>(url, body, {
        ...(opts?.submit ?? {}),
        optimistic: opts ? { scope: opts.scope, data: opts.optimisticData } : undefined,
      });
      if (!result.ok) {
        const err = new Error(`Mutation failed: HTTP ${result.status}`);
        setError(err);
      }
      return result;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setPending(false);
    }
  }, []);

  return { mutate, pending, error };
}
```

**`SilcrowSubmitOptions` gains an `optimistic` field:**

```typescript
export type SilcrowSubmitOptions = {
  method?: string;
  scope?: string;
  headers?: Record<string, string>;
  optimistic?: { scope: string; data: unknown; mutationId?: string };
};
```

**`window.Silcrow` ambient type gains:**

```typescript
publishOptimistic?: (scope: string, data: unknown, mutationId?: string) => string;
confirmOptimistic?: (mutationId: string) => boolean;
revertOptimistic?: (mutationId: string) => boolean;
```

Existing hooks (`useSilcrowAtom`, `useSilcrowRoute`, `useSilcrowPrefetch`,
`useSilcrowAction`, `useSilcrowForm`, `usePilcrowNamedAction`,
`publishSilcrowAtom`) — **no signature changes**. They sit above the atom
layer and benefit transparently when optimistic writes flow through `publish`.

---

### Phase 12.9 — Removal: old `revertOptimistic` path

**File:** `crates/runtime/assets/silcrow.js`

Audit for any existing `revertOptimistic` function that touches `innerHTML`,
or any callsite that does DOM-restore on submission failure. Remove. The new
`revertOptimistic(mutationId)` is the only path.

**Backlog cleanup:**
- Item #17 (JS critical) — closed by this phase.
- Item #3 (Rust critical) — closed by 12.7's stale-patch guard.
- Item #2 (Rust critical) — independent; touched only insofar as 12.1 and 12.2
  preserve existing `serialize_or_null` behaviour. Do not bundle the silent-null
  fix here; it deserves its own focused commit.

---

### Phase 12.10 — Developer surface

**`crates/web/src/lib.rs`** — re-export the new header type if user code wants
to read it from a custom extractor:

```rust
pub use runtime::response::headers::SilcrowMutationId;
```

No new top-level macros. The mutation API is fully runtime — generated through
`Silcrow.submit` on the client and read via `req.mutation_id()` on the server.

**Canonical usage (server, Rust):**

```rust
pub async fn create(req: Req) -> ActionResult {
    let mid = req.mutation_id();
    // ... do the work ...
    if let Some(mid) = mid {
        req.res.patch_target_with_mutation("#cart", &cart_state, mid);
    } else {
        req.res.patch_target("#cart", &cart_state);
    }
    json(serde_json::json!({ "ok": true }))
}
```

**Canonical usage (client, React):**

```tsx
import { useSilcrowMutation, useSilcrowRoute } from "pilcrow/react";

function CartButton({ item }) {
  const cart = useSilcrowRoute<Cart>("/cart", { count: 0, total: "$0.00" });
  const { mutate, pending } = useSilcrowMutation<Cart>();

  return (
    <button
      disabled={pending}
      onClick={() => mutate(`/cart/add/${item.id}`, null, {
        scope: "route:/cart",
        optimisticData: { count: cart.count + 1, total: cart.total },
      })}
    >
      Add ({cart.count})
    </button>
  );
}
```

**Canonical usage (server, SSE emitter inside a `live.rs` query):**

```rust
emitter
    .send(SilcrowEvent::patch(&new_state, "#cart").with_mutation_id(mid))
    .await?;
```

**Canonical usage (server, WS handler):**

```rust
stream
    .send(WsEvent::patch(&new_state, "#cart").with_mutation_id(mid))
    .await?;
```

---

### What this phase does NOT do

- No offline queue. Mutations in flight when the tab closes are lost.
- No cross-tab sync. (No BroadcastChannel, no IndexedDB.)
- No field-level scope convention beyond what atoms already support.
- No CRDT, no peer merge, no client-side conflict resolution beyond
  last-write-wins by mutation id.
- No changes to React island mount pipeline, Vite build, or `<react>` tag
  transpilation.
- No fix for Rust backlog #2 (silent-null `serialize_or_null`). Separate commit.

---

### Implementation order (within Phase 12)

```
12.1  SilcrowEvent.mutation_id + with_mutation_id + tests
12.2  WsEvent.mutation_id + with_mutation_id + tests
12.3  SilcrowMutationId header + Req.mutation_id() + tests
12.4  Res::patch_target_with_mutation + tests
12.5  Silcrow.js pendingMutations registry + public API + tests
12.6  submitAction integration (silcrow-mutation-id header + try/catch)
12.7  SSE + WS patch reconciliation (stale-patch guard + confirm-before-apply)
12.8  useSilcrowMutation React hook
12.9  Remove old innerHTML revertOptimistic path
12.10 Re-exports + canonical usage docs
```

**Estimated diff size:**
- Rust: ~80 LOC across 4 files + ~120 LOC tests
- Silcrow.js: ~180 LOC (registry, public API, submitAction wiring, SSE/WS guard)
- React hook: ~50 LOC
- Tests: ~200 LOC total

**STOP after 12.4** — review Rust envelope and header changes before touching
silcrow.js, since 12.5+ depend on stable wire format.

**STOP after 12.7** — run end-to-end optimistic submit + SSE confirm test
before exposing the React hook.

---

## Complete developer surface (nothing else needed)

```
live.rs
  pub struct Live { ... }              — LiveProps fields with attribute annotations
  impl PilcrowLive for Live { ... }    — one query, one impl block

page.rs
  pub struct Props { pub live: Live }  — Live embedded in Props
  pub async fn load(..., live: Live)   — Live injected, zero boilerplate
  pub const FSR_JSON: bool = true;     — optional, JSON opt-in

page.html
  s-live="slot_name"                   — on any element whose value is watched

pilcrow.toml
  [fsr] section                        — framework defaults only, all optional

Macros
  dep!(table, col, val)                — typed dependency key
  pilcrow::invalidate!(dep!(...))      — targeted invalidation
  pilcrow::invalidate!(route = "...")  — route-level invalidation
```

---

## Implementation order

```
Phase 1   DB migration
Phase 2   LiveProps<T> + DependencyKey + dep! macro
Phase 3   PilcrowLive trait + live_query! macro
Phase 4   live.rs discovery + routekit codegen
Phase 5   HTML baking + s-live shell slots
Phase 6   pilcrow::invalidate! macro + SQL
Phase 7   Watcher process (embedded Tokio task)
Phase 8   SSE hub + Silcrow.js auto-injection
Phase 9   FsrOpts in page_options.rs + compatibility checks
Phase 10  hit_count + promotion logic
Phase 11  Re-exports + use pilcrow::live::*
Phase 12  Optimistic mutations + mutation-id envelope (SilcrowEvent + WsEvent)
```

Stop at each phase boundary for review before proceeding.
