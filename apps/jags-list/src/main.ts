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

async function main() {
  const adapter = new ElysiaAdapter();
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
    pollIntervalMs: fsrConfig.pollIntervalMs,
    promoteAfterHits: fsrConfig.promoteAfterHits,
    patchDebounceSecs: fsrConfig.patchDebounceSecs,
    purgeAfterSeconds: fsrConfig.purgeAfterSeconds,
    purgeSweepSeconds: fsrConfig.purgeSweepSeconds,
    revalidateSeconds: fsrConfig.revalidateSeconds,
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
