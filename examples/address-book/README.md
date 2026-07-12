# Address Book (Kiln example)

A full Kiln app demonstrating FSR (`Live.list`), server actions, and the
layout-caching rules — a directory of contacts backed by Postgres.

## Prerequisites

- [Bun](https://bun.sh)
- PostgreSQL running locally (or reachable via `DATABASE_URL`)
- Redis (optional — only needed for FSR cache fronting at scale)

## Setup

1. From the monorepo root, install dependencies:

   ```sh
   pnpm install
   ```

2. Copy the env template and adjust if your Postgres/Redis aren't on the
   defaults:

   ```sh
   cp .env.example .env
   ```

   | Variable | Default | Purpose |
   |---|---|---|
   | `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/postgres` | Postgres connection used by FSR and the contacts store |
   | `REDIS_URL` | `redis://localhost:6379` | Optional FSR cache front |
   | `PORT` | `3100` | Dev server port |

3. Run migrations:

   ```sh
   bun run db:migrate
   ```

4. Start the dev server:

   ```sh
   bun run dev
   ```

   The app serves at `http://127.0.0.1:3100/contacts`.

## Tests

- `bun test` — unit tests (`db/validation.test.ts`, `tests/routes.test.ts`); no
  database needed, these run against route `load()`/action logic directly.
- `bun run test:db` — the Postgres integration suite (`db/contacts.integration.test.ts`);
  needs `DATABASE_URL` pointed at a running, migrated Postgres. This one is
  excluded from the monorepo-wide `bun run test:unit` at the repo root.
- `bun run test:e2e` — Playwright E2E tests (`tests/address-book.spec.ts`); starts
  the dev server itself via `webServer` in `playwright.config.ts`.
