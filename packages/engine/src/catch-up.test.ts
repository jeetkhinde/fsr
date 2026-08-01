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

  // 2. Crash then restart: a cursor exists, an event lands while the process is
  //    down, the next boot must replay it.
  {
    const dir = await tmpDir();
    await seedSlot();
    const first = makeWatcher(dir);
    await first.start(); // adopts the current head as its cursor
    await first.stop();

    await emitEvent(); // arrives while nothing is running
    assert.equal(await isStale(), false, 'precondition: slot should still be fresh');

    const second = makeWatcher(dir);
    await second.catchUpMissedEvents();
    await second.stop();
    assert.equal(await isStale(), true, 'restart did not replay the event missed while down');
    console.log('  ✓ a restart replays events emitted while the process was down');
  }

  // 3. A LISTEN drop mid-life. The regression that logged "reconnected to
  //    Postgres" and dropped the whole gap.
  {
    const dir = await tmpDir();
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
    const dir = await tmpDir(); // empty: no cursor
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
    const cursor = Number(await fs.readFile(path.join(dir, 'cursor'), 'utf8'));
    assert.ok(cursor > 0, 'cold start should persist the adopted head as its cursor');
    console.log('  ✓ a cold start adopts the current head instead of replaying all history');
  }

  await cleanup();
  sql.close();
  console.log('FSR event catch-up tests passed');
}

await runTests();
process.exit(0);
