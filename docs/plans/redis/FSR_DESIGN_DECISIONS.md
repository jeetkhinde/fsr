# FSR — Field-Selective Rendering: Design Decisions & DX Recap

Use this document to resume the FSR design session.

---

## What FSR is

FSR is Pilcrow's original rendering paradigm. No other framework offers it.
It extends SSR/ISR/SSG with **field-level granularity**:

- Static fields baked directly into HTML — never tracked
- Watched fields (`LiveProps<T>`) get a shell slot in HTML, a DB cache row, and live SSE updates
- One integer controls the full rendering lifecycle per field

---

## Infrastructure (LOCKED)

Pilcrow at scale runs on three layers, each with a single role:

```
Redis     = serve layer + pub/sub bus (REQUIRED — hot, fast, multi-instance synced)
Postgres  = truth layer (REQUIRED — real data + pilcrow_fsr metadata)
Disk      = recovery layer (OPTIONAL — cold, durable, written async)
```

**Redis is required infrastructure.** No optional flag, no fallback-only mode.
Multi-instance Pilcrow deployments are impossible without a shared cache layer,
and the framework commits to Redis as that layer.

### Why Redis (not Memcached)
- Atomic field-level updates (HASH fields, RedisJSON) — Memcached is get/set only
- Pub/sub built in — replaces watcher polling entirely
- Persistence option — cache survives restart, no cold-start thundering herd
- Multi-instance safe — all Pilcrow nodes share one cache, no stale reads across pods

### Layer roles

**Redis (serve + bus):**
- Source of truth for baked HTML/JSON on the hot path
- Pub/sub channels for invalidation, patch, and promotion events
- All read traffic for promoted routes hits Redis first

**Postgres (truth):**
- `pilcrow_fsr` metadata (route, slot, stale, version, depends_on, etc.)
- Real application data (the source for re-executed queries)
- Durable record of what should be cached

**Disk (recovery):**
- Async write-behind from Redis (fire and forget)
- Used only on Redis flush / cold start
- Never on the hot path

### Redis key structure

```
pilcrow:html:<route>          → STRING  full baked HTML
pilcrow:json:<route>          → STRING  full baked JSON (if FSR_JSON opted in)
pilcrow:slot:<route>          → HASH    { slot_name: current_value, ... }
pilcrow:meta:<route>          → HASH    { version, baked_at, checksum, promoted }
```

### Redis pub/sub channels

```
pilcrow:invalidate   → watcher subscribers receive { route, slots, deps }
pilcrow:patch        → SSE hub subscribers receive { route, slot, value }
pilcrow:promote      → all instances receive { route, promoted: true }
```

### Required configuration

```toml
[cache]
redis_url = "redis://127.0.0.1:6379"   # required — Pilcrow fails to start without it
```

---

## Rendering lifecycle — single unified model

```
promote_after = 0 or absent  → SSG  (bake at startup, surgical patch on dep change)
promote_after = 1            → ISR  (bake after first request, surgical patch on dep change)
promote_after = N            → FSR  (bake after N hits, surgical patch on dep change)

No live.rs file              → pure SSR (existing Pilcrow behaviour, untouched)
```

All three modes receive surgical patch on dep change. The only difference is when the first bake happens.

---

## Locked decisions

### Data model
- Static fields → baked into HTML, never stored anywhere
- LiveProps fields → shell slot in HTML + `pilcrow_fsr` DB row
- No `value` column in DB — source of truth stays in real DB tables
- `query` + `query_params` stored for re-execution when `stale = TRUE`
- Watcher sees `stale = TRUE` → re-executes query → re-bakes HTML/JSON → clears stale

### DB — single table
One table only: `pilcrow_fsr`. No separate `pilcrow_routes` table.
`slot = ''` row = route-level metadata. `slot = 'field_name'` = slot-level row.

```sql
pilcrow_fsr (
    route           TEXT,
    slot            TEXT,           -- '' for route-level
    query           TEXT,           -- SQL to re-execute when stale
    query_params    JSONB,
    depends_on      TEXT[],
    stale           BOOLEAN,
    version         INT,
    hit_count       INT,
    promoted        BOOLEAN,
    promote_after   INT,            -- NULL treated as 0 (SSG)
    debounce_secs   INT,
    html_path       TEXT,
    json_path       TEXT,           -- NULL if JSON not opted in
    checksum        TEXT,
    last_hit        TIMESTAMPTZ,
    purge_after     INT,
    PRIMARY KEY (route, slot)
)
```

