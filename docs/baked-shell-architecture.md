# Kiln Baked-Shell Architecture

Kiln bakes every concrete page and matched layout segment on its first
identity-free render (ADR-016). `bake = 'static'` prebakes entries() at
startup; `bake = false` disables baking for that target; identity-touching
load() functions are never baked.

Promoted artifacts have two parts:

- An immutable HTML shell containing static markup, layout identity, slots, and
  live boundaries.
- A versioned JSON snapshot containing current loader data and rendered
  `Live.list` row fragments.

PostgreSQL owns lifecycle state. Redis owns hot artifacts, locks, and pub/sub.
Disk is the recovery cache. Production startup requires reachable PostgreSQL
and Redis. Kiln initializes its internal PostgreSQL schema idempotently.

Watchers update JSON and broadcast patches. They never rewrite the stored HTML
shell. Direct requests materialize a document from the shell and latest
snapshot without invoking loaders or React. Missing markers, corrupt snapshots,
or render-version mismatches invalidate the artifact and use the cold render
path.

Enhanced navigation sends `X-PS-Present`. RouteKit returns missing layouts and
the destination page as a `text/html; x-ps-fragment=1` response. Existing
layout nodes remain mounted, preserving DOM identity and local state.

**ANTI-PATTERN:** fetching a complete SSR document and replacing `<body>` for
ordinary internal navigation bypasses Kiln layout-aware fetching and
baked-shell freshness.
