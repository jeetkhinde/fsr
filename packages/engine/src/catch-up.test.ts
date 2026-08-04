/**
 * Event catch-up: the recovery path that runs only after something else has
 * already gone wrong, and was therefore never exercised.
 *
 * Two defects, both silent, found 2026-08-01:
 *
 *  1. `fetchEventsSince` returned the jsonb `payload` untouched and bun's SQL
 *     hands jsonb back as a **string**, so `const { depKey } = event.payload`
 *     in the watcher always got `undefined`. Every event was a no-op — while
 *     the cursor still advanced past it, so the events were consumed and
 *     unrecoverable. Catch-up had never invalidated anything.
 *
 *  2. Catch-up was private and called only from `FsrWatcher.start()`, so a
 *     mid-life LISTEN drop re-subscribed, logged "reconnected to Postgres" and
 *     replayed nothing. Combined with (1): missed events were recovered never.
 *
 * Also pins the guard added with the fix — a cold start with no cursor must
 * adopt the current head rather than replay all of `kiln_fsr_events`, which is
 * never pruned. That one only became a hazard once catch-up started working.
 *
 * Third defect, fixed 2026-08-04: the cursor was a file on the process's local
 * disk while the events it indexed lived in shared Postgres. A container with
 * no persistent cache dir therefore found no cursor on every restart, adopted
 * the current head, and could never recover a restart-sized gap — catch-up
 * worked, but only for a process that got its own disk back. The cursor now
 * lives in `kiln_fsr_cursor`, shared by the fleet, which is the right home for
 * it because replay's only effect is on the shared `kiln_fsr` tables.
 *
 * Plain script, not a `bun:test` suite, matching the other integration tests
 * run one-per-invocation by `bun run test:integration`.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQL } from 'bun';
import { FsrStore } from './store.js';
import { FsrWatcher } from './watcher.js';
import { startDbNotificationPipeline } from './db-notify.js';

const DEP = 'kiln_catchup_test_dep';
const ROUTE = '/__kiln-catchup-test';

async function runTests() {
  console.log('Running FSR event catch-up integration tests...');

  const url = process.env.DATABASE_URL || 'postgresql://localhost:5432/kilnjs_test';
  {
    const probe = new SQL(url);
    try {
      await probe`SELECT 1`;
    } catch (err: any) {
      console.warn(
        `[test] skipping catch-up integration: cannot reach ${url} (${err?.message ?? err}). ` +
          `Set DATABASE_URL — see test-app/.env.example.`,
      );
      return;
    } finally {
      probe.close();
    }
  }

  const sql = new SQL(url);
  const store = new FsrStore(sql);
  await store.initialize();

  const cleanup = async () => {
    await sql`DELETE FROM kiln_fsr WHERE route = ${ROUTE}`;
    await sql`DELETE FROM kiln_fsr_events WHERE payload->>'depKey' = ${DEP}`;
  };
  // The cursor is one shared row now, not a per-process file, so a test that
  // wants "no cursor anywhere" has to say so explicitly — an earlier case in
  // this file will have left one behind.
  const clearCursor = async () => {
    await sql`DELETE FROM kiln_fsr_cursor`;
  };
  const readCursor = async (): Promise<number | null> => store.readEventCursor();
  const seedSlot = async () => {
    await cleanup();
    await store.upsertSlot(ROUTE, '', null, null, []);
    await store.upsertSlot(ROUTE, 'probe', null, null, [DEP]);
    await sql`UPDATE kiln_fsr SET stale = FALSE WHERE route = ${ROUTE}`;
  };
  const isStale = async (): Promise<boolean> => {
    const rows = await sql`SELECT stale FROM kiln_fsr WHERE route = ${ROUTE} AND slot = 'probe'`;
    return !!rows[0]?.stale;
  };
  const emitEvent = async (): Promise<number> => {
    const rows = await sql`
      INSERT INTO kiln_fsr_events (event_type, payload)
      VALUES ('UPDATE', ${JSON.stringify({ depKey: DEP })}::jsonb) RETURNING id`;
    return Number(rows[0].id);
  };
  const makeWatcher = (cacheDir: string) =>
    new FsrWatcher(store, null, {
      // Big poll interval: these assertions are about catch-up, not the sweep.
      pollIntervalMs: 3_600_000,
      patchDebounceSecs: 0,
      purgeAfterSeconds: 2_592_000,
      revalidateSeconds: 0,
      purgeSweepSeconds: 0,
      scheduledInvalidations: [],
      cacheDir,
    });
  const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'kiln-catchup-'));

  // 1. The decode itself. This is the assertion that fails if jsonb ever comes
  //    back as a raw string again.
  {
    await cleanup();
    const id = await emitEvent();
    const events = await store.fetchEventsSince(id - 1);
    const event = events.find((e) => e.id === id);
    assert.ok(event, 'fetchEventsSince did not return the event just inserted');
    assert.equal(
      typeof event!.payload,
      'object',
      'payload must be decoded, not handed back as a jsonb string',
    );
    assert.equal(event!.payload.depKey, DEP, 'decoded payload lost its depKey');
    console.log('  ✓ fetchEventsSince decodes the jsonb payload');
  }

  // 2. Crash then restart, on a container that does NOT share the old one's
  //    disk — the case a local cursor file could never handle. The replacement
  //    instance starts with an empty cache dir, so the only thing that can tell
  //    it where the stream got to is the shared cursor row.
  //
  //    This is the assertion that fails on the pre-Postgres cursor: an empty
  //    dir read as "no cursor", which meant adopt-head, which meant the whole
  //    restart-sized gap was dropped without a word.
  {
    await clearCursor();
    await seedSlot();
    const first = makeWatcher(await tmpDir());
    await first.start(); // adopts the current head as its cursor
    await first.stop();

    await emitEvent(); // arrives while nothing is running
    assert.equal(await isStale(), false, 'precondition: slot should still be fresh');

    const second = makeWatcher(await tmpDir()); // different container, empty disk
    await second.catchUpMissedEvents();
    await second.stop();
    assert.equal(
      await isStale(),
      true,
      'a replacement instance with no local cursor file did not replay the restart gap',
    );
    console.log('  ✓ a restart on fresh local disk replays events missed while down');
  }

  // 3. A LISTEN drop mid-life. The regression that logged "reconnected to
  //    Postgres" and dropped the whole gap.
  {
    const dir = await tmpDir();
    await clearCursor();
    await seedSlot();
    const watcher = makeWatcher(dir);
    await watcher.start();
    const client = await startDbNotificationPipeline(url, store, watcher);

    // Kill the listener's backend the way a restart or failover would.
    const killed = await sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE query LIKE 'LISTEN kiln_invalidate%' AND pid <> pg_backend_pid()`;
    assert.ok(killed.length > 0, 'expected to terminate at least one LISTEN backend');

    await emitEvent(); // emitted while disconnected: no notification will arrive

    // Reconnect backoff starts at 1s; give it room without being flaky.
    let recovered = false;
    for (let i = 0; i < 60; i++) {
      if (await isStale()) {
        recovered = true;
        break;
      }
      await Bun.sleep(250);
    }
    await watcher.stop();
    try {
      await client.end();
    } catch {}
    assert.ok(recovered, 'a LISTEN reconnect did not replay the events missed during the gap');
    console.log('  ✓ a LISTEN reconnect replays events missed during the gap');
  }

  // 4. Cold start must not stampede. kiln_fsr_events is never pruned, so
  //    replaying from 0 whenever the cursor is absent would invalidate against
  //    the app's entire history on every fresh deploy.
  {
    const dir = await tmpDir(); // empty: no legacy file either
    await clearCursor();
    await seedSlot();
    await emitEvent(); // history exists and is unprocessed

    const fresh = makeWatcher(dir);
    await fresh.catchUpMissedEvents();
    await fresh.stop();
    assert.equal(
      await isStale(),
      false,
      'a cold start with no cursor replayed history instead of adopting the current head',
    );
    assert.ok(
      (await readCursor() ?? 0) > 0,
      'cold start should persist the adopted head as the shared cursor',
    );
    console.log('  ✓ a cold start adopts the current head instead of replaying all history');
  }

  // 5. The cursor only ever moves forward. Instances advance it concurrently
  //    and out of order; a late write from a lagging one must not rewind the
  //    fleet's mark and re-open a window a peer already closed.
  {
    await clearCursor();
    await store.writeEventCursor(500);
    await store.writeEventCursor(499);
    assert.equal(await readCursor(), 500, 'a lower write dragged the shared cursor backwards');
    await store.writeEventCursor(501);
    assert.equal(await readCursor(), 501, 'the cursor refused a legitimate forward write');
    assert.equal(
      typeof (await readCursor()),
      'number',
      'cursor must be decoded from BIGINT, not left as the string bun returns',
    );
    console.log('  ✓ the shared cursor is monotonic and numeric');
  }

  // 6. Upgrade shim: a process coming from the file-cursor version must adopt
  //    the mark its predecessor left on disk rather than adopting head — the
  //    one restart where the gap would otherwise still be lost.
  {
    await clearCursor();
    await seedSlot();
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'cursor'), String(await store.getLatestEventId()), 'utf8');

    await emitEvent(); // emitted during the upgrade restart

    const upgraded = makeWatcher(dir);
    await upgraded.catchUpMissedEvents();
    await upgraded.stop();
    assert.equal(await isStale(), true, 'the upgrade shim ignored the pre-Postgres cursor file');
    assert.ok(
      (await readCursor() ?? 0) > 0,
      'the upgrade shim did not carry the cursor into Postgres',
    );
    console.log('  ✓ an upgrade reads the legacy file cursor once, then owns the row');
  }

  await cleanup();
  // Leave the database as found: the cursor row is global, and a stale mark
  // from this suite would otherwise steer whatever integration test runs next.
  await clearCursor();
  sql.close();
  console.log('FSR event catch-up tests passed');
}

await runTests();
process.exit(0);
