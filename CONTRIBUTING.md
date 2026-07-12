# Contributing to Kiln

## Setup

```sh
bun install
```

This is a Bun-based monorepo (`packages/*`, `examples/*`, `test-app`). Some
tooling also reads `pnpm-lock.yaml` / `pnpm-workspace.yaml` — keep both in
sync with `package.json`'s `workspaces` field when adding a package.

## Workflow

- Never commit directly to `main`. Create a branch (or a `git worktree`) for
  your change.
- Build a package before testing cross-package consumption — `dist/` must be
  current:

  ```sh
  bun run build
  ```

- Type-check a package:

  ```sh
  bun run --cwd packages/<name> tsc --noEmit
  ```

- Run the unit suite:

  ```sh
  bun run test:unit
  ```

  Tests that need Postgres/Redis are excluded here and run separately via
  `bun run test:integration` (requires `test-app/.env`; see that script in
  the root `package.json` for the exact list).

## Pull requests

- Keep changes scoped — prefer several small PRs over one large one when the
  fixes are unrelated.
- Include a one-line rationale ("why", not just "what") in the PR
  description; commit messages should do the same.
- Update `.memory/bugs.md` / `.memory/active-work.md` if your change fixes a
  tracked issue or shifts what's actively in progress — these are the
  project's running context for both humans and AI agents working here.
