import assert from 'node:assert/strict';
import pg from 'pg';
import { SQL } from 'bun';
import { FsrStore } from './store.js';
import { FsrWatcher, WatcherConfig } from './watcher.js';
import { startDbNotificationPipeline } from './db-notify.js';

async function runTests() {
  console.log('Running FSR DB Notification Pipeline tests...');

  const pgConnectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test';

  // Bun SQL for FsrStore; pg.Pool for test setup and LISTEN/NOTIFY trigger queries
  const bunSql = new SQL(pgConnectionString);
  const store = new FsrStore(bunSql);
  await store.initialize();
  const pool = new pg.Pool({ connectionString: pgConnectionString });

  // Clean table
  await pool.query('DELETE FROM kiln_fsr');
  await pool.query('DROP TABLE IF EXISTS notify_test_dummy CASCADE');
  await pool.query('CREATE TABLE notify_test_dummy (id integer primary key, val text)');
  
  // Create postgres notify function
  await pool.query(`
    CREATE OR REPLACE FUNCTION kiln_notify_change() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify(
        'kiln_invalidate',
        json_build_object('depKey', TG_ARGV[0], 'id', NEW.id)::text
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Create trigger
  await pool.query(`
    CREATE TRIGGER notify_test_dummy_trigger
    AFTER INSERT OR UPDATE ON notify_test_dummy
    FOR EACH ROW EXECUTE FUNCTION kiln_notify_change('notify_test_dummy');
  `);

  const route = '/test-notify-route';
  await store.ensureRouteRow(route);
  // Link slot to collection key (notify_test_dummy)
  await store.upsertSlot(route, 'slot_col', 'SELECT val FROM notify_test_dummy WHERE id = $1', [1], ['notify_test_dummy'], 0, 'val');
  // Link slot to dynamic row key (notify_test_dummy:1)
  await store.upsertSlot(route, 'slot_row', 'SELECT val FROM notify_test_dummy WHERE id = $1', [1], ['notify_test_dummy:1'], 0, 'val');

  const config: WatcherConfig = {
    pollIntervalMs: 200,
    patchDebounceSecs: 0,
    purgeAfterSeconds: 3600,
    scheduledInvalidations: [],
    idleEvictSecs: 0,
    idleThresholdSecs: 0
  };

  const watcher = new FsrWatcher(store, null, config);
  // Do not start watcher loop so slots remain stale for assertion
  const notifyClient = await startDbNotificationPipeline(pgConnectionString, store, watcher);

  try {
    console.log('Inserting row into notify_test_dummy to trigger notifications...');
    // This should fire the trigger and notify 'notify_test_dummy' and 'notify_test_dummy:1'
    await pool.query('INSERT INTO notify_test_dummy (id, val) VALUES (1, \'hello_db\')');

    // Wait briefly for pg notification to deliver and database update to finish
    await new Promise(resolve => setTimeout(resolve, 300));

    // Both slot rows should be marked stale in the database
    const rows = await store.fetchAllForInspect();
    const slotCol = rows.find(r => r.slot === 'slot_col');
    const slotRow = rows.find(r => r.slot === 'slot_row');

    assert.ok(slotCol);
    assert.equal(slotCol.stale, true);

    assert.ok(slotRow);
    assert.equal(slotRow.stale, true);

    console.log('🎉 FSR DB Notification Pipeline tests PASSED!');
  } finally {
    await pool.query('DELETE FROM kiln_fsr');
    await pool.query('DROP TABLE IF EXISTS notify_test_dummy CASCADE');
    await pool.end();
    await notifyClient.end();
    await watcher.stop();
    bunSql.close();
  }
}

runTests().catch(err => {
  console.error('❌ DB Notification Pipeline tests failed:', err);
  process.exit(1);
});
