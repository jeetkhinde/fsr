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

        const work: Promise<void>[] = [];
        if (op === 'DELETE') {
          if (depKey) work.push(watcher.notifyDelete(depKey));
          if (depKey && id !== undefined && id !== null) work.push(watcher.notifyDelete(`${depKey}:${id}`));
        } else {
          if (depKey) work.push(watcher.notifyChange(depKey));
          if (depKey && id !== undefined && id !== null) work.push(watcher.notifyChange(`${depKey}:${id}`));
        }

        // Advance the cursor only after the invalidations are persisted —
        // advancing first would silently drop these events if the process
        // died mid-processing (catch-up starts from the cursor).
        await Promise.all(work);
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
