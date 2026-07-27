import { FsrStore } from './store.js';
import { FsrWatcher, type LivePatch, type SlotPatch } from './watcher.js';
import { SSEEvent } from '@kiln/core';
import { KilnCache } from './cache.js';
import { isScalarPatch, type RenderedListPatch, type ScalarPatch } from '@kiln/live';

export interface FsrHubConfig {
  maxConnections: number;
  connectionTtlSecs: number;
  keepaliveSecs: number;
}

export const defaultHubConfig: FsrHubConfig = {
  maxConnections: 1000,
  connectionTtlSecs: 3600,
  keepaliveSecs: 30
};

// Per-process fallback counter, used whenever no Redis client is
// configured (or a Redis call itself fails — connection admission fails
// open rather than blocking the SSE stream on a cache outage).
let activeConnectionsCount = 0;

const REDIS_CONN_COUNT_KEY = 'kiln:fsr:active-connections';

/** Local-process count. With Redis configured, the *enforced* cross-process
 * limit uses a separate Redis-backed counter this getter doesn't reflect —
 * it only ever reports this process's own connections. */
export function getActiveConnectionsCount(): number {
  return activeConnectionsCount;
}

function admitConnectionLocal(maxConnections: number): boolean {
  if (activeConnectionsCount >= maxConnections) return false;
  activeConnectionsCount++;
  return true;
}

function releaseConnectionLocal(): void {
  activeConnectionsCount = Math.max(0, activeConnectionsCount - 1);
}

/**
 * Redis-backed admission: atomically increments first and backs out if that
 * pushed the count over the limit — the standard INCR-then-correct pattern
 * (INCR itself is atomic; a connection that loses the race between two
 * processes' INCRs just gets immediately DECRemented back, so the count
 * never permanently overshoots). Only called when a Redis client exists —
 * kept separate from the local-counter path (rather than one function
 * branching internally) so the common no-Redis case stays fully
 * synchronous and doesn't pay an extra microtask hop on every connection.
 */
async function admitConnectionRedis(
  redis: NonNullable<ReturnType<KilnCache['getClient']>>,
  maxConnections: number,
  connCountKey: string
): Promise<boolean> {
  const count = await redis.incr(connCountKey);
  if (count > maxConnections) {
    await redis.decr(connCountKey);
    return false;
  }
  return true;
}

/**
 * JSON is the mutable freshness authority. The baked shell is immutable.
 */
export async function patchBakedFiles(
  cache: KilnCache,
  route: string,
  slot: string,
  value: unknown,
  variant?: string
): Promise<void> {
  await cache.patchJsonField(route, slot, value, variant);
}

export interface FsrHubStreamOptions {
  route: string;
  slots: string[];
  /** Server-resolved user key (identity hook) — NEVER client-supplied. ''
   * subscribes to the route's shared patches; set = that user's patches. */
  userKey?: string;
  signal?: AbortSignal;
  watcher?: FsrWatcher;
  config?: FsrHubConfig;
  cache?: KilnCache;
  /**
   * Called every `activityPingSecs` for as long as the stream stays open —
   * the REPEAT only; the caller owns the initial ping (this is an async
   * generator, so nothing in here runs until the adapter starts iterating).
   *
   * An open subscription IS the activity signal for ADR-018's active/dormant
   * tier: without a repeating ping, a client that simply leaves the page open
   * goes dormant after `activeWindowSecs` and the watcher stops eagerly
   * revalidating the very snapshot it is watching — so live patches would
   * silently stop arriving while the connection is still healthy. The
   * interval is cleared in this generator's `finally`, alongside the
   * keepalive and TTL timers, so it cannot outlive the connection.
   */
  onActivity?: () => void;
  /** Ping cadence for `onActivity`. Default 15s (half the 30s default window). */
  activityPingSecs?: number;
}

