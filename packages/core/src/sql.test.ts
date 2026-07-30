import assert from 'node:assert';
import { createKilnSql, withDepCapture } from './sql.js';

const sql = createKilnSql(process.env.DATABASE_URL!);

// Bound methods must be referentially stable. The Proxy's get trap used to
// re-bind on every access, so `sql.unsafe !== sql.unsafe` — which breaks
// identity comparison and any caller memoizing on the function reference, and
// allocated a fresh closure per property read. Needs no database.
assert.strictEqual(
  (sql as any).unsafe,
  (sql as any).unsafe,
  'sql.unsafe must be the same reference across accesses',
);
assert.strictEqual((sql as any).begin, (sql as any).begin, 'sql.begin must be stable');
console.log('createKilnSql bound-method identity tests passed');

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

// A dynamic table name arrives as an identifier helper, so the template's
// static text is just `SELECT id FROM  ? ` and extractTables finds nothing.
// Over-capture is harmless, but this is UNDER-capture — the silent direction,
// where a live field simply never revalidates — so it has to say something.
const warnings: string[] = [];
const origWarn = console.warn;
const captureWarnings = () => { warnings.length = 0; console.warn = (...a: any[]) => { warnings.push(a.join(' ')); }; };

captureWarnings();
try {
  await withDepCapture(async () => { await sql`SELECT id FROM ${sql('captest')}`; });
} finally { console.warn = origWarn; }
assert.ok(
  warnings.some((w) => /auto-deps/i.test(w)),
  `an unparseable table reference must warn; got ${JSON.stringify(warnings)}`,
);

// …but a query that legitimately touches no table must stay silent, or the
// warning becomes noise everyone learns to ignore.
captureWarnings();
try {
  await withDepCapture(async () => { await sql`SELECT 1 AS x`; });
} finally { console.warn = origWarn; }
assert.equal(warnings.length, 0, `SELECT 1 touches no table and must not warn; got ${JSON.stringify(warnings)}`);

// Outside a capture scope there is nothing to under-capture, so no warning.
captureWarnings();
try {
  await sql`SELECT id FROM ${sql('captest2')}`;
} finally { console.warn = origWarn; }
assert.equal(warnings.length, 0, `no capture scope means no auto-deps to miss; got ${JSON.stringify(warnings)}`);

console.log('auto-deps under-capture warning tests passed');

await sql`DROP TABLE IF EXISTS captest CASCADE`;
await sql`DROP TABLE IF EXISTS captest2 CASCADE`;
await sql.end();
console.log('createKilnSql capture tests passed');