### Invalidation
- Synchronous — no event log, no queue
- `dep!(table, col, val)` macro produces typed `DependencyKey`
- Serialises to `"table:column=value"` e.g. `"tickets:id=123"`
- `pilcrow::invalidate!(dep!(tickets, id, 123))` → `UPDATE pilcrow_fsr SET stale=TRUE WHERE depends_on @> ARRAY[...]`
- Route-level: `pilcrow::invalidate!(route = "/tickets/123")`

### Watcher process
- Subscribed to `pilcrow:invalidate` Redis pub/sub channel — event-driven, no polling
- Embedded (default) — Tokio task inside Pilcrow
- External — opt-in via `pilcrow.toml`, Pilcrow exposes `pilcrow_fsr_watcher_tick(pool, redis)`
- Polling fallback only if Redis pub/sub connection drops

### Promotion and debounce
- Promotion threshold declared per field via `#[pilcrow::promote_after(N)]`
- Framework default in `pilcrow.toml → [fsr] promote_after_hits`
- Debounce declared per field via `#[pilcrow::patch_debounce(N)]`
- Framework default in `pilcrow.toml → [fsr] patch_debounce_secs`
- Both co-located with the field declaration — not in toml per route

### HTML shell attribute
- `s-live="slot_name"` — consistent with Silcrow's `s-` prefix convention
- Same name end to end: `live.rs` field name = `s-live` attr = `pilcrow_fsr` slot = SSE payload key

### JSON baking
- Opt-in at route level: `pub const FSR_JSON: bool = true` in `page.rs`
- Only `LiveProps` fields included — static fields never appear in baked JSON
- Baked flat: `{ "ticket_status": "In Progress", "ticket_priority": "High" }`

### Silcrow.js
- Auto-injected by Pilcrow when any route has `live.rs` — dev never references it
- Owns SSE hub — one persistent connection per app lifetime
- On navigation → sends current route + active slot names to server
- Server pushes only slots relevant to current route
- DOM patching via `querySelectorAll('[s-live="slot_name"]')` → `textContent`
- No changes needed to existing Silcrow.js patch path

### List rows
- Slot naming: `list_field__row_id__field_name` e.g. `ticket_list__42__status`
- Only watched columns get shell slots — static columns baked directly
- Same patcher, no special handling needed

### Dependency key derivation
- SQLx is used as-is — Pilcrow does not wrap it
- Developer declares `depends_on` explicitly via `dep!` macro on each `LiveProps` field
- `dep!(tickets, id, ticket_id)` → typed, refactor-safe, no raw strings

### Query deduplication
- Same SQL + same params across multiple `LiveProps` fields → executes once
- All fields populated from single result row

---

## File convention

```
pages/
  tickets/
    [id]/
      page.rs       — handler, Props struct, static fields
      live.rs       — LiveProps fields, query, depends_on, policies
      page.html     — template with s-live shell slots
```

---

## Developer surface — complete, nothing else needed

### `live.rs`
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

### `page.rs`
```rust
// Optional JSON opt-in — only LiveProps fields baked into JSON
pub const FSR_JSON: bool = true;

pub struct Props {
    pub title: String,   // static — baked into HTML only
    pub live: Live,      // watched — shell slots + pilcrow_fsr rows
}

pub async fn load(
    Path(id): Path<i32>,
    live: Live,          // injected by Pilcrow automatically
) -> AppResult<Props> {
    Ok(Props {
        title: "Ticket".into(),
        live,
    })
}
```

### `page.html`
```html
<!-- Static field — baked directly -->
<h1>{{ title }}</h1>

<!-- Watched field — shell slot -->
<span s-live="ticket_status">{{ live.ticket_status.value }}</span>
<span s-live="ticket_priority">{{ live.ticket_priority.value }}</span>

<!-- List row watched field -->
<span s-live="ticket_list__42__status">Open</span>
```

### `pilcrow.toml`
```toml
[cache]
redis_url            = "redis://127.0.0.1:6379"   # REQUIRED

[fsr]
watcher              = "embedded"
promote_after_hits   = 100
patch_debounce_secs  = 30
purge_after_seconds  = 2592000
```

