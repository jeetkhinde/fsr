import { createKilnSql } from '@kiln/core/sql';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist';

// createKilnSql wraps bun's SQL so any query run inside a page's load()
// (which boot.ts already runs inside withDepCapture) records the tables it
// touched into that request's auto-deps scope — see Task 3/4 (auto-deps) and
// packages/core/src/sql.ts. Outside a capture scope this behaves exactly
// like `new SQL(url)`.
//
// A module-level singleton, which is what makes it shared — and what makes
// closing it from a test's afterAll() a mistake. `bun test` runs every test
// FILE sequentially inside ONE process, so every suite in the app imports
// this same instance. The first afterAll() to call sql.close() therefore
// leaves a dead pool for every file that runs after it, and they all fail
// with ERR_POSTGRES_CONNECTION_CLOSED before their first assertion. That is
// deterministic, not a race: the files never overlap.
//
// Nothing needs to close it here. The pool's lifetime is the process's —
// under `bun test` bun tears it down at exit (verified: exit 0, no hang),
// and in the server it stays open for as long as the server runs. The
// one-shot scripts under scripts/ DO close it, correctly: they are their own
// process and exist to terminate.
export const sql = createKilnSql(databaseUrl);
