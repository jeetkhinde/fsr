import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: Number(process.env.PORT ?? 3100),
  pagesDir: './pages',
  fsr: {
    watcher: 'embedded',
    patchDebounceSecs: 5,
    revalidateSeconds: 300,
    purgeAfterSeconds: 2_592_000,
    purgeSweepSeconds: 3_600,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    postgresUrl:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/postgres',
    // `kiln sync-triggers` installs/verifies the kiln_emit_event invalidation
    // trigger on contact_events (run after migrations/0000_init.sql). No
    // page currently declares a manual dependsOn against it, but the trigger
    // is kept wired for parity with the audit-log write path in db/contacts.ts.
    triggerTables: [{ table: 'contact_events', events: ['insert'] }],
  },
});
