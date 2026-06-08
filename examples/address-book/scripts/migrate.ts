import { sql } from '../db/client.js';

const migration = await Bun.file(
  new URL('../migrations/0000_init.sql', import.meta.url),
).text();

try {
  await sql.unsafe(migration);
  console.log('address-book migration: ok');
} finally {
  await sql.close();
}
