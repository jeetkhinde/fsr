import assert from 'node:assert';
import { createKilnSql, withDepCapture } from './sql.js';

const sql = createKilnSql(process.env.DATABASE_URL!);
await sql`DROP TABLE IF EXISTS captest CASCADE`;
await sql`CREATE TABLE captest (id INT)`;
await sql`INSERT INTO captest VALUES (1)`;

// inside a capture scope, a SELECT records its table
const { result, tables } = await withDepCapture(async () => {
  return await sql`SELECT id FROM captest WHERE id = 1`;
});
assert.equal(result[0].id, 1);
assert.ok(tables.has('captest'), `expected captest in ${[...tables]}`);

// join captures both tables
await sql`DROP TABLE IF EXISTS captest2 CASCADE`;
await sql`CREATE TABLE captest2 (id INT)`;
const { tables: joined } = await withDepCapture(async () => {
  return await sql`SELECT a.id FROM captest a JOIN captest2 b ON a.id = b.id`;
});
assert.ok(joined.has('captest') && joined.has('captest2'), [...joined].join(','));

// no scope → no throw, query still works
const rows = await sql`SELECT id FROM captest`;
assert.equal(rows[0].id, 1);

await sql`DROP TABLE IF EXISTS captest CASCADE`;
await sql`DROP TABLE IF EXISTS captest2 CASCADE`;
await sql.end();
console.log('createKilnSql capture tests passed');
