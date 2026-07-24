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

await sql`DROP TABLE IF EXISTS synctrig_demo CASCADE`;
await sql`DROP TABLE IF EXISTS synctrig_bare CASCADE`;
await sql.end();
console.log('sync-triggers tests passed');
