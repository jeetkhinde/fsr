import { SQL } from 'bun';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/postgres';

export const sql = new SQL(databaseUrl);
