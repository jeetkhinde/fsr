import { startPilcrow } from '@fsr/routekit';
import { ElysiaAdapter } from '@fsr/adapter-elysia';
import { FsrStore, FsrWatcher, startDbNotificationPipeline } from '@fsr/engine';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import config from '../pilcrow.config.js';

async function main() {
  const adapter = new ElysiaAdapter();

  // Initialize DB and FSR if credentials exist
  let fsr;
  const dbUrl = config.fsr?.postgresUrl;
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl });
    const db = drizzle(pool);
    const store = new FsrStore(db).withPool(pool);
    const watcher = new FsrWatcher(store, null, {
      pollIntervalMs: 1000,
      promoteAfterHits: config.fsr?.promoteAfterHits ?? 1,
      patchDebounceSecs: 0,
      purgeAfterSeconds: 3600,
      scheduledInvalidations: [],
      idleEvictSecs: 1800,
      idleThresholdSecs: 3600
    });
    
    await watcher.start();
    await startDbNotificationPipeline(dbUrl, store, watcher);
    fsr = { store, watcher };
    console.log('FSR baking engine and watcher successfully initialized.');
  }

  await startPilcrow(adapter, config, './pages', fsr);

  const port = config.port || config.web?.port || 3000;
  await adapter.listen(port, () => {
    console.log(`Server booted successfully on http://localhost:${port}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
