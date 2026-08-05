import { fileURLToPath } from 'node:url';
import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: Number(process.env.PORT ?? 3200),
  pagesDir: './pages',
  // ADR-020. This app used to own `src/main.ts` purely because better-auth
  // needs one raw catch-all route, and that cost it the whole CLI: no Vite,
  // no islands, and a hand-copied FSR runtime that drifted from the CLI's
  // (it had to re-add `pollIntervalMs ?? 1000` by hand after the NaN bug).
  // `server.setup` mounts the same two things inside `kiln dev`/`kiln start`.
  server: {
    async setup({ adapter, config, mode }) {
      // Imported lazily: config is loaded during CLI boot, and better-auth
      // opens a DB pool at module scope. Only the running server needs it.
      const { auth } = await import('./lib/auth.js');

      if (!adapter.registerRaw) {
        throw new Error(
          `Adapter ${adapter.constructor.name} has no registerRaw(); Jag's List cannot mount better-auth without it.`,
        );
      }
      // Raw, NOT a Kiln route: `hooks.ts` `handle` never runs for it, which is
      // the point — you cannot require a session on the endpoint that creates
      // one. Everything that should be gated is a page or an action instead.
      adapter.registerRaw('/api/auth/*', (request) => auth.handler(request));

      adapter.registerAsset(
        '/assets/app.css',
        fileURLToPath(new URL('./styles/app.css', import.meta.url)),
      );

      // App policy, not framework policy: a production deploy without both
      // stores silently degrades to uncached SSR with no live updates.
      if (mode === 'start' && process.env.NODE_ENV === 'production') {
        if (!config.fsr?.postgresUrl || !config.fsr?.redisUrl) {
          throw new Error(
            "Jag's List production requires reachable PostgreSQL and Redis",
          );
        }
      }
    },
  },
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
    // Deploy fingerprint: when set, artifacts from an older build self-invalidate.
    buildId: process.env.GIT_SHA,
    postgresUrl:
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist',
    // Tables `kiln sync-triggers` installs/verifies `kiln_emit_event` triggers
    // on (run after every `db:migrate` — see README). Row-scoped granularity
    // is not needed: no jags-list page uses Live.value/Live.list with a
    // manual dependsOn, so table-level auto-deps (createKilnSql) covers what
    // these apps' pages actually read. `notifications` gets `ownerColumn` so
    // one user's notification never invalidates another user's cached home
    // artifact (bake='user', ADR-017). `task_labels` is intentionally absent:
    // its composite primary key (task_id, label_id) has no `id` column, and
    // kiln_emit_event() unconditionally reads NEW.id/OLD.id — it would error
    // on fire. Its hand-written trigger stays in migrations/0000_init.sql.
    triggerTables: [
      { table: 'projects' },
      { table: 'columns' },
      { table: 'tasks' },
      { table: 'subtasks' },
      { table: 'comments' },
      { table: 'labels' },
      { table: 'activity', events: ['insert'] },
      { table: 'notifications', ownerColumn: 'user_id' },
    ],
    // Eagerly revalidate stale live fields only on routes hit within the
    // last 30s; dormant routes rebuild lazily on next read (Task 5).
    activeWindowSecs: 30,
  },
});
