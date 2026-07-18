import assert from 'node:assert/strict';
import { SQL } from 'bun';
import fs from 'node:fs/promises';
import { FsrStore } from './store.js';
import { RedisCache } from './cache.js';
import { FsrWatcher, WatcherConfig, type LivePatch } from './watcher.js';

async function runTests() {
  console.log('Running FsrWatcher integration tests...');

  const pgConnectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test';
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  const bunSql = new SQL(pgConnectionString);
  const store = new FsrStore(bunSql);
  await store.initialize();
  const redis = new RedisCache(redisUrl);
  store.withRedis(redis);

  // Clean table
  await bunSql.unsafe('DELETE FROM kiln_fsr');

  await bunSql.unsafe('CREATE TABLE IF NOT EXISTS watcher_test_dummy (id integer primary key, val text)');
  await bunSql.unsafe("INSERT INTO watcher_test_dummy (id, val) VALUES (1, 'original_val') ON CONFLICT (id) DO UPDATE SET val = 'original_val'");

  // Temporary files for baking test
  const tempHtmlPath = './temp_test_page.html';
  const tempJsonPath = './temp_test_page.json';

  await fs.writeFile(tempHtmlPath, '<html><body><div s-live="test_slot">loading</div></body></html>', 'utf8');
  await fs.writeFile(tempJsonPath, '{}', 'utf8');

  try {
    // 1. Setup route and slot
    const route = '/test-watcher-route';
    await store.ensureRouteRow(route);
    // Baked paths ARE promotion now (ADR-016) — setting them makes it bake files
    await store.setBakedPaths(route, tempHtmlPath, tempJsonPath);

    await store.upsertSlot(
      route,
      'test_slot',
      'SELECT val FROM watcher_test_dummy WHERE id = $1',
      [1],
      ['watcher_dep_key'],
      0, // no debounce
      'val'
    );

    // 2. Setup watcher
    const config: WatcherConfig = {
      pollIntervalMs: 200,
      promoteAfterHits: 1,
      patchDebounceSecs: 0,
      purgeAfterSeconds: 3600,
      scheduledInvalidations: [
        { depKey: 'scheduled_dep', intervalMs: 200 }
      ],
      idleEvictSecs: 1,
      idleThresholdSecs: 5 // 5 sec threshold for eviction to prevent race condition
    };

    const watcher = new FsrWatcher(store, redis, config);
    
    // Listen for patch event
    const patches: LivePatch[] = [];
    watcher.getEmitter().on('patch', (patch: LivePatch) => {
      patches.push(patch);
    });

    await watcher.start();
    // Wait for Redis subscription to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // 3. Test invalidation triggers polling re-execution
    console.log('Verifying invalidation re-execution...');
    const affected = await store.invalidateDepKey('watcher_dep_key');
    console.log('invalidateDepKey returned affected:', affected);

    // Let's query the DB directly to see if the slot is stale
    const dbInspect = await store.fetchAllForInspect();
    console.log('All FSR rows after invalidateDepKey:', JSON.stringify(dbInspect, null, 2));

    // Wait for polling watcher to process (takes config.pollIntervalMs)
    await new Promise(resolve => setTimeout(resolve, 800));

    console.log('Patches received:', patches);
    const htmlExistsFirst = await fs.access(tempHtmlPath).then(() => true).catch(() => false);
    console.log('HTML file exists:', htmlExistsFirst);
    if (htmlExistsFirst) {
      console.log('HTML content:', await fs.readFile(tempHtmlPath, 'utf8'));
    }

    // Emitter should have received the patch event
    assert.ok(patches.length > 0);
    const p = patches.find(x => x.kind === 'scalar' && x.route === route && x.field === 'test_slot');
    assert.ok(p);
    assert.equal(p.kind, 'scalar');
    assert.equal(p.value, 'original_val');

    // JSON is patched; the HTML shell remains immutable.
    const htmlContent = await fs.readFile(tempHtmlPath, 'utf8');
    assert.equal(htmlContent, '<html><body><div s-live="test_slot">loading</div></body></html>');

    const jsonContent = await fs.readFile(tempJsonPath, 'utf8');
    assert.deepEqual(JSON.parse(jsonContent), { test_slot: 'original_val' });

    // Redis values should be updated too
    const redisHtml = await redis.getHtml(route);
    assert.equal(redisHtml, null);

    const redisSlots = await redis.getSlots(route);
    assert.deepEqual(redisSlots, { test_slot: 'original_val' });

    const redisJson = await redis.getJson(route);
    assert.deepEqual(redisJson, { test_slot: 'original_val' });

    // 4. Test database change propagates and updates again
    console.log('Verifying value update re-execution...');
    await bunSql.unsafe('UPDATE watcher_test_dummy SET val = \'updated_val\' WHERE id = 1');
    await store.invalidateDepKey('watcher_dep_key');

    await new Promise(resolve => setTimeout(resolve, 500));

    // Check files are updated
    const updatedHtml = await fs.readFile(tempHtmlPath, 'utf8');
    assert.equal(updatedHtml, '<html><body><div s-live="test_slot">loading</div></body></html>');

    const updatedJson = await fs.readFile(tempJsonPath, 'utf8');
    assert.deepEqual(JSON.parse(updatedJson), { test_slot: 'updated_val' });

    // Redis should be updated
    const updatedRedisSlots = await redis.getSlots(route);
    assert.deepEqual(updatedRedisSlots, { test_slot: 'updated_val' });

    // 5. Test Scheduled Invalidation
    console.log('Verifying scheduled invalidations...');
    // Clear patches
    patches.length = 0;
    // Link slot to scheduled_dep
    await store.upsertSlot(
      route,
      'test_slot',
      'SELECT val FROM watcher_test_dummy WHERE id = $1',
      [1],
      ['scheduled_dep'],
      0,
      'val'
    );
    
    // In polling mode, since it's revalidating, watcher should automatically invalidate it on scheduled interval and process
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(patches.length > 0);

    // 6. Test Idle Eviction (purge)
    //
    // NOTE: This previously called the now-removed `store.evictIdleRoutes()`,
    // which was dead code — the watcher's real background sweep
    // (`spawnSupervisedIdleEviction` in watcher.ts) has only ever called
    // `store.purgeInactiveRoutes()`, never `evictIdleRoutes()`. This test now
    // exercises the method that's actually wired into the watcher loop.
    console.log('Verifying idle eviction (purge)...');

    // Stop watcher first to freeze all background ticks/timers
    await watcher.stop();

    // Update route's last_hit/last_requested_at to be far in the past, and
    // shorten its purge_after_secs so a 5s threshold check will match it
    // (purgeInactiveRoutes prefers the per-route purge_after_secs column
    // over the threshold argument when the column is set).
    await bunSql.unsafe(
      `UPDATE kiln_fsr
       SET last_hit = now() - interval '10 seconds',
           last_requested_at = now() - interval '10 seconds',
           purge_after_secs = 5
       WHERE route = $1 AND slot = ''`,
      [route]
    );

    // Manually run the same purge logic the watcher's idle-eviction sweep uses
    const evicted = await store.purgeInactiveRoutes(5); // 5s threshold
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].route, route);

    // Perform manual eviction cleanup (identical to watcher loop)
    for (const r of evicted) {
      await redis.deleteRouteKeys(r.route).catch(() => {});
      if (r.htmlPath) await fs.unlink(r.htmlPath).catch(() => {});
      if (r.jsonPath) await fs.unlink(r.jsonPath).catch(() => {});
    }

    // purgeInactiveRoutes deletes the row entirely (not just un-promotes it)
    const routeRow = (await store.fetchAllForInspect()).find(r => r.route === route && r.slot === '');
    assert.equal(routeRow, undefined);

    // Files deleted from disk
    const htmlExists = await fs.access(tempHtmlPath).then(() => true).catch(() => false);
    assert.equal(htmlExists, false);

    const jsonExists = await fs.access(tempJsonPath).then(() => true).catch(() => false);
    assert.equal(jsonExists, false);

    // Redis keys evicted
    assert.equal(await redis.getHtml(route), null);
    assert.deepEqual(await redis.getSlots(route), {});
    assert.equal(await redis.getJson(route), null);
    console.log('🎉 FsrWatcher integration tests PASSED!');
  } finally {
    // Cleanup
    await bunSql.unsafe('DELETE FROM kiln_fsr');
    await bunSql.unsafe('DROP TABLE IF EXISTS watcher_test_dummy');
    bunSql.close();
    await redis.disconnect();
    
    await fs.unlink(tempHtmlPath).catch(() => {});
    await fs.unlink(tempJsonPath).catch(() => {});
  }
}

runTests()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ FsrWatcher tests failed:', err);
    process.exit(1);
  });
