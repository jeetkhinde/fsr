# Jag's List — App Entrypoint & Rules

This is a **Kiln application** (`apps/jags-list`), not the framework. Keep app
context here; keep framework context at the repo root. Other AI tools: do **not**
merge the two.

## Where things live

- **App memory** (this app's work log, bugs, decisions): [.memory/](.memory/)
- **App docs / specs / plans**: [docs/](docs/) — e.g.
  `docs/superpowers/specs/2026-07-14-jags-list-design.md`,
  `docs/superpowers/plans/2026-07-14-jags-list-01-foundation.md`
- **Framework memory & docs** (Kiln itself): repo root [`../../.memory/`](../../.memory/)
  and [`../../docs/`](../../docs/) — read these for how the framework works, but do
  **not** add app-specific notes there.

## Boundary rule

A framework *bug* surfaced while building this app belongs in the framework's
`../../.memory/bugs-active.md`. An app-level task, decision, or workaround belongs
here in `.memory/`. When in doubt: "is this true for every Kiln app, or just this
one?" — universal → framework; app-only → here.
