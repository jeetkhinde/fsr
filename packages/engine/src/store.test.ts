import assert from 'node:assert/strict';
import { SQL, RedisClient } from 'bun';
import { FsrStore } from './store.js';
import { RedisCache } from './cache.js';

async function runTests() {
  console.log('Running FsrStore and RedisCache integration tests...');

  const pgConnectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test';
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  const bunSql = new SQL(pgConnectionString);
  const store = new FsrStore(bunSql);
  await store.initialize();
  const redisCache = new RedisCache(redisUrl);
  store.withRedis(redisCache);

  // Setup sub client for Redis pub/sub verification
  const subClient = new RedisClient(redisUrl);
  const receivedPubSub: string[] = [];
  await subClient.subscribe('kiln:invalidate', (_msg: string) => {
    receivedPubSub.push(`kiln:invalidate:${_msg}`);
  });
  await subClient.subscribe('kiln:patch', (_msg: string) => {
    receivedPubSub.push(`kiln:patch:${_msg}`);
  });

  // Clean table before starting tests
  await bunSql.unsafe('DELETE FROM kiln_fsr');

  try {
    // 1. ensureRouteRow and basic checks
    console.log('Testing ensureRouteRow...');
    await store.ensureRouteRow('/test-route-1', 300, 3600, 'json');
    const inspectRowsAfterEnsure = await store.fetchAllForInspect();
    assert.equal(inspectRowsAfterEnsure.length, 1);
    assert.equal(inspectRowsAfterEnsure[0].route, '/test-route-1');
    assert.equal(inspectRowsAfterEnsure[0].slot, '');
    assert.equal(inspectRowsAfterEnsure[0].promoted, false);

    // 2. promoted is artifact presence: setBakedPaths flips it, clearing resets it
    console.log('Testing promoted-as-artifact-presence...');
    await store.setBakedPaths('/test-route-1', '/tmp/presence.html', '/tmp/presence.json');
    let rows = await store.fetchAllForInspect();
    assert.equal(rows[0].promoted, true);
    await store.setBakedPaths('/test-route-1', null, null);
    rows = await store.fetchAllForInspect();
    assert.equal(rows[0].promoted, false);

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
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(receivedPubSub.some(msg => msg.startsWith('kiln:invalidate:')));
    const invalidateMsg = receivedPubSub.find(msg => msg.startsWith('kiln:invalidate:'))!;
    assert.ok(invalidateMsg.includes('/test-route-1'));
    assert.ok(invalidateMsg.includes('dep_key_x'));

    // Fetch stale slots
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
    assert.equal(stale.length, 0);

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

    await redisCache.publishPatch({ route: '/test-route-1', slot: 'slot_a', value: 'hello' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(receivedPubSub.some(msg => msg.startsWith('kiln:patch:')));

    // 9. tombstone & isTombstoned
    console.log('Testing tombstone...');
    assert.equal(await store.isTombstoned('/test-route-1'), false);
    await store.tombstone('/test-route-1');
    assert.equal(await store.isTombstoned('/test-route-1'), true);

    rows = await store.fetchAllForInspect();
    assert.equal(rows.every(r => r.stale === false), true);

    const clearedHtml = await redisCache.getHtml('/test-route-1');
    assert.equal(clearedHtml, null);
    const clearedSlots = await redisCache.getSlots('/test-route-1');
    assert.deepEqual(clearedSlots, {});
    const clearedJson = await redisCache.getJson('/test-route-1');
    assert.equal(clearedJson, null);

    console.log('🎉 FsrStore and RedisCache integration tests PASSED!');
  } finally {
    await bunSql.unsafe('DELETE FROM kiln_fsr');
    bunSql.close();
    await redisCache.disconnect();
    subClient.close();
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Tests failed with error:', err);
    process.exit(1);
  });
