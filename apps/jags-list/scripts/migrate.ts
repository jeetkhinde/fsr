import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from '../db/client.js';

try {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(fileURLToPath(dir)))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const text = await Bun.file(new URL(file, dir)).text();
    await sql.unsafe(text);
    console.log(`migrated: ${file}`);
  }
} finally {
  await sql.close();
}
