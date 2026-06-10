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

  await client.query('LISTEN kiln_invalidate');

  client.on('notification', async (msg) => {
    if (msg.channel === 'kiln_invalidate' && msg.payload) {
      try {
        const payload = JSON.parse(msg.payload);
        const { depKey, id, op, eventId } = payload;
        
        if (op === 'DELETE') {
          if (depKey) watcher.notifyDelete(depKey);
          if (depKey && id !== undefined && id !== null) watcher.notifyDelete(`${depKey}:${id}`);
        } else {
          if (depKey) watcher.notifyChange(depKey);
          if (depKey && id !== undefined && id !== null) watcher.notifyChange(`${depKey}:${id}`);
        }
        
        if (eventId !== undefined) {
          watcher.updateCursor(eventId);
        }
      } catch (err: any) {
        console.error('FSR DB listener: failed to parse notification payload:', err.message);
      }
    }
  });

  return client;
}
