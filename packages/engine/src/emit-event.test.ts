/**
 * kiln_emit_event must tolerate any primary-key shape.
 *
 * The trigger is AFTER ... FOR EACH ROW, so an error raised inside it aborts
 * the APPLICATION's write — not just the invalidation. Declaring record_id as
 * BIGINT and assigning NEW.id unconditionally therefore turned a UUID PK (or a
 * table with no `id` at all) into a hard write failure. See bugs-active.md §1.1.
 */
import assert from 'node:assert/strict';
import { SQL } from 'bun';
import { FsrStore } from './store.js';

const sql = new SQL(process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test');
const store = new FsrStore(sql);
await store.initialize(); // installs kiln_emit_event

const TABLES = ['emitev_uuid', 'emitev_noid', 'emitev_bigint'] as const;
const cleanup = async () => {
  for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await sql`DELETE FROM kiln_fsr_events WHERE payload->>'depKey' LIKE 'emitev_%'`;
};
const attach = (t: string) =>
  sql.unsafe(
    `CREATE TRIGGER ${t}_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON ${t} ` +
    `FOR EACH ROW EXECUTE FUNCTION kiln_emit_event('${t}')`,
  );
const lastPayload = async (depKey: string) => {
  const rows = await sql`
    SELECT payload FROM kiln_fsr_events
    WHERE payload->>'depKey' = ${depKey} ORDER BY id DESC LIMIT 1`;
  return rows.length ? rows[0].payload : null;
};

await cleanup();

// 1. A UUID primary key must not break the write, and must still identify the row.
await sql`CREATE TABLE emitev_uuid (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`;
await attach('emitev_uuid');
const [uuidRow] = await sql`INSERT INTO emitev_uuid (name) VALUES ('a') RETURNING id`;
const uuidPayload = await lastPayload('emitev_uuid');
assert.ok(uuidPayload, 'a UUID-keyed insert must still emit an invalidation event');
assert.equal(
  String(uuidPayload.id),
  String(uuidRow.id),
  'the uuid must survive into the payload so `depKey:id` still targets the row',
);

// 2. A table with no `id` column at all must not break the write either.
//    Row-level targeting is impossible, so the id is simply absent — the
//    table-level depKey still invalidates, which is the safe direction.
await sql`CREATE TABLE emitev_noid (tenant text, slug text, PRIMARY KEY (tenant, slug))`;
await attach('emitev_noid');
await sql`INSERT INTO emitev_noid (tenant, slug) VALUES ('acme', 'hello')`;
const noidPayload = await lastPayload('emitev_noid');
assert.ok(noidPayload, 'an id-less insert must still emit a table-level invalidation event');
assert.equal(
  noidPayload.id ?? null,
  null,
  'no id column means no row-level key — the watcher skips `depKey:id` on null',
);

// 3. Regression: a BIGSERIAL id must keep producing the SAME `depKey:id`
//    string the watcher builds today, or every existing row-level dep breaks.
await sql`CREATE TABLE emitev_bigint (id BIGSERIAL PRIMARY KEY, name text)`;
await attach('emitev_bigint');
const [bigRow] = await sql`INSERT INTO emitev_bigint (name) VALUES ('b') RETURNING id`;
const bigPayload = await lastPayload('emitev_bigint');
assert.ok(bigPayload, 'a bigint-keyed insert must still emit an invalidation event');
assert.equal(
  `emitev_bigint:${bigPayload.id}`,
  `emitev_bigint:${bigRow.id}`,
  'the row-level dep key string must be byte-identical to the pre-fix behaviour',
);

// 4. DELETE reads OLD, not NEW — same tolerance required.
await sql`DELETE FROM emitev_uuid WHERE id = ${uuidRow.id}`;
const deletePayload = await lastPayload('emitev_uuid');
assert.equal(
  String(deletePayload.id),
  String(uuidRow.id),
  'DELETE must read the uuid off OLD without casting it to bigint',
);

await cleanup();
await sql.end();
console.log('kiln_emit_event PK-shape tests passed');
