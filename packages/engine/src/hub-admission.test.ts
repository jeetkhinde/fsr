/**
 * Cross-process SSE admission must survive an ungraceful shutdown.
 *
 * The old design was a bare INCR with the matching DECR only in the stream's
 * finally block: a SIGKILL/OOM orphaned every in-flight connection's increment
 * permanently, the counter drifted up across restarts, and once it passed
 * maxConnections EVERY new subscription was refused app-wide until someone
 * deleted the Redis key by hand. See bugs-active.md §1.3.
 *
 * Needs Redis only (no Postgres).
 */
import assert from 'node:assert/strict';
import { RedisClient } from 'bun';
import { createRedisAdmission } from './hub.js';

const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');
const KEY = 'kiln:test:fsr:connections';
const STALE_MS = 1000;

const reset = () => redis.send('DEL', [KEY]);
const count = async () => Number(await redis.send('ZCARD', [KEY]));

await reset();

// 1. A live connection occupies a slot.
{
  const a = createRedisAdmission(redis, KEY, 1, STALE_MS);
  assert.equal(await a.admit(), true, 'first connection must be admitted');
  const b = createRedisAdmission(redis, KEY, 1, STALE_MS);
  assert.equal(await b.admit(), false, 'a live connection must still consume the only slot');
  assert.equal(await count(), 1, 'a rejected admission must not leave itself behind');
  await a.release();
  assert.equal(await count(), 0, 'release must free the slot');
}

// 2. THE REGRESSION: an entry left behind by a process that died must not hold
//    a slot forever. Simulate one by writing a member with an old heartbeat.
await reset();
{
  await redis.send('ZADD', [KEY, String(Date.now() - STALE_MS * 5), 'conn-from-a-dead-process']);
  assert.equal(await count(), 1, 'precondition: the orphan is present');

  const fresh = createRedisAdmission(redis, KEY, 1, STALE_MS);
  assert.equal(
    await fresh.admit(),
    true,
    'an orphan from a crashed process must age out, not refuse every future connection',
  );
  assert.equal(await count(), 1, 'the orphan must be pruned, leaving only the live connection');
  await fresh.release();
}

// 3. A connection that keeps heartbeating must NOT be pruned as an orphan,
//    however long it stays open.
await reset();
{
  const longLived = createRedisAdmission(redis, KEY, 1, STALE_MS);
  assert.equal(await longLived.admit(), true);
  await Bun.sleep(STALE_MS + 200); // it would now look stale…
  await longLived.refresh(); // …but the heartbeat says otherwise

  const other = createRedisAdmission(redis, KEY, 1, STALE_MS);
  assert.equal(
    await other.admit(),
    false,
    'a refreshed connection is alive and must keep its slot',
  );
  await longLived.release();
}

// 4. The key must not outlive the app that made it — a permanently orphaned
//    zset is the same class of leak this fix exists to remove.
await reset();
{
  const a = createRedisAdmission(redis, KEY, 1, STALE_MS);
  await a.admit();
  const ttl = Number(await redis.send('TTL', [KEY]));
  assert.ok(ttl > 0, `the connections key must carry a TTL backstop; got ${ttl}`);
  await a.release();
}

await reset();
redis.close?.();
console.log('SSE admission crash-recovery tests passed');
