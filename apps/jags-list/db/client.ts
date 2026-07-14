import { SQL } from 'bun';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist';

export const sql = new SQL(databaseUrl);