export async function* fsrHubStream(options: FsrHubStreamOptions): AsyncGenerator<SSEEvent, void, unknown> {
  const {
    route,
    slots,
    signal,
    watcher,
    config = defaultHubConfig,
    cache,
    userKey = '',
    onActivity,
    activityPingSecs = 15,
  } = options;

  if (!watcher) {
    yield { event: 'error', data: 'FSR watcher not configured' };
    return;
  }

  // Cross-process admission when Redis is configured (each worker
  // otherwise enforces maxConnections independently, so the real cluster-
  // wide cap becomes maxConnections * workerCount). The no-Redis path stays
  // fully synchronous — no added await, no behavior change from before.
  const redisClient = cache?.getClient();
  // Per-namespace connection counter key (default `kiln:fsr:active-connections`).
  const connCountKey = cache?.fsrConnectionCountKey() ?? REDIS_CONN_COUNT_KEY;
  let usedRedis = false;
  let admitted: boolean;
  if (redisClient) {
    try {
      admitted = await admitConnectionRedis(redisClient, config.maxConnections, connCountKey);
      usedRedis = true;
    } catch (err: any) {
      console.warn('FSR hub: Redis connection-count check failed, falling back to local counter:', err?.message ?? err);
      admitted = admitConnectionLocal(config.maxConnections);
    }
  } else {
    admitted = admitConnectionLocal(config.maxConnections);
  }
  if (!admitted) {
    throw new Error('SERVICE_UNAVAILABLE: FSR connection limit reached');
  }

  const emitter = watcher.getEmitter();
  if (emitter.getMaxListeners() < config.maxConnections) {
    emitter.setMaxListeners(config.maxConnections);
  }
  const queue: (SlotPatch | LivePatch)[] = [];
  let resolveNext: ((value: void) => void) | null = null;
  let lagged = false;

  const onPatch = (patch: SlotPatch | LivePatch) => {
    if (queue.length >= 100) {
      lagged = true;
      queue.shift(); // drop oldest to make room
    }
    queue.push(patch);
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };

  emitter.on('patch', onPatch);

  let keepaliveTimer: NodeJS.Timeout | null = null;
  let triggerKeepalive = false;
  let aborted = signal?.aborted ?? false;

  const onAbort = () => {
    aborted = true;
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const resetKeepalive = () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      triggerKeepalive = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    }, config.keepaliveSecs * 1000);
  };

  resetKeepalive();

  // Keeps this (route, userKey) in the "active" freshness tier for the whole
  // life of the subscription — see FsrHubStreamOptions.onActivity.
  let activityTimer: NodeJS.Timeout | null = null;
  if (onActivity) {
    activityTimer = setInterval(onActivity, Math.max(0.001, activityPingSecs) * 1000);
  }

  let ttlExpired = false;
  const ttlTimer = setTimeout(() => {
    ttlExpired = true;
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  }, config.connectionTtlSecs * 1000);

  try {
    // Commit the SSE response before waiting for the first application patch.
    yield { event: 'ready', data: '' };

    while (!ttlExpired && !aborted) {
      if (queue.length === 0 && !triggerKeepalive && !lagged && !ttlExpired && !aborted) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }

      if (ttlExpired || aborted) break;

      if (lagged) {
        lagged = false;
        // The client is about to refetch full state — the buffered patches
        // that triggered `lagged` are now stale relative to that refetch,
        // so drop them instead of replaying them right after telling the
        // client to resync.
        queue.length = 0;
        yield { event: 'fsr-resync', data: 'lagged' };
        continue;
      }

      if (triggerKeepalive) {
        triggerKeepalive = false;
        // Named event (matches the 'ready' sentinel above) rather than a
        // bare {data: ''}, which dispatches as a real 'message' event to
        // any generic EventSource.onmessage listener on the client.
        yield { event: 'keepalive', data: '' };
        continue;
      }

      while (queue.length > 0) {
        const patch = queue.shift()!;
        if (patch.route !== route) continue;
        // A patch scoped to one user's snapshot must only reach that user's
        // stream; userKey here came from the server-side identity hook, so
        // another user cannot subscribe their way into it.
        if ((((patch as any).userKey as string | undefined) ?? '') !== userKey) continue;
        const patchSlot = getPatchSlot(patch);
        if (slots.length > 0 && patchSlot && !slots.includes(patchSlot)) continue;

        resetKeepalive(); // reset heartbeat on message
        yield formatPatchEvent(patch);
        if (cache) {
          const scalar = normalizeScalarPatch(patch);
          if (scalar) {
            patchBakedFiles(cache, route, scalar.field, scalar.value, userKey ? `u:${userKey}` : undefined).catch((err: any) => {
              console.warn(`FSR hub: failed to patch baked cache for ${route}/${scalar.field}:`, err?.message ?? err);
            });
          }
        }
      }
    }
  } finally {
    if (usedRedis && redisClient) {
      try {
        await redisClient.decr(connCountKey);
      } catch (err: any) {
        console.warn('FSR hub: Redis connection-count release failed:', err?.message ?? err);
      }
    } else {
      releaseConnectionLocal();
    }
    emitter.off('patch', onPatch);
    signal?.removeEventListener('abort', onAbort);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (activityTimer) clearInterval(activityTimer);
    clearTimeout(ttlTimer);
  }
}

