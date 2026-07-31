# Contributing to Kiln

## Setup

```sh
bun install
cp test-app/.env.example test-app/.env   # then point the URLs at your local Postgres/Redis
```

`test-app/.env` is gitignored, so every fresh clone **and every new `git
worktree`** needs that copy — otherwise the integration suites run with no
`DATABASE_URL` (`bun --env-file=` ignores a missing file without complaint) and
fail with an opaque `database "<your-unix-user>" does not exist`.
`bun run preflight` checks this on its own and is the first step of
`test:integration`.

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
  `bun run test:integration` (requires `test-app/.env` — see Setup; the script
  in the root `package.json` has the exact list). It runs `bun run preflight`
  first, which fails fast if that file is missing a required key and warns if
  Postgres or Redis is unreachable.

## Pull requests

- Keep changes scoped — prefer several small PRs over one large one when the
  fixes are unrelated.
- Include a one-line rationale ("why", not just "what") in the PR
  description; commit messages should do the same.
- Update `.memory/bugs.md` / `.memory/active-work.md` if your change fixes a
  tracked issue or shifts what's actively in progress — these are the
  project's running context for both humans and AI agents working here.
