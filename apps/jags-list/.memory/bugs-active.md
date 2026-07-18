# Jag's List — Active Bugs

App-level bugs only. Framework bugs → repo root [`../../.memory/bugs-active.md`](../../.memory/bugs-active.md).

_None open._

## Integration notes (determined NOT to be framework bugs)

Recorded here so they aren't re-filed against the framework:

- **better-auth admin-plugin role type vs the app's domain roles** — normal
  cross-library integration friction; handled in `lib/auth.ts`.
- **bun's `SQL` binds JS arrays in `ANY()` differently from node-postgres** — a Bun
  runtime quirk, not Kiln's concern; handled in the app's test code.

(A third finding — Redis cache keys not app-namespaced — *was* a real framework gap
and became the `cache.namespace` config in PR #7, so it lives framework-side, not here.)
