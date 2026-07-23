---
name: kiln
description: Use when building or modifying an APPLICATION with the Kiln web framework (file-based React) — creating pages, writing load(), serving JSON, handling actions/forms, real-time LiveProp/Live.list, React islands, choosing rendering modes (SSG/ISR/FSR/SSR), caching, or kiln.config.ts. Not for modifying the Kiln framework packages themselves.
---

# Building apps with Kiln

You are writing application code with the Kiln framework. The full, source-verified guide lives in the repo at [`docs/agents/`](../../../docs/agents/README.md) — this skill is a thin pointer so there is one source of truth.

## How to use it

1. **Read [`docs/agents/README.md`](../../../docs/agents/README.md) first** — the mental model, getting started, and the canonical page shape.
2. **Load the topic file for your task** (progressive disclosure — don't read all of them):
   - Routes, layouts, `_error`/`_not-found` → `docs/agents/routing.md`
   - `load()`, JSON endpoints, `json_first` → `docs/agents/data-loading.md`
   - POST/mutations, forms, `useSilcrowForm` → `docs/agents/actions-and-forms.md`
   - Real-time fields + React interactivity → `docs/agents/live-and-islands.md`
   - SSG/ISR/FSR/SSR, caching, Redis → `docs/agents/rendering-and-caching.md`
   - Auth: `handle` hook, `req.locals`, mounting an auth library → `docs/agents/auth.md`
   - **Always skim** `docs/agents/gotchas.md` before assuming a feature exists.

## Five things to get right

1. A page is a file under `pages/`; export `load()` (data), `default` (UI), optional `actions` (POST).
2. `load()` doubles as a JSON API via content negotiation or `json_first = true`.
3. Rendering mode is observed from load() purity; `bake = 'static' | 'shared' | false` overrides (absent = auto).
4. Real-time data is `LiveProp`/`Live.list` (from `@kiln/core`); interactivity is islands only (from `@kiln/react`) — no full-page hydration.
5. Several features are typed-but-unwired (`apiDir`, `_loading.tsx`, `memory`/`sqlite` cache providers, i18n) — check `gotchas.md`.

## Rule

Verify against source (`packages/*/src`) before asserting a capability. If the docs disagree with the code, the code wins — update the doc.
