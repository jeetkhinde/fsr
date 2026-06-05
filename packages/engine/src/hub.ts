import { FsrStore } from './store.js';
import { FsrWatcher, type LivePatch, type SlotPatch } from './watcher.js';
import { SSEEvent } from '@kiln/core';
import { KilnCache } from './cache.js';
import { injectFsrSlots } from './baking.js';
import { isScalarPatch, type RenderedListPatch, type ScalarPatch } from '@kiln/live';

export interface FsrHubConfig {
  maxConnections: number;
  connectionTtlSecs: number;
  keepaliveSecs: number;
}

export const defaultHubConfig: FsrHubConfig = {
  maxConnections: 1000,
  connectionTtlSecs: 3600,
  keepaliveSecs: 30,
};

// Global active connections counter
let activeConnectionsCount = 0;

export function getActiveConnectionsCount(): number {
  return activeConnectionsCount;
}

/**
 * After a LiveProp patch fires, update both JSON and HTML baked files
 * so the next cache hit serves fresh data without a DB round-trip.
 */
export async function patchBakedFiles(
  cache: KilnCache,
  route: string,
  slot: string,
  value: unknown
): Promise<void> {
  await Promise.allSettled([
    // Patch JSON: update the field
    cache.patchJsonField(route, slot, value),
    // Patch HTML: re-inject the s-live slot
    cache.getHtml(route).then(html => {
      if (!html) return;
      const patched = injectFsrSlots(html, [[slot, value]]);
      return cache.setHtml(route, patched);
    }),
  ]);
}

export interface FsrHubStreamOptions {
  route: string;
  slots: string[];
  watcher?: FsrWatcher;
  config?: FsrHubConfig;
  cache?: KilnCache;
}

export async function* fsrHubStream(
  options: FsrHubStreamOptions
): AsyncGenerator<SSEEvent, void, unknown> {
  const { route, slots, watcher, config = defaultHubConfig, cache } = options;

  if (!watcher) {
    yield { event: 'error', data: 'FSR watcher not configured' };
    return;
  }

  // Check connection counter
  if (activeConnectionsCount >= config.maxConnections) {
    throw new Error('SERVICE_UNAVAILABLE: FSR connection limit reached');
  }

  activeConnectionsCount++;

  const emitter = watcher.getEmitter();
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

  let ttlExpired = false;
  const ttlTimer = setTimeout(() => {
    ttlExpired = true;
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  }, config.connectionTtlSecs * 1000);

  try {
    while (!ttlExpired) {
      if (queue.length === 0 && !triggerKeepalive && !lagged && !ttlExpired) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }

      if (ttlExpired) break;

      if (lagged) {
        lagged = false;
        yield { event: 'fsr-resync', data: 'lagged' };
        continue;
      }

      if (triggerKeepalive) {
        triggerKeepalive = false;
        yield { data: '' }; // keepalive comment/heartbeat
        continue;
      }

      while (queue.length > 0) {
        const patch = queue.shift()!;
        if (patch.route !== route) continue;
        const patchSlot = getPatchSlot(patch);
        if (slots.length > 0 && patchSlot && !slots.includes(patchSlot)) continue;

        resetKeepalive(); // reset heartbeat on message
        yield formatPatchEvent(patch);
        if (cache) {
          const scalar = normalizeScalarPatch(patch);
          if (scalar) patchBakedFiles(cache, route, scalar.field, scalar.value).catch(() => {});
        }
      }
    }
  } finally {
    activeConnectionsCount--;
    emitter.off('patch', onPatch);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
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
  return { kind: 'scalar', route: patch.route, field: patch.slot, value: patch.value };
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
  store: FsrStore | null | undefined
): Promise<Record<string, any>> {
  if (!store) {
    return {};
  }
  const matchingSlots = await store.fetchSlotsForSnapshot(route, slots);
  const result: Record<string, any> = {};

  for (const slot of matchingSlots) {
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
