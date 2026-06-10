import assert from 'node:assert/strict';
import { SQL } from 'bun';
import { FsrStore } from './store.js';
import { FsrWatcher, WatcherConfig } from './watcher.js';
import { fsrHubStream, fsrSnapshotHandler, getActiveConnectionsCount } from './hub.js';

async function runTests() {
  console.log('Running FSR SSE Hub and Snapshot tests...');

  const pgConnectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test';

  const bunSql = new SQL(pgConnectionString);
  const store = new FsrStore(bunSql);
  await store.initialize();

  await bunSql.unsafe('DELETE FROM kiln_fsr');
  await bunSql.unsafe('CREATE TABLE IF NOT EXISTS hub_test_dummy (id integer primary key, val text)');
  await bunSql.unsafe("INSERT INTO hub_test_dummy (id, val) VALUES (1, 'val_1'), (2, 'val_2') ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val");

  const route = '/test-hub-route';
  await store.ensureRouteRow(route, 1);
  await store.upsertSlot(route, 'slot_1', 'SELECT val FROM hub_test_dummy WHERE id = $1', [1], [], 0, 'val');
  await store.upsertSlot(route, 'slot_2', 'SELECT val FROM hub_test_dummy WHERE id = $1', [2], [], 0, 'val');

  const config: WatcherConfig = {
    pollIntervalMs: 500,
    promoteAfterHits: 1,
    patchDebounceSecs: 0,
    purgeAfterSeconds: 3600,
    scheduledInvalidations: [],
    idleEvictSecs: 0,
    idleThresholdSecs: 0
  };

  const watcher = new FsrWatcher(store, null, config);

  try {
    // 1. Test fsrSnapshotHandler
    console.log('Testing fsrSnapshotHandler...');
    const snapshotAll = await fsrSnapshotHandler(route, [], store);
    assert.deepEqual(snapshotAll, {
      slot_1: 'val_1',
      slot_2: 'val_2'
    });

    const snapshotSpecific = await fsrSnapshotHandler(route, ['slot_2'], store);
    assert.deepEqual(snapshotSpecific, {
      slot_2: 'val_2'
    });

    // 2. Test fsrHubStream maxConnections check
    console.log('Testing fsrHubStream maxConnections limit...');
    const connections: any[] = [];
    const streamConfig = {
      maxConnections: 2,
      connectionTtlSecs: 5,
      keepaliveSecs: 1
    };

    const gen1 = fsrHubStream({ route, slots: [], watcher, config: streamConfig });
    const gen2 = fsrHubStream({ route, slots: [], watcher, config: streamConfig });
    
    // Call next() to start execution and increment activeConnectionsCount
    const p1 = gen1.next();
    const p2 = gen2.next();

    // The third connection should immediately throw an error
    let threw = false;
    try {
      const gen3 = fsrHubStream({ route, slots: [], watcher, config: streamConfig });
      await gen3.next(); // trigger execution start
    } catch (err: any) {
      assert.ok(err.message.includes('limit reached'));
      threw = true;
    }
    assert.equal(threw, true);

    // Consume/return generators to clean up activeConnectionsCount
    await gen1.return();
    await gen2.return();
    // Wait for the background promises to finish
    await p1;
    await p2;
    assert.equal(getActiveConnectionsCount(), 0);

    // 3. Test fsrHubStream message delivery & filtering
    console.log('Testing fsrHubStream event filtering...');
    const gen = fsrHubStream({
      route,
      slots: ['slot_1'],
      watcher,
      config: { maxConnections: 10, connectionTtlSecs: 10, keepaliveSecs: 10 }
    });

    // Start consuming stream in background
    const items: any[] = [];
    const runStream = async () => {
      for await (const val of gen) {
        if (val.event === 'ready') continue;
        items.push(val);
      }
    };
    const streamPromise = runStream();

    // Trigger watcher emitter patch events
    const emitter = watcher.getEmitter();
    // 1. Patch for matching route and matching slot
    emitter.emit('patch', { route, slot: 'slot_1', value: 'new_val_1' });
    // 2. Patch for matching route but non-matching slot (should be filtered out)
    emitter.emit('patch', { route, slot: 'slot_2', value: 'new_val_2' });
    // 3. Patch for different route (should be filtered out)
    emitter.emit('patch', { route: '/other-route', slot: 'slot_1', value: 'other_val' });

    // Wait briefly for stream to process
    await new Promise(resolve => setTimeout(resolve, 100));

    // Force stream completion
    await gen.return();
    await streamPromise;

    // Check we received only the matching patch
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      event: 'fsr',
      data: JSON.stringify({ slot_1: 'new_val_1' })
    });

    // 4. Test Keepalive heartbeat
    console.log('Testing keepalive heartbeat...');
    const genHeartbeat = fsrHubStream({
      route,
      slots: [],
      watcher,
      config: { maxConnections: 10, connectionTtlSecs: 10, keepaliveSecs: 0.1 } // 100ms keepalive
    });

    const heartbeatItems: any[] = [];
    const heartbeatPromise = (async () => {
      for await (const val of genHeartbeat) {
        if (val.event === 'ready') continue;
        heartbeatItems.push(val);
        if (heartbeatItems.length >= 2) break; // stop after 2 keepalives
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 300));
    await genHeartbeat.return();
    await heartbeatPromise;

    assert.ok(heartbeatItems.length >= 2);
    assert.deepEqual(heartbeatItems[0], { data: '' });

    console.log('🎉 FSR SSE Hub and Snapshot tests PASSED!');
  } finally {
    await bunSql.unsafe('DELETE FROM kiln_fsr');
    await bunSql.unsafe('DROP TABLE IF EXISTS hub_test_dummy');
    bunSql.close();
  }
}

runTests().catch(err => {
  console.error('❌ Hub tests failed:', err);
  process.exit(1);
});
