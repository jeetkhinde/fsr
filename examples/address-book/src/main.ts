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
  const redis = config.fsr?.redisUrl
    ? new RedisCache(config.fsr.redisUrl)
    : null;
  const watcher = new FsrWatcher(store, redis, {
    pollIntervalMs: 1000,
    promoteAfterHits: config.fsr?.promoteAfterHits ?? 1,
    patchDebounceSecs: 0,
    purgeAfterSeconds: 3600,
    scheduledInvalidations: [],
    idleEvictSecs: 1800,
    idleThresholdSecs: 3600,
  });

  await watcher.start();
  await startDbNotificationPipeline(config.fsr!.postgresUrl!, store, watcher);

  adapter.registerAsset(
    '/assets/address-book.css',
    fileURLToPath(new URL('../styles/app.css', import.meta.url)),
  );
  adapter.registerAsset(
    '/assets/address-book.js',
    fileURLToPath(new URL('../client/address-book.js', import.meta.url)),
  );

  await startKiln(adapter, config, './pages', { fsr: true, store, watcher });
  await adapter.listen(config.port ?? 3100, (address) => {
    console.log(`Address book running at ${address}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
