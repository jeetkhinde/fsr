import { sql } from '../db/client.js';

try {
  const migration = await Bun.file(
    new URL('../migrations/0000_init.sql', import.meta.url),
  ).text();

  await sql.unsafe(migration);
  console.log('address-book migration: ok');
} finally {
  await sql.close();
}
