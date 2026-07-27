// Dogfoods Plan 3's auto-deps + owner-scoped invalidation machinery
// (createKilnSql, kiln sync-triggers, kiln_emit_event's owner column) through
// this app's REAL client (db/client.ts), REAL config (kiln.config.ts's
// fsr.triggerTables), and REAL migrated schema — not a framework-level unit
// test (those already exist: packages/routekit/src/boot.test.ts "auto-derives
// depends_on...", packages/cli/src/sync-triggers.test.ts).
//
// No jags-list page currently declares a Live field (the board/task live
// updates the README calls out are this app's own future milestone, not part
// of this framework plan), so there is no existing page whose cache staleness
// this suite could observe by simply hitting HTTP routes. Instead this proves
// the same seam boot.ts itself exercises for a live field's depends_on
// (withDepCapture over a query against the app's real createKilnSql client,
// then FsrStore.upsertSlot with the auto-captured tables and NO manual dep
// key) end-to-end against the real DB: a real row change, through the real
// migrated trigger (installed by `kiln sync-triggers` from this app's
// `fsr.triggerTables` config), delivered over real LISTEN/NOTIFY to the real
// running app's embedded FsrWatcher, which marks the slot stale.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { withDepCapture } from '@kiln/core/sql';
import { FsrStore } from '@kiln/engine';
import { sql } from '../db/client.js';

const PORT = 3296;
const BASE = `http://localhost:${PORT}`;
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
const store = new FsrStore(sql);

const ROUTE_PROJECTS = '/__test/freshness-projects';
const ROUTE_NOTIFS = '/__test/freshness-notifications';
const OWNER_TOM = 'freshness-test-tom';
const OWNER_ADAM = 'freshness-test-adam';

async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

async function isStale(route: string, slot: string, userKey: string): Promise<boolean | undefined> {
  const rows = await store.fetchAllForInspect();
  return rows.find((r) => r.route === route && r.slot === slot && r.userKey === userKey)?.stale;
}

describe.skipIf(!run)('freshness — auto-deps + owner-scoped invalidation (ADR-018)', () => {
  beforeAll(async () => {
    await store.initialize();

    // `kiln sync-triggers` — installs/verifies the generic kiln_emit_event
    // triggers from kiln.config.ts's fsr.triggerTables. Run here (not just
    // once by a human after `db:migrate`) so this suite is self-contained and
    // idempotent: a repeat run against triggers that already exist is a
    // no-op ("exists"), never an error. Invoked as the built CLI binary
    // itself (not a package.json script) so this test doesn't depend on
    // that script's presence — it's exactly `kiln sync-triggers` per the
    // README note, just addressed by path.
    const cliPath = fileURLToPath(
      new URL('../../../packages/cli/dist/cli.js', import.meta.url),
    );
    const appDir = fileURLToPath(new URL('..', import.meta.url));
    const sync = Bun.spawnSync(['bun', cliPath, 'sync-triggers'], {
      cwd: appDir,
      env: process.env as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (sync.exitCode !== 0) {
      throw new Error(`kiln sync-triggers exited ${sync.exitCode} — see output above`);
    }

    // Clean slate for the synthetic test routes/rows this suite owns.
    await sql`DELETE FROM kiln_fsr WHERE route IN (${ROUTE_PROJECTS}, ${ROUTE_NOTIFS})`;
    await sql`DELETE FROM notifications WHERE user_id IN (${OWNER_TOM}, ${OWNER_ADAM})`;

    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: appDir,
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit', stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(200);
    }
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM kiln_fsr WHERE route IN (${ROUTE_PROJECTS}, ${ROUTE_NOTIFS})`;
    await sql`DELETE FROM notifications WHERE user_id IN (${OWNER_TOM}, ${OWNER_ADAM})`;
    await sql.close();
  });

  it('a load() reading `projects` with NO manual dep key auto-invalidates when a project row changes', async () => {
    // Mirrors exactly what pages/projects/index.tsx's load() does via
    // listActiveProjects(): a plain SELECT ... FROM projects. No dep key is
    // written by hand anywhere in this test — `tables` is entirely
    // auto-captured by createKilnSql (db/client.ts).
    const { tables } = await withDepCapture(async () => {
      await sql`SELECT id FROM projects LIMIT 1`;
    });
    expect([...tables]).toContain('projects');

    await store.ensureRouteRow(ROUTE_PROJECTS, 300, 3600, 'json');
    await store.upsertSlot(ROUTE_PROJECTS, 'count', null, [], [...tables], 0, null, '');
    expect(await isStale(ROUTE_PROJECTS, 'count', '')).toBe(false);

    // A real row change on `projects`, through the app's real, migrated,
    // sync-triggers-installed trigger. No manual invalidateDepKey call.
    const [row] = await sql`
      INSERT INTO projects (name, created_by) VALUES ('Freshness probe', ${OWNER_TOM}) RETURNING id`;
    try {
      const wentStale = await pollUntil(async () => (await isStale(ROUTE_PROJECTS, 'count', '')) === true);
      expect(wentStale).toBe(true);
    } finally {
      await sql`DELETE FROM projects WHERE id = ${row.id}`;
    }
  });

  it("an owner-scoped notifications change invalidates only that owner's slot, leaving the other user's cached artifact intact", async () => {
    const { tables } = await withDepCapture(async () => {
      await sql`SELECT id FROM notifications WHERE user_id = ${OWNER_TOM} LIMIT 1`;
    });
    expect([...tables]).toContain('notifications');

    await store.ensureRouteRow(ROUTE_NOTIFS, 300, 3600, 'json', '');
    await store.ensureRouteRow(ROUTE_NOTIFS, 300, 3600, 'json', OWNER_TOM);
    await store.ensureRouteRow(ROUTE_NOTIFS, 300, 3600, 'json', OWNER_ADAM);
    await store.upsertSlot(ROUTE_NOTIFS, 'unread', null, [], [...tables], 0, null, '');
    await store.upsertSlot(ROUTE_NOTIFS, 'unread', null, [], [...tables], 0, null, OWNER_TOM);
    await store.upsertSlot(ROUTE_NOTIFS, 'unread', null, [], [...tables], 0, null, OWNER_ADAM);

    // Tom gets a notification. The trigger's ownerColumn ('user_id', wired
    // via kiln.config.ts's fsr.triggerTables) rides the pg_notify payload, so
    // invalidateDepKey scopes staleness to the shared row + Tom's row only.
    const [n] = await sql`
      INSERT INTO notifications (user_id, actor_id, type)
      VALUES (${OWNER_TOM}, ${OWNER_ADAM}, 'commented') RETURNING id`;
    try {
      const tomWentStale = await pollUntil(
        async () => (await isStale(ROUTE_NOTIFS, 'unread', OWNER_TOM)) === true,
      );
      expect(tomWentStale).toBe(true);

      // Give a wrongly-broad invalidation the same window it would need to
      // reach Adam's row, then assert it never did.
      await Bun.sleep(500);
      expect(await isStale(ROUTE_NOTIFS, 'unread', '')).toBe(true); // shared row always invalidated
      expect(await isStale(ROUTE_NOTIFS, 'unread', OWNER_ADAM)).toBe(false); // Adam's cache stays intact
    } finally {
      await sql`DELETE FROM notifications WHERE id = ${n.id}`;
    }
  });
});