### Macros
```rust
dep!(tickets, id, ticket_id)             // typed DependencyKey
live_query!("SELECT ...", param)         // LiveQuery with bound params
pilcrow::invalidate!(dep!(tickets, id, 123))   // targeted invalidation
pilcrow::invalidate!(route = "/tickets/123")   // route-level invalidation
```

---

## Runtime flow

### SSR request (not yet promoted)
```
Request arrives
→ Pilcrow injects Live via FromRequestParts
→ Executes Live::query(params) via SQLx pool
→ Populates LiveProps fields from result row
→ Writes slot rows to pilcrow_fsr (insert or update)
→ Increments hit_count on route row
→ Checks hit_count >= promote_after → sets promoted = TRUE if threshold reached
→ Injects current LiveProps values into s-live shell slots
→ Serves HTML fresh
```

### Promoted route request
```
Request arrives
→ GET pilcrow:html:<route> from Redis
→ Hit: serve directly (hot path)
→ Miss: read html_path from disk → serve → async SET in Redis
→ Hard miss (no Redis, no disk): re-bake → Redis → async disk write
```

### Dep change → surgical patch (pub/sub driven)
```
pilcrow::invalidate!(dep!(tickets, id, 123))
→ UPDATE pilcrow_fsr SET stale=TRUE WHERE depends_on @> ARRAY['tickets:id=123']
→ PUBLISH pilcrow:invalidate { route, slots, deps }
→ Watcher (subscribed) receives instantly — no polling
→ Re-executes stored query with stored params
→ Patches pilcrow:slot:<route> HASH field in Redis
→ Re-renders HTML from slot HASH → SET pilcrow:html:<route>
→ Patches pilcrow:json:<route> in Redis (if FSR_JSON opted in)
→ SET stale=FALSE, version=version+1 in pilcrow_fsr
→ PUBLISH pilcrow:patch { route, slot, value }
→ SSE hub (subscribed) fans out to connected clients on this route
→ Silcrow.js patches DOM via querySelectorAll('[s-live="ticket_status"]')
→ Async: write disk for durability (fire and forget)
```

### App startup (promote_after = 0 or absent)
```
pilcrow_start()
→ Connect to Redis (fail fast if unreachable)
→ Subscribe watcher to pilcrow:invalidate channel
→ Subscribe SSE hub to pilcrow:patch channel
→ SELECT all pilcrow_fsr rows WHERE promote_after = 0 OR promote_after IS NULL
→ For each: check Redis first
  → Redis hit: trust it, skip bake
  → Redis miss: check disk
    → Disk hit: read, populate Redis, skip bake
    → Disk miss: execute query, bake HTML/JSON, populate Redis, async disk write
→ Mark promoted = TRUE
→ Server begins accepting traffic
```

### Multi-instance scaling
```
10 Pilcrow pods running
→ All subscribed to pilcrow:invalidate, pilcrow:patch
→ Any pod can call invalidate!()
→ All pods see it instantly via pub/sub
→ One pod (first-to-claim) does the re-bake
→ All pods see patched Redis state immediately
→ No cross-pod coordination needed
```

---

## Comparison with other rendering models

```
SSG              ★★★★★  Pilcrow matches — promoted routes are static file serves
ISR (Next.js)    ★★★★☆  Pilcrow is better — dep-based not time-based, field-level not page-level
SSR              ★★★☆☆  Pilcrow matches for unpromoted routes, better cache story
CSR              ★★☆☆☆  Pilcrow better — 95% baked, only watched fields are shells
Streaming SSR    ★★★☆☆  Pilcrow prefers FSR LiveProp fields and islands/fragments for slow UI
```

Pilcrow's unique advantages over all:
- Field-level granularity — no other framework does this at HTML baking level
- Dep-based invalidation — not time-based, not manual
- Automatic promotion based on traffic
- Zero client JS required for live fields — SSE + server patch, no hydration
- One integer (`promote_after`) unifies SSG/ISR/FSR/SSR into a single continuum

---

## What is NOT in scope for FSR

- Wrapping SQLx — developer uses SQLx directly, declares deps explicitly
- Shared DTOs — frontend and backend define independent structs
- Value storage in DB — pilcrow_fsr never stores field values
- Per-route toml config — all config is co-located on the field declaration
- File-based cache fallback — DB is required if app uses LiveProps