function getPatchSlot(patch: SlotPatch | LivePatch): string | null {
  if (isScalarPatch(patch)) return patch.field;
  if (isListPatch(patch)) return patch.list;
  return patch.slot;
}

function formatPatchEvent(patch: SlotPatch | LivePatch): SSEEvent {
  if (isScalarPatch(patch)) {
    return { event: 'live', data: JSON.stringify(patch) };
  }
  if (isListPatch(patch)) {
    return { event: 'list-patch', data: JSON.stringify(patch) };
  }
  return {
    event: 'fsr',
    data: JSON.stringify({ [patch.slot]: patch.value })
  };
}

function normalizeScalarPatch(patch: SlotPatch | LivePatch): ScalarPatch | null {
  if (isScalarPatch(patch)) return patch;
  if (isListPatch(patch)) return null;
  return {
    kind: 'scalar',
    route: patch.route,
    field: patch.slot,
    value: patch.value
  };
}

function isListPatch(value: unknown): value is RenderedListPatch {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as any).kind === 'list' &&
    typeof (value as any).route === 'string' &&
    typeof (value as any).list === 'string' &&
    typeof (value as any).key === 'string'
  );
}

export async function fsrSnapshotHandler(
  route: string,
  slots: string[],
  store: FsrStore | null | undefined,
  userKey = ''
): Promise<Record<string, any>> {
  if (!store) {
    return {};
  }
  const matchingSlots = await store.fetchSlotsForSnapshot(route, slots, userKey);
  const result: Record<string, any> = {};

  // Prefer the baked JSON snapshot — it's the freshness authority the
  // watcher keeps patched, covers loader-based slots (which have no query
  // to re-execute), and avoids re-running every slot query per request.
  let snapshotData: Record<string, any> | null = null;
  try {
    const paths = await store.getPromotedPaths(route, userKey);
    if (paths?.jsonPath) {
      const fs = await import('fs/promises');
      const parsed = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
      const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      if (data && typeof data === 'object' && !Array.isArray(data)) snapshotData = data;
    }
  } catch {
    snapshotData = null;
  }

  for (const slot of matchingSlots) {
    if (snapshotData && slot.slot in snapshotData) {
      result[slot.slot] = snapshotData[slot.slot];
      continue;
    }
    try {
      const val = await store.reExecuteQuery(slot);
      if (val !== null) {
        result[slot.slot] = val;
      }
    } catch (e: any) {
      console.warn(`FSR snapshot: query error for slot ${slot.slot}:`, e.message);
    }
  }

  return result;
}
