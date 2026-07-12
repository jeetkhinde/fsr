import pg from 'pg';
import { FsrStore } from './store.js';
import { FsrWatcher } from './watcher.js';

const MAX_RECONNECT_DELAY_MS = 30_000;

function wireClient(client: pg.Client, watcher: FsrWatcher): void {
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
}

/**
 * Starts the LISTEN/NOTIFY pipeline. Reconnects with exponential backoff on
 * unexpected connection loss (pg emits 'error', not 'end', for that — a
 * deliberate client.end() during shutdown does not trigger a reconnect).
 * The caller owns the returned client and is responsible for calling
 * client.end() on shutdown; reconnects after that point create a *new*
 * internal client the caller never sees, so nothing reconnects past process
 * shutdown as long as the process exits normally afterward.
 */
export async function startDbNotificationPipeline(
  connectionString: string,
  store: FsrStore,
  watcher: FsrWatcher
): Promise<pg.Client> {
  let reconnectDelay = 1000;

  const reconnect = () => {
    setTimeout(async () => {
      try {
        const client = new pg.Client({ connectionString });
        await client.connect();
        await client.query('LISTEN kiln_invalidate');
        wireClient(client, watcher);
        client.once('error', (err) => {
          console.warn('FSR DB listener: connection error, reconnecting:', err.message);
          reconnectDelay = 1000;
          reconnect();
        });
        reconnectDelay = 1000;
        console.info('FSR DB listener: reconnected to Postgres');
      } catch (err: any) {
        console.error('FSR DB listener: reconnect attempt failed:', err.message);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        reconnect();
      }
    }, reconnectDelay);
  };

  const client = new pg.Client({ connectionString });
  await client.connect();

  await client.query('LISTEN kiln_invalidate');
  wireClient(client, watcher);

  client.once('error', (err) => {
    console.warn('FSR DB listener: connection error, reconnecting:', err.message);
    reconnect();
  });

  return client;
}
