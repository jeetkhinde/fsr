import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { FsrStore } from './store.js';
import { RedisCache } from './cache.js';
import { Redis } from 'ioredis';

async function runTests() {
  console.log('Running FsrStore and RedisCache integration tests...');

  const pgConnectionString = 'postgresql://localhost:5432/pilcrowjs_test';
  const redisUrl = 'redis://127.0.0.1:6379';

  const pool = new pg.Pool({ connectionString: pgConnectionString });
  const db = drizzle(pool);
  const store = new FsrStore(db);
  const redisCache = new RedisCache(redisUrl);
  store.withRedis(redisCache);

  // Setup sub client for Redis pub/sub verification
  const subClient = new Redis(redisUrl);
  const receivedPubSub: string[] = [];
  await subClient.subscribe('pilcrow:invalidate', 'pilcrow:patch');
  subClient.on('message', (channel, message) => {
    receivedPubSub.push(`${channel}:${message}`);
  });

  // Clean table before starting tests
  await pool.query('DELETE FROM pilcrow_fsr');

  try {
    // 1. ensureRouteRow and basic checks
    console.log('Testing ensureRouteRow...');
    await store.ensureRouteRow('/test-route-1', 3);
    const inspectRowsAfterEnsure = await store.fetchAllForInspect();
    assert.equal(inspectRowsAfterEnsure.length, 1);
    assert.equal(inspectRowsAfterEnsure[0].route, '/test-route-1');
    assert.equal(inspectRowsAfterEnsure[0].slot, '');
    assert.equal(inspectRowsAfterEnsure[0].promoted, false);
    assert.equal(inspectRowsAfterEnsure[0].hitCount, 0);

    // 2. incrementHit (Normal)
    console.log('Testing incrementHit...');
    let hitStatus = await store.incrementHit('/test-route-1');
    assert.equal(hitStatus, 'Normal');
    
    // Check hit_count is 1
    let rows = await store.fetchAllForInspect();
    assert.equal(rows[0].hitCount, 1);
    assert.equal(rows[0].promoted, false);

    // 3. incrementHit (JustPromoted when reaching promoteAfter limit)
    hitStatus = await store.incrementHit('/test-route-1'); // hit = 2
    assert.equal(hitStatus, 'Normal');
    hitStatus = await store.incrementHit('/test-route-1'); // hit = 3
    assert.equal(hitStatus, 'JustPromoted');

    rows = await store.fetchAllForInspect();
    assert.equal(rows[0].hitCount, 3);
    assert.equal(rows[0].promoted, true);

    // 4. upsertSlot and fetchStaleSlots
    console.log('Testing upsertSlot...');
    await store.upsertSlot(
      '/test-route-1',
      'slot_a',
      'SELECT val FROM t WHERE id = $1',
      { id: 10 },
      ['dep_key_x'],
      5, // debounceSecs
      'val'
    );

    // Let's mark it stale manually by invalidating dep key
    console.log('Testing invalidateDepKey...');
    const affected = await store.invalidateDepKey('dep_key_x');
    assert.deepEqual(affected, ['/test-route-1']);

    // Check it's marked stale
    rows = await store.fetchAllForInspect();
    const slotRow = rows.find(r => r.slot === 'slot_a');
    assert.ok(slotRow);
    assert.equal(slotRow.stale, true);
    assert.equal(slotRow.version, 1);

    // Let's verify Redis pub/sub received the invalidation message
    // Wait briefly for pub/sub to register
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(receivedPubSub.some(msg => msg.startsWith('pilcrow:invalidate:')));
    const invalidateMsg = receivedPubSub.find(msg => msg.startsWith('pilcrow:invalidate:'))!;
    assert.ok(invalidateMsg.includes('/test-route-1'));
    assert.ok(invalidateMsg.includes('dep_key_x'));

    // Fetch stale slots
    // Note: since it's just invalidated, last_patched_at is NULL, so fetchStaleSlots should fetch it
    console.log('Testing fetchStaleSlots...');
    let stale = await store.fetchStaleSlots();
    assert.equal(stale.length, 1);
    assert.equal(stale[0].slot, 'slot_a');
    assert.equal(stale[0].query, 'SELECT val FROM t WHERE id = $1');
    assert.deepEqual(stale[0].queryParams, { id: 10 });
    assert.deepEqual(stale[0].dependsOn, ['dep_key_x']);

    // Mark fresh
    console.log('Testing markFresh...');
    await store.markFresh('/test-route-1', 'slot_a');
    stale = await store.fetchStaleSlots();
    assert.equal(stale.length, 0); // No longer stale

    // 5. getPromotedPaths & setBakedPaths
    console.log('Testing setBakedPaths and getPromotedPaths...');
    await store.setBakedPaths('/test-route-1', '/tmp/baked.html', '/tmp/baked.json');
    const paths = await store.getPromotedPaths('/test-route-1');
    assert.ok(paths);
    assert.equal(paths.htmlPath, '/tmp/baked.html');
    assert.equal(paths.jsonPath, '/tmp/baked.json');

    // 6. fetchSlotsForSnapshot
    console.log('Testing fetchSlotsForSnapshot...');
    const snapshotSlots = await store.fetchSlotsForSnapshot('/test-route-1', []);
    assert.equal(snapshotSlots.length, 1);
    assert.equal(snapshotSlots[0].slot, 'slot_a');

    const snapshotSpecific = await store.fetchSlotsForSnapshot('/test-route-1', ['slot_a']);
    assert.equal(snapshotSpecific.length, 1);

    const snapshotEmpty = await store.fetchSlotsForSnapshot('/test-route-1', ['non_existent']);
    assert.equal(snapshotEmpty.length, 0);

    // 7. invalidateRoute
    console.log('Testing invalidateRoute...');
    await store.invalidateRoute('/test-route-1');
    rows = await store.fetchAllForInspect();
    assert.equal(rows.find(r => r.slot === 'slot_a')?.stale, true);

    // 8. Redis Cache tests directly
    console.log('Testing RedisCache directly...');
    await redisCache.setHtml('/test-route-1', '<div>test</div>');
    const cachedHtml = await redisCache.getHtml('/test-route-1');
    assert.equal(cachedHtml, '<div>test</div>');

    await redisCache.patchSlot('/test-route-1', 'slot_a', 'new_val');
    const slotsMap = await redisCache.getSlots('/test-route-1');
    assert.deepEqual(slotsMap, { slot_a: 'new_val' });

    await redisCache.setJson('/test-route-1', { score: 100 });
    const cachedJson = await redisCache.getJson('/test-route-1');
    assert.deepEqual(cachedJson, { score: 100 });

    // Publish patch
    await redisCache.publishPatch({ route: '/test-route-1', slot: 'slot_a', value: 'hello' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(receivedPubSub.some(msg => msg.startsWith('pilcrow:patch:')));

    // 9. tombstone & isTombstoned
    console.log('Testing tombstone...');
    assert.equal(await store.isTombstoned('/test-route-1'), false);
    await store.tombstone('/test-route-1');
    assert.equal(await store.isTombstoned('/test-route-1'), true);

    // Check database rows are updated
    rows = await store.fetchAllForInspect();
    assert.equal(rows.every(r => r.stale === false), true); // all stale set to false on tombstone

    // Verify Redis keys deleted
    const clearedHtml = await redisCache.getHtml('/test-route-1');
    assert.equal(clearedHtml, null);
    const clearedSlots = await redisCache.getSlots('/test-route-1');
    assert.deepEqual(clearedSlots, {});
    const clearedJson = await redisCache.getJson('/test-route-1');
    assert.equal(clearedJson, null);

    console.log('🎉 FsrStore and RedisCache integration tests PASSED!');
  } finally {
    // Clean up
    await pool.query('DELETE FROM pilcrow_fsr');
    await pool.end();
    await redisCache.disconnect();
    await subClient.quit();
  }
}

runTests().catch((err) => {
  console.error('❌ Tests failed with error:', err);
  process.exit(1);
});
