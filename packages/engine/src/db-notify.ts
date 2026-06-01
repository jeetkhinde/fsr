import pg from 'pg';
import { FsrStore } from './store.js';
import { FsrWatcher } from './watcher.js';

export async function startDbNotificationPipeline(
  connectionString: string,
  store: FsrStore,
  watcher: FsrWatcher
): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  await client.query('LISTEN pilcrow_invalidate');

  client.on('notification', async (msg) => {
    if (msg.channel === 'pilcrow_invalidate' && msg.payload) {
      try {
        const payload = JSON.parse(msg.payload);
        const { depKey, id } = payload;
        
        if (depKey) {
          // Notify collection key
          watcher.notifyChange(depKey);
          
          // Notify dynamic row-specific key (e.g. tickets:42)
          if (id !== undefined && id !== null) {
            watcher.notifyChange(`${depKey}:${id}`);
          }
        }
      } catch (err: any) {
        console.error('FSR DB listener: failed to parse notification payload:', err.message);
      }
    }
  });

  return client;
}
