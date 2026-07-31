import { fileURLToPath } from 'node:url';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import {
  FsrStore,
  FsrWatcher,
  RedisCache,
  startDbNotificationPipeline,
} from '@kiln/engine';
import { startKiln } from '@kiln/routekit';
import config from '../kiln.config.js';
import { sql } from '../db/client.js';
import { auth } from '../lib/auth.js';

async function main() {
  const adapter = new ElysiaAdapter();
  // better-auth endpoints (sign-in/out, session). Raw Elysia routes, NOT Kiln
  // routes, so the hooks.ts `handle` hook never runs for them — public by
  // construction (no session needed to sign in).
  adapter.app.all('/api/auth/*', (ctx: any) => auth.handler(ctx.request));

  // Login/logout are Kiln actions on the /login page (pages/login.tsx), not
  // raw routes: actions now receive `res` and can set Set-Cookie themselves.
  const store = new FsrStore(sql);
  const fsrConfig = config.fsr;
  const redis = fsrConfig.redisUrl
    ? new RedisCache(fsrConfig.redisUrl).withArtifactTtl(
        fsrConfig.artifactTtlSecs,
      )
    : null;
  if (process.env.NODE_ENV === 'production' && (!fsrConfig.postgresUrl || !redis)) {
    throw new Error("Jag's List production requires reachable PostgreSQL and Redis");
  }
  await store.initialize();
  if (redis) await redis.getClient().send('PING', []);
  const watcher = new FsrWatcher(store, redis, {
    // main.ts builds its own FsrWatcher (not the CLI's initFsr), so it must
    // supply the same fallbacks the CLI applies — an unset pollIntervalMs
    // otherwise reaches setTimeout as NaN (effectively a busy-poll loop).
    pollIntervalMs: fsrConfig.pollIntervalMs ?? 1000,
    patchDebounceSecs: fsrConfig.patchDebounceSecs,
    purgeAfterSeconds: fsrConfig.purgeAfterSeconds,
    purgeSweepSeconds: fsrConfig.purgeSweepSeconds,
    revalidateSeconds: fsrConfig.revalidateSeconds,
    activeWindowSecs: fsrConfig.activeWindowSecs ?? 30,
    scheduledInvalidations: [],
  });

  await watcher.start();
  await startDbNotificationPipeline(fsrConfig.postgresUrl!, store, watcher);

  adapter.registerAsset(
    '/assets/app.css',
    fileURLToPath(new URL('../styles/app.css', import.meta.url)),
  );

  await startKiln(adapter, config, './pages', {
    fsr: true,
    store,
    watcher,
    redis: redis ?? undefined,
  });
  await adapter.listen(config.port ?? 3200, (address) => {
    console.log(`Jag's List running at ${address}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
