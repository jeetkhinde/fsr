import { createKilnSql } from '@kiln/core/sql';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist';

// createKilnSql wraps bun's SQL so any query run inside a page's load()
// (which boot.ts already runs inside withDepCapture) records the tables it
// touched into that request's auto-deps scope — see Task 3/4 (auto-deps) and
// packages/core/src/sql.ts. Outside a capture scope this behaves exactly
// like `new SQL(url)`.
export const sql = createKilnSql(databaseUrl);
