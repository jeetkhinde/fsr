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
    // 5b. Per-user loader revalidation (bake='user', ADR-017): a user-scoped
    // slot goes stale, the (route,user) loader re-runs, and the patch lands in
    // THAT user's artifact with userKey attached — never the shared row's.
    console.log('Verifying per-user loader revalidation...');
    const uRoute = '/test-user-route';
    const uHtmlPath = './temp_user_page.html';
    const uJsonPath = './temp_user_page.json';
    await fs.writeFile(uHtmlPath, '<html><body><div s-live="greeting">loading</div></body></html>', 'utf8');
    await fs.writeFile(uJsonPath, JSON.stringify({ schemaVersion: 1, renderVersion: 3, data: { greeting: 'old' }, updatedAt: new Date().toISOString() }), 'utf8');
    await store.ensureRouteRow(uRoute, 300, 3600, 'json', 'u1');
    await store.setBakedPaths(uRoute, uHtmlPath, uJsonPath, 'u1');
    await store.upsertSlot(uRoute, 'greeting', null, [], ['user_dep_key'], 0, null, 'u1');
    watcher.registerLoader({ route: uRoute, userKey: 'u1', load: async () => ({ greeting: 'hi-u1' }) });
    patches.length = 0;
    await store.invalidateDepKey('user_dep_key');
    await new Promise(resolve => setTimeout(resolve, 800));
    const up = patches.find(x => x.kind === 'scalar' && x.route === uRoute && (x as any).field === 'greeting') as any;
    assert.ok(up, 'expected a per-user scalar patch');
    assert.equal(up.value, 'hi-u1');
    assert.equal(up.userKey, 'u1');
    const uJson = JSON.parse(await fs.readFile(uJsonPath, 'utf8'));
    assert.equal(uJson.data.greeting, 'hi-u1');
    const rowsAfterUser = await store.fetchAllForInspect();
    const uSlotRow = rowsAfterUser.find(r => r.route === uRoute && r.slot === 'greeting');
    assert.equal(uSlotRow?.stale, false);
    assert.equal(uSlotRow?.userKey, 'u1');

    // 5b-1. unregisterRoute must clear loaderTargets for ALL userKey variants
    // of the route, not just a bare (non-existent) `route` key — loaderTargets
    // is always keyed via loaderKey(route, userKey), which appends a userKey
    // suffix even for the shared/no-user case, so a bare-route delete can
    // never hit a real entry. Prove the loader is actually gone by
    // invalidating the same dep key again post-unregister and confirming
    // nothing fires.
    console.log('Verifying unregisterRoute clears per-user loaderTargets...');
    watcher.unregisterRoute(uRoute);
    patches.length = 0;
    await store.invalidateDepKey('user_dep_key');
    await new Promise(resolve => setTimeout(resolve, 800));
    const upAfterUnregister = patches.find(x => x.kind === 'scalar' && x.route === uRoute && (x as any).field === 'greeting');
    assert.equal(upAfterUnregister, undefined, 'loader should not fire after unregisterRoute');
    const rowsAfterUnregister = await store.fetchAllForInspect();
    const uSlotRowAfterUnregister = rowsAfterUnregister.find(r => r.route === uRoute && r.slot === 'greeting');
    assert.equal(uSlotRowAfterUnregister?.stale, true, 'slot should remain stale since no loader ran to mark it fresh');

    // unregisterRoute must also drop the same route's local-active marks —
    // they're keyed identically, and a leftover mark keeps boot.ts's read
    // path skipping its dormant-staleness check for a route that no longer
    // has a loader keeping it fresh.
    watcher.markLocallyActive(uRoute, 'u1');
    watcher.markLocallyActive(uRoute);           // shared variant too
    watcher.markLocallyActive('/other-route', 'u1');
    watcher.unregisterRoute(uRoute);
    assert.equal(watcher.isLocallyActive(uRoute, 'u1', 60), false, 'per-user local-active mark cleared');
    assert.equal(watcher.isLocallyActive(uRoute, undefined, 60), false, 'shared local-active mark cleared');
    assert.equal(
      watcher.isLocallyActive('/other-route', 'u1', 60),
      true,
      'a different route is untouched — the prefix scan must not over-match'
    );

    await fs.unlink(uHtmlPath).catch(() => {});
    await fs.unlink(uJsonPath).catch(() => {});

    // 5b-2. unregisterLoader (Plan-2 review #4): bounds loaderTargets — a
    // registration removed via unregisterLoader must not fire on a later
    // invalidation of its dep key.
    console.log('Verifying loader unregistration...');
    const urRoute = '/unreg-route';
    await store.ensureRouteRow(urRoute, 300, 3600, 'json', 'u9');
    await store.setBakedPaths(urRoute, './tmp_unreg.html', './tmp_unreg.json', 'u9');
    await fs.writeFile('./tmp_unreg.html', '<html><body><div s-live="g">x</div></body></html>');
    await fs.writeFile('./tmp_unreg.json', JSON.stringify({ schemaVersion: 1, renderVersion: 1, data: { g: 'old' }, updatedAt: new Date().toISOString() }));
    await store.upsertSlot(urRoute, 'g', null, [], ['unreg_dep'], 0, null, 'u9');
    let fired = 0;
    watcher.registerLoader({ route: urRoute, userKey: 'u9', load: async () => { fired++; return { g: 'new' }; } });
    watcher.unregisterLoader(urRoute, 'u9');
    patches.length = 0;
    await store.invalidateDepKey('unreg_dep', 'u9');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fired, 0, 'unregistered loader must not run');
    await fs.unlink('./tmp_unreg.html').catch(() => {});
    await fs.unlink('./tmp_unreg.json').catch(() => {});

    // 5b-3. markLocallyActive/isLocallyActive (Plan 3 review Important #2):
    // the same-process activity signal routekit's boot.ts consults so its
    // read path can skip the Postgres dormant-staleness check for a route
    // this process just confirmed active via SSE subscribe. Pure in-memory,
    // no store/DB round trip involved.
    console.log('Verifying markLocallyActive/isLocallyActive...');
    assert.equal(
      watcher.isLocallyActive('/la-route', '', 60),
      false,
      'never marked -> not locally active'
    );
    watcher.markLocallyActive('/la-route', '');
    assert.equal(
      watcher.isLocallyActive('/la-route', '', 60),
      true,
      'marked within window -> locally active'
    );
    assert.equal(
      watcher.isLocallyActive('/la-route', '', 0),
      false,
      'a zero-second window is never satisfied, even immediately after marking'
    );
    assert.equal(
      watcher.isLocallyActive('/la-route', 'someone-else', 60),
      false,
      'marking is scoped per (route, userKey) — another userKey on the same route is unaffected'
    );
    watcher.unregisterLoader('/la-route', '');
    assert.equal(
      watcher.isLocallyActive('/la-route', '', 60),
      false,
      'unregisterLoader clears the local-active record too (purge hygiene)'
    );

    // 5c. Watcher activeWindowSecs gate (Task 6): the eager tick loop passes
    // { activeWindowSecs } through to store.fetchStaleSlots, so it only
    // eagerly revalidates stale slots on routes pinged via markActive within
    // the window — a dormant route's stale slot is left unclaimed for lazy
    // rebuild-on-read instead (exercised in routekit's boot.test.ts).
    //
    // The original `watcher` above runs with no activeWindowSecs (eager,
    // unconditional claiming) and would otherwise race to claim these test
    // slots before the gated `awWatcher` below gets a chance to — stop it
    // first so this section is deterministic. (Idle eviction below calls
    // stop() again; that's idempotent.)
    await watcher.stop();

    console.log('Verifying watcher activeWindowSecs gate...');
    const awRoute = '/test-activewindow-route';
    const awDormantRoute = '/test-activewindow-dormant-route';
    await store.ensureRouteRow(awRoute);
    await store.ensureRouteRow(awDormantRoute);
    await store.upsertSlot(awRoute, 'aw_slot', 'SELECT val FROM watcher_test_dummy WHERE id = $1', [1], ['aw_dep_key'], 0, 'val');
    await store.upsertSlot(awDormantRoute, 'aw_slot', 'SELECT val FROM watcher_test_dummy WHERE id = $1', [1], ['aw_dep_key'], 0, 'val');

    const awConfig: WatcherConfig = {
      pollIntervalMs: 200,
      patchDebounceSecs: 0,
      purgeAfterSeconds: 3600,
      scheduledInvalidations: [],
      activeWindowSecs: 60,
    };
    const awWatcher = new FsrWatcher(store, redis, awConfig);
    const awPatches: LivePatch[] = [];
    awWatcher.getEmitter().on('patch', (patch: LivePatch) => { awPatches.push(patch); });
    await awWatcher.start();
    await new Promise(resolve => setTimeout(resolve, 300));

    await store.markActive(awRoute); // only awRoute pinged as active
    await store.invalidateDepKey('aw_dep_key'); // both routes' slots go stale
    await new Promise(resolve => setTimeout(resolve, 800));

    const awPatchedRoutes = new Set(awPatches.map(p => p.route));
    assert.ok(awPatchedRoutes.has(awRoute), 'active route revalidated eagerly by watcher tick');
    assert.ok(!awPatchedRoutes.has(awDormantRoute), 'dormant route NOT eagerly revalidated by watcher tick');

    // The dormant route's stale slot is still individually fetchable for
    // boot.ts's lazy rebuild-on-read path.
    const awDormantSlot = await store.fetchDormantStaleSlot(awDormantRoute);
    assert.equal(awDormantSlot?.slot, 'aw_slot');

    // Now mark the dormant route active too and confirm the NEXT tick claims it.
    awPatches.length = 0;
    await store.markActive(awDormantRoute);
    await new Promise(resolve => setTimeout(resolve, 800));
    const awPatchedRoutesAfterActivation = new Set(awPatches.map(p => p.route));
    assert.ok(
      awPatchedRoutesAfterActivation.has(awDormantRoute),
      'previously-dormant route revalidated eagerly once marked active'
    );

    await awWatcher.stop();

    // 5d. markFresh race guard, end to end through a real watcher tick.
    //
    // The watcher claims a stale slot, requeries it, then marks it fresh. An
    // invalidation arriving in that window must survive — otherwise the slot
    // is left holding the value from BEFORE the write, with its stale flag
    // cleared, and (on a dormant route) nothing ever revisits it. The guard
    // is the version fetchStaleSlots claimed at, handed back to markFresh.
    //
    // The window is forced open here by making the requery block: the slot's
    // query sleeps, and the invalidation fires while it's in flight.
    console.log('Verifying markFresh race guard through a watcher tick...');
    const mfRoute = '/test-markfresh-race';
    await store.ensureRouteRow(mfRoute);
    await store.upsertSlot(
      mfRoute,
      'mf_slot',
      "SELECT pg_sleep(0.6), val FROM watcher_test_dummy WHERE id = $1",
      [1],
      ['mf_dep_key'],
      0,
      'val'
    );
    await store.markActive(mfRoute);

    const mfWatcher = new FsrWatcher(store, redis, {
      pollIntervalMs: 200,
      patchDebounceSecs: 0,
      purgeAfterSeconds: 3600,
      scheduledInvalidations: [],
      activeWindowSecs: 60,
    });

    // Exactly ONE tick, via runOnce() rather than start(). The surviving
    // stale flag is a transient state that the very next tick legitimately
    // clears — it re-claims at the new version, requeries uncontended, and
    // marks fresh for real. A polling watcher plus a fixed sleep therefore
    // races its own recovery: this assertion is only meaningful if no second
    // tick has run yet. (It was written that way originally and flaked ~50%.)
    await store.invalidateDepKey('mf_dep_key');
    const mfTick = mfWatcher.runOnce();               // claims, then blocks on pg_sleep
    await new Promise(resolve => setTimeout(resolve, 200)); // inside the sleep window
    await store.invalidateDepKey('mf_dep_key');       // lands mid-requery
    await mfTick;                                     // markFresh runs with the stale version

    const mfRow = (await store.fetchAllForInspect())
      .find(r => r.route === mfRoute && r.slot === 'mf_slot');
    assert.equal(
      mfRow?.stale,
      true,
      'an invalidation arriving mid-requery must survive the watcher\'s markFresh'
    );

    // ...and the recovery really does happen on the next tick: the claim was
    // released, so a second, uncontended pass clears the flag for real.
    await mfWatcher.runOnce();
    const mfRowAfter = (await store.fetchAllForInspect())
      .find(r => r.route === mfRoute && r.slot === 'mf_slot');
    assert.equal(
      mfRowAfter?.stale,
      false,
      'the next uncontended tick re-requeries and clears the flag'
    );

    console.log('Verifying idle eviction (purge)...');

    // Stop watcher first to freeze all background ticks/timers
    await watcher.stop();

    // Update route's last_requested_at to be far in the past, and
    // shorten its purge_after_secs so a 5s threshold check will match it
    // (purgeInactiveRoutes prefers the per-route purge_after_secs column
    // over the threshold argument when the column is set).
    await bunSql.unsafe(
      `UPDATE kiln_fsr
       SET last_requested_at = now() - interval '10 seconds',
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
