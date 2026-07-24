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

// Non-tagged-template calling conventions (bun-sql supports several) must
// pass through untouched instead of crashing when a capture scope is active
// (Plan 3 review Important #3). sql(obj) — the Helper-style call used to
// wrap a plain object for insertion (e.g. `sql\`insert into t ${sql(row)}\``)
// — is the clearest reproduction: a plain object has no `.join`, so the old
// unconditional `strings.join(' ? ')` threw a TypeError — but only when a
// capture scope was active (i.e. only inside a page's real load() via
// withDepCapture; outside a scope the crash line was never reached).
await withDepCapture(async () => {
  const objHelper = (sql as any)({ a: 1, b: 2 });
  assert.ok(objHelper, 'sql(obj) must not throw inside a capture scope');
  assert.deepEqual(objHelper.columns, ['a', 'b']);

  // Same for the array form — sql(arrayForInsert) — which also lacks the
  // `.raw` property that marks a genuine tagged-template call, even though
  // arrays happen to have their own (unrelated) `.join` method.
  const arrHelper = (sql as any)([1, 2, 3]);
  assert.ok(arrHelper, 'sql(array) must not throw inside a capture scope');
});
console.log('non-template calling conventions inside a capture scope did not throw');

await sql`DROP TABLE IF EXISTS captest CASCADE`;
await sql`DROP TABLE IF EXISTS captest2 CASCADE`;
await sql.end();
console.log('createKilnSql capture tests passed');
