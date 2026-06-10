import { startKiln } from '@kiln/routekit';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import { FsrStore, FsrWatcher, startDbNotificationPipeline } from '@kiln/engine';
import { SQL } from 'bun';
import config from '../kiln.config.js';

async function main() {
  const adapter = new ElysiaAdapter();

  // Initialize DB and FSR if credentials exist
  let fsr;
  let bunSql: SQL | null = null;
  const dbUrl = config.fsr?.postgresUrl;
  if (dbUrl) {
    bunSql = new SQL(dbUrl);
    const store = new FsrStore(bunSql);
    await store.initialize();
    const watcher = new FsrWatcher(store, null, {
      pollIntervalMs: 1000,
      promoteAfterHits: config.fsr.promoteAfterHits,
      patchDebounceSecs: config.fsr.patchDebounceSecs,
      purgeAfterSeconds: config.fsr.purgeAfterSeconds,
      purgeSweepSeconds: config.fsr.purgeSweepSeconds,
      revalidateSeconds: config.fsr.revalidateSeconds,
      scheduledInvalidations: [],
    });
    
    await watcher.start();
    await startDbNotificationPipeline(dbUrl, store, watcher);
    fsr = { fsr: true, store, watcher };
    console.log('FSR baking engine and watcher successfully initialized.');
  }

  await startKiln(adapter, config, './pages', fsr);

  const port = config.port || config.web?.port || 3000;
  await adapter.listen(port, () => {
    console.log(`Server booted successfully on http://localhost:${port}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
