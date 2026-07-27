import assert from 'node:assert';
import { SQL } from 'bun';
import { syncTriggers, triggerName } from './sync-triggers.js';

const sql = new SQL(process.env.DATABASE_URL!);
await sql`DROP TABLE IF EXISTS synctrig_demo CASCADE`;
await sql`CREATE TABLE synctrig_demo (id BIGSERIAL PRIMARY KEY, owner_id TEXT)`;
// kiln_emit_event must exist — apply the engine schema first in real runs;
// here assume the shared test DB already has it (store.test.ts initializes it).

// 1. create
let res = await syncTriggers(sql, [{ table: 'synctrig_demo', ownerColumn: 'owner_id' }], { check: false });
assert.equal(res[0].action, 'created');
const exists = await sql`
  SELECT 1 FROM pg_trigger WHERE tgname = ${triggerName('synctrig_demo')} AND NOT tgisinternal`;
assert.equal(exists.length, 1);

// 2. idempotent
res = await syncTriggers(sql, [{ table: 'synctrig_demo', ownerColumn: 'owner_id' }], { check: false });
assert.equal(res[0].action, 'exists');

// 3. --check on a table WITHOUT a trigger reports missing, creates nothing
await sql`DROP TABLE IF EXISTS synctrig_bare CASCADE`;
await sql`CREATE TABLE synctrig_bare (id BIGSERIAL PRIMARY KEY)`;
res = await syncTriggers(sql, [{ table: 'synctrig_bare' }], { check: true });
assert.equal(res[0].action, 'missing');
const bare = await sql`SELECT 1 FROM pg_trigger WHERE tgname = ${triggerName('synctrig_bare')} AND NOT tgisinternal`;
assert.equal(bare.length, 0);

// 4. definition drift: adding/removing ownerColumn (or changing depKey/events)
// in config must NOT read as "exists" — the old trigger is still installed and
// would keep emitting the old payload shape. --check reports it, a real run
// recreates it.
res = await syncTriggers(sql, [{ table: 'synctrig_demo' }], { check: true });
assert.equal(res[0].action, 'outdated', 'dropping ownerColumn must be detected as drift, not "exists"');
let def = await sql`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = ${triggerName('synctrig_demo')} AND NOT tgisinternal`;
assert.ok(String(def[0].def).includes("'owner_id'"), '--check must not have rewritten the trigger');

res = await syncTriggers(sql, [{ table: 'synctrig_demo' }], { check: false });
assert.equal(res[0].action, 'updated');
def = await sql`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = ${triggerName('synctrig_demo')} AND NOT tgisinternal`;
assert.ok(!String(def[0].def).includes("'owner_id'"), 'recreated trigger must drop the stale owner arg');

// 5. narrowing `events` is drift too
res = await syncTriggers(sql, [{ table: 'synctrig_demo', events: ['insert'] }], { check: true });
assert.equal(res[0].action, 'outdated');
res = await syncTriggers(sql, [{ table: 'synctrig_demo', events: ['insert'] }], { check: false });
assert.equal(res[0].action, 'updated');
res = await syncTriggers(sql, [{ table: 'synctrig_demo', events: ['insert'] }], { check: false });
assert.equal(res[0].action, 'exists', 'a matching definition is still idempotent');

// 6. an event value outside the whitelist is rejected before reaching SQL
await assert.rejects(
  async () => syncTriggers(sql, [{ table: 'synctrig_demo', events: ['truncate' as any] }], { check: false }),
  /unsupported trigger event/,
);

// 7. A mixed-case table name in config must fold the way Postgres folds an
// unquoted identifier. Postgres stores `CREATE TABLE SyncTrigMixed` as
// `synctrigmixed`, and auto-deps' extractTables lowercases what it captures —
// so a verbatim `SyncTrigMixed` depKey could never match a captured dep, and a
// verbatim trigger NAME could never match the folded one Postgres actually
// stored (making the existence probe miss and every run re-CREATE).
await sql`DROP TABLE IF EXISTS SyncTrigMixed CASCADE`;
await sql`CREATE TABLE SyncTrigMixed (id BIGSERIAL PRIMARY KEY)`;
res = await syncTriggers(sql, [{ table: 'SyncTrigMixed' }], { check: false });
assert.equal(res[0].action, 'created');
def = await sql`
  SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
  WHERE tgname = 'synctrigmixed_kiln_invalidate' AND NOT tgisinternal`;
assert.equal(def.length, 1, 'trigger name must be the folded one Postgres stores');
assert.ok(
  String(def[0].def).includes("kiln_emit_event('synctrigmixed')"),
  `default depKey must fold to match what extractTables captures; got ${def[0]?.def}`,
);

// …and folding must be stable, or every sync re-creates the same trigger.
res = await syncTriggers(sql, [{ table: 'SyncTrigMixed' }], { check: false });
assert.equal(res[0].action, 'exists', 'a mixed-case config must still be idempotent');

// An EXPLICIT depKey is an arbitrary user-chosen string, not an identifier —
// it is matched verbatim against hand-written dependsOn lists, so it must NOT
// be folded.
res = await syncTriggers(sql, [{ table: 'SyncTrigMixed', depKey: 'MyCustomKey' }], { check: false });
assert.equal(res[0].action, 'updated');
def = await sql`
  SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
  WHERE tgname = 'synctrigmixed_kiln_invalidate' AND NOT tgisinternal`;
assert.ok(
  String(def[0].def).includes("kiln_emit_event('MyCustomKey')"),
  'an explicit depKey must survive verbatim',
);

await sql`DROP TABLE IF EXISTS synctrig_demo CASCADE`;
await sql`DROP TABLE IF EXISTS synctrig_bare CASCADE`;
await sql`DROP TABLE IF EXISTS SyncTrigMixed CASCADE`;
await sql.end();
console.log('sync-triggers tests passed');
