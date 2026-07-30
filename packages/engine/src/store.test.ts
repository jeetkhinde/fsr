import assert from 'node:assert/strict';
import { SQL, RedisClient } from 'bun';
import { FsrStore } from './store.js';
import { RedisCache } from './cache.js';

async function runTests() {
  console.log('Running FsrStore and RedisCache integration tests...');

  const pgConnectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test';
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  // Unlike list-store.test.ts, this suite has always had a fallback URL, so a
  // missing DATABASE_URL doesn't announce itself — it surfaces later as an
  // opaque connection error. Probe first and skip with a clear reason instead.
  {
    const probe = new SQL(pgConnectionString);
    try {
      await probe`SELECT 1`;
    } catch (err: any) {
      console.warn(
        `[test] skipping FsrStore/RedisCache integration: cannot reach ${pgConnectionString} ` +
          `(${err?.message ?? err}). Set DATABASE_URL — see test-app/.env.example.`,
      );
      return;
    } finally {
      probe.close();
    }
  }

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

    // Mark fresh. fetchStaleSlots hands back the version it claimed the slot
    // at; markFresh takes it back so an invalidation arriving during the
    // requery isn't cleared (see the race section below).
    console.log('Testing markFresh...');
    assert.equal(typeof stale[0].version, 'number', 'a claimed slot carries its version');
    await store.markFresh('/test-route-1', 'slot_a', '', stale[0].version);
    stale = await store.fetchStaleSlots();
    assert.equal(stale.length, 0);

    // Task 6: a fresh render's re-upsertSlot (boot.ts step 12) must itself
    // clear staleness — that's how the dormant-rebuild-on-read flow (boot.ts)
    // "just works" without an extra explicit markFresh call. Re-invalidate
    // the slot, then upsert it again (as a fresh render would) and confirm
    // ON CONFLICT resets stale to FALSE.
    //
    // The render passes the version it observed BEFORE load() — see the
    // race-guard section further down for why clearing unconditionally is
    // unsafe. Here nothing invalidates mid-render, so the version still
    // matches and the flag clears.
    console.log('Testing upsertSlot resets stale on conflict (fresh render)...');
    await store.invalidateDepKey('dep_key_x');
    rows = await store.fetchAllForInspect();
    assert.equal(rows.find(r => r.slot === 'slot_a')?.stale, true, 'precondition: slot is stale again');
    const slotAVersion = (await store.fetchSlotVersions('/test-route-1'))['slot_a'];
    await store.upsertSlot(
      '/test-route-1',
      'slot_a',
      'SELECT val FROM t WHERE id = $1',
      { id: 10 },
      ['dep_key_x'],
      5,
      'val',
      '',
      slotAVersion
    );
    rows = await store.fetchAllForInspect();
    assert.equal(rows.find(r => r.slot === 'slot_a')?.stale, false, 'upsertSlot ON CONFLICT clears stale — a fresh render is fresh by definition');

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

    // 8b. user-scoped rows coexist with the shared row
    console.log('Testing user_key scoping...');
    await store.ensureRouteRow('/u-route', 300, 3600, 'json');
    await store.ensureRouteRow('/u-route', 300, 3600, 'json', 'u1');
    await store.setBakedPaths('/u-route', '/tmp/u1.html', '/tmp/u1.json', 'u1');
    assert.equal((await store.getPromotedPaths('/u-route'))?.htmlPath ?? null, null); // shared row unbaked
    assert.equal((await store.getPromotedPaths('/u-route', 'u1'))?.htmlPath, '/tmp/u1.html');
    await store.upsertSlot('/u-route', 'tasks', null, [], ['tasks_dep'], 0, null, 'u1');
    const uSlots = await store.fetchSlotsForSnapshot('/u-route', [], 'u1');
    assert.equal(uSlots.length, 1);
    assert.equal(uSlots[0].userKey, 'u1');
    assert.equal((await store.fetchSlotsForSnapshot('/u-route', [])).length, 0); // shared scope empty

    // owner-scoped invalidation (ADR-018): a depKey change with an owner marks
    // only that user's per-user row + the shared row stale, not other users'.
    console.log('Testing owner-scoped invalidation...');
    await store.ensureRouteRow('/owned', 300, 3600, 'json');            // shared
    await store.ensureRouteRow('/owned', 300, 3600, 'json', 'u1');
    await store.ensureRouteRow('/owned', 300, 3600, 'json', 'u2');
    await store.upsertSlot('/owned', 'feed', null, [], ['posts'], 0, null, '');   // shared slot
    await store.upsertSlot('/owned', 'feed', null, [], ['posts'], 0, null, 'u1'); // u1 slot
    await store.upsertSlot('/owned', 'feed', null, [], ['posts'], 0, null, 'u2'); // u2 slot
    await store.invalidateDepKey('posts', 'u1');
    const inspect = await store.fetchAllForInspect();
    const slotOf = (uk: string) => inspect.find(r => r.route === '/owned' && r.slot === 'feed' && r.userKey === uk);
    assert.equal(slotOf('')?.stale, true);   // shared always invalidated
    assert.equal(slotOf('u1')?.stale, true);  // owner invalidated
    assert.equal(slotOf('u2')?.stale, false); // other user untouched

    // 9. tombstone & isTombstoned
    console.log('Testing tombstone...');
    assert.equal(await store.isTombstoned('/test-route-1'), false);
    await store.tombstone('/test-route-1');
    assert.equal(await store.isTombstoned('/test-route-1'), true);

    rows = await store.fetchAllForInspect();
    assert.equal(rows.filter(r => r.route === '/test-route-1').every(r => r.stale === false), true);

    const clearedHtml = await redisCache.getHtml('/test-route-1');
    assert.equal(clearedHtml, null);
    const clearedSlots = await redisCache.getSlots('/test-route-1');
    assert.deepEqual(clearedSlots, {});
    const clearedJson = await redisCache.getJson('/test-route-1');
    assert.equal(clearedJson, null);

    // active/dormant tiers (ADR-018)
    console.log('Testing active/dormant freshness...');
    await store.ensureRouteRow('/active-r', 300, 3600, 'json');
    await store.ensureRouteRow('/dormant-r', 300, 3600, 'json');
    await store.upsertSlot('/active-r', 's', null, [], ['dep_x'], 0);
    await store.upsertSlot('/dormant-r', 's', null, [], ['dep_x'], 0);
    await store.invalidateDepKey('dep_x'); // both slots now stale
    await store.markActive('/active-r');    // only active-r pinged
    const active = await store.fetchStaleSlots({ activeWindowSecs: 60 });
    const routes = active.map((s) => s.route);
    assert.ok(routes.includes('/active-r'), 'active route revalidated eagerly');
    assert.ok(!routes.includes('/dormant-r'), 'dormant route NOT claimed eagerly');
    // dormant slot is still individually fetchable for on-read rebuild
    const dormant = await store.fetchDormantStaleSlot('/dormant-r');
    assert.equal(dormant?.slot, 's');

    // upsertSlot's stale-clearing races invalidation (ADR-018 follow-up).
    //
    // upsertSlot clears `stale` so a rebuild-on-read doesn't leave the flag
    // set forever. But a dependency write landing between the render's
    // load() and its upsertSlot must NOT have its stale=TRUE swallowed: on a
    // DORMANT route neither freshness tier would ever notice (the watcher
    // skips dormant routes, and the read path's rebuild triggers only on
    // stale=TRUE), so that snapshot would serve the pre-invalidation data
    // until the next dependency write. invalidateDepKey already bumps
    // `version`, so a version captured before load() is the guard.
    // Phase 4.3 (fine-grained debounce): each slot's OWN debounce_secs gates
    // whether fetchStaleSlots may claim it, falling back to the process-global
    // value only when the slot has none. The sweep timer is coarse, but slot
    // ELIGIBILITY is per-slot — which is what the roadmap item asked for. This
    // was already implemented and unasserted; the test exists so it cannot
    // silently regress into a single global window.
    console.log('Testing per-slot debounce gating...');
    await store.ensureRouteRow('/deb-r', 300, 3600, 'json');
    // slot_now: no debounce, claimable the moment it goes stale.
    await store.upsertSlot('/deb-r', 'slot_now', null, [], ['deb_dep'], 0);
    // slot_later: a one-hour debounce, and just patched — so even though the
    // same dep invalidates it, its own window has not elapsed.
    await store.upsertSlot('/deb-r', 'slot_later', null, [], ['deb_dep'], 3600);
    await store.markFresh('/deb-r', 'slot_later');
    await store.invalidateDepKey('deb_dep');

    // fetchAllForInspect also returns the route-level row (empty slot), so
    // filter to the two actual slots.
    const debRows = (await store.fetchAllForInspect()).filter(
      (r) => r.route === '/deb-r' && r.slot,
    );
    assert.equal(debRows.length, 2);
    assert.ok(debRows.every((r) => r.stale === true), 'both slots must be marked stale');

    const debStale = (await store.fetchStaleSlots()).filter((s) => s.route === '/deb-r');
    assert.deepEqual(
      debStale.map((s) => s.slot),
      ['slot_now'],
      'only the slot whose own debounce has elapsed may be claimed',
    );

    console.log('Testing upsertSlot stale/invalidation race guard...');
    await store.ensureRouteRow('/race-r', 300, 3600, 'json');
    await store.upsertSlot('/race-r', 's', null, [], ['race_dep'], 0);

    // Snapshot the version the way boot.ts does — BEFORE load() runs.
    const versionsBeforeLoad = await store.fetchSlotVersions('/race-r');
    assert.equal(typeof versionsBeforeLoad['s'], 'number', 'fetchSlotVersions returns a numeric version per slot');

    // ...an invalidation lands mid-render...
    await store.invalidateDepKey('race_dep');
    const staleOf = async (route: string, slot: string, userKey = '') =>
      (await store.fetchAllForInspect()).find(
        (r) => r.route === route && r.slot === slot && r.userKey === userKey,
      )?.stale;
    assert.equal(await staleOf('/race-r', 's'), true);

    // ...and the render finishes, upserting with its now-outdated version.
    // The guard must decline to clear: this render's data predates the write.
    await store.upsertSlot('/race-r', 's', null, [], ['race_dep'], 0, null, '', versionsBeforeLoad['s']);
    assert.equal(
      await staleOf('/race-r', 's'),
      true,
      'an invalidation during the render must survive upsertSlot',
    );

    // The next render captures the CURRENT version and does clear it —
    // otherwise the route would rebuild on every read forever.
    const versionsAfter = await store.fetchSlotVersions('/race-r');
    await store.upsertSlot('/race-r', 's', null, [], ['race_dep'], 0, null, '', versionsAfter['s']);
    assert.equal(
      await staleOf('/race-r', 's'),
      false,
      'an uncontended render still clears stale',
    );

    // No expectedVersion (a caller that cannot prove it observed a
    // pre-load version) leaves `stale` alone rather than clearing blind.
    await store.invalidateDepKey('race_dep');
    await store.upsertSlot('/race-r', 's', null, [], ['race_dep'], 0);
    assert.equal(
      await staleOf('/race-r', 's'),
      true,
      'omitting expectedVersion must not clear stale',
    );

    // A first-ever slot still starts fresh (INSERT path, column default).
    await store.upsertSlot('/race-r', 'brand-new', null, [], ['race_dep'], 0);
    assert.equal(await staleOf('/race-r', 'brand-new'), false, 'a newly inserted slot is not stale');
    assert.equal(
      (await store.fetchSlotVersions('/race-r'))['brand-new'],
      0,
      'a newly inserted slot starts at version 0',
    );

    // markFresh runs the same race on the watcher's side: it clears `stale`
    // after a requery, and an invalidation arriving between the claim and
    // that write would be swallowed. The claim (fetchStaleSlots) hands back
    // the version, which is the guard — same shape as upsertSlot's.
    console.log('Testing markFresh stale/invalidation race guard...');
    await store.ensureRouteRow('/mf-race', 300, 3600, 'json');
    await store.upsertSlot('/mf-race', 's', 'SELECT 1 AS val', [], ['mf_dep'], 0, 'val');
    await store.markActive('/mf-race');
    await store.invalidateDepKey('mf_dep');

    const claimed = (await store.fetchStaleSlots({ activeWindowSecs: 60 }))
      .find((s) => s.route === '/mf-race');
    assert.ok(claimed, 'precondition: the stale slot is claimed');
    assert.equal(typeof claimed!.version, 'number', 'the claim carries the slot version');

    // ...a dependency write lands while the watcher is requerying...
    await store.invalidateDepKey('mf_dep');
    // ...and the requery finishes, marking fresh with its now-outdated version.
    await store.markFresh('/mf-race', 's', '', claimed!.version);
    assert.equal(
      await staleOf('/mf-race', 's'),
      true,
      'an invalidation during the requery must survive markFresh',
    );

    // The claim IS released even when the flag survives, so the next tick can
    // re-claim and requery — otherwise the slot sits claimed for 30s.
    const reclaimed = (await store.fetchStaleSlots({ activeWindowSecs: 60 }))
      .find((s) => s.route === '/mf-race');
    assert.ok(reclaimed, 'a declined markFresh still releases the refresh claim');
    await store.markFresh('/mf-race', 's', '', reclaimed!.version);
    assert.equal(
      await staleOf('/mf-race', 's'),
      false,
      'an uncontended requery still clears stale',
    );

    // Omitted expectedVersion keeps the old unconditional clear — callers
    // that never claimed the slot (tests, manual freshening) still work.
    await store.invalidateDepKey('mf_dep');
    await store.markFresh('/mf-race', 's');
    assert.equal(
      await staleOf('/mf-race', 's'),
      false,
      'markFresh without expectedVersion clears unconditionally',
    );

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
