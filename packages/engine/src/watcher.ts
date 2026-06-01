import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { FsrStore, StaleSlot } from './store.js';
import { RedisCache } from './cache.js';
import { injectFsrSlots } from './baking.js';

export interface ScheduledInvalidation {
  depKey: string;
  intervalMs: number;
}

export interface WatcherConfig {
  pollIntervalMs: number;
  promoteAfterHits: number;
  patchDebounceSecs: number;
  purgeAfterSeconds: number;
  scheduledInvalidations: ScheduledInvalidation[];
  idleEvictSecs: number;
  idleThresholdSecs: number;
}

export interface SlotPatch {
  route: string;
  slot: string;
  value: any;
}

export class FsrWatcher {
  private active = false;
  private abortController = new AbortController();
  private emitter = new EventEmitter();

  constructor(
    private store: FsrStore,
    private redis: RedisCache | null,
    private config: WatcherConfig
  ) {}

  getEmitter(): EventEmitter {
    return this.emitter;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // 1. Scheduled invalidations
    for (const scheduled of this.config.scheduledInvalidations) {
      this.spawnSupervisedInvalidation(scheduled, signal);
    }

    // 2. Idle eviction
    if (this.config.idleEvictSecs > 0) {
      this.spawnSupervisedIdleEviction(signal);
    }

    // 3. Watcher main loop
    if (this.redis) {
      this.spawnSupervisedRedisWatcher(signal);
    } else {
      this.spawnSupervisedPollingWatcher(signal);
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.abortController.abort();
  }

  notifyChange(depKey: string): void {
    // Invalidate dep keys in DB
    this.store.invalidateDepKey(depKey).catch(err => {
      console.error(`Failed to invalidate dep key ${depKey}:`, err);
    });
  }

  private spawnSupervisedInvalidation(scheduled: ScheduledInvalidation, signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, scheduled.intervalMs));
        if (signal.aborted) break;
        try {
          await this.store.invalidateDepKey(scheduled.depKey);
        } catch (err: any) {
          console.error(`FSR: scheduled invalidation failed for ${scheduled.depKey}:`, err.message);
        }
      }
    };
    run();
  }

  private spawnSupervisedIdleEviction(signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, this.config.idleEvictSecs * 1000));
        if (signal.aborted) break;
        try {
          const evicted = await this.store.evictIdleRoutes(this.config.idleThresholdSecs);
          for (const r of evicted) {
            console.log(`FSR: idle eviction for route ${r.route}`);
            if (this.redis) {
              await this.redis.deleteRouteKeys(r.route).catch(() => {});
            }
            if (r.htmlPath) {
              await fs.unlink(r.htmlPath).catch(() => {});
            }
            if (r.jsonPath) {
              await fs.unlink(r.jsonPath).catch(() => {});
            }
          }
        } catch (err: any) {
          console.error('FSR: idle eviction loop failed:', err.message);
        }
      }
    };
    run();
  }

  private spawnSupervisedPollingWatcher(signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        try {
          await this.watcherTick();
        } catch (err: any) {
          console.error('FSR watcher tick failed:', err.message);
        }
        await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
      }
    };
    run();
  }

  private spawnSupervisedRedisWatcher(signal: AbortSignal): void {
    const run = async () => {
      let subClient: any = null;
      while (!signal.aborted) {
        try {
          if (!this.redis) break;
          subClient = this.redis.getClient().duplicate();
          
          await subClient.subscribe('pilcrow:invalidate');
          console.log('FSR watcher: subscribed to pilcrow:invalidate');

          const handleMessage = async (channel: string, _message: string) => {
            if (channel === 'pilcrow:invalidate') {
              try {
                await this.watcherTickRedis();
              } catch (err: any) {
                console.error('FSR watcher: tick failed after invalidation event:', err.message);
              }
            }
          };

          subClient.on('message', handleMessage);

          // Spawn a reconciliation tick timer (runs every 60 seconds as a fallback check)
          const reconciliationInterval = setInterval(async () => {
            try {
              await this.watcherTickRedis();
            } catch (err: any) {
              console.error('FSR watcher: reconciliation tick failed:', err.message);
            }
          }, 60000);

          signal.addEventListener('abort', () => {
            clearInterval(reconciliationInterval);
            subClient?.quit().catch(() => {});
          });

          // Wait until aborted or connection closes
          await new Promise<void>((_, reject) => {
            subClient.on('end', () => reject(new Error('Redis connection closed')));
            signal.addEventListener('abort', () => reject(new Error('Aborted')));
          });

        } catch (err: any) {
          if (signal.aborted) break;
          console.warn('FSR watcher: Redis connection dropped or failed. Switching to poll fallback...', err.message);
          // Polling fallback while disconnected
          try {
            await this.watcherTickRedis();
          } catch (e: any) {
            console.error('FSR watcher: fallback tick failed:', e.message);
          }
          // Wait fallback interval before attempting reconnection
          await new Promise(resolve => setTimeout(resolve, Math.max(100, this.config.pollIntervalMs)));
        } finally {
          if (subClient) {
            subClient.quit().catch(() => {});
          }
        }
      }
    };
    run();
  }

  private async watcherTick(): Promise<void> {
    const stale = await this.store.fetchStaleSlots();
    if (stale.length === 0) return;

    // Phase 1: run DB queries
    const results: { slotRow: StaleSlot; value: any; err?: any }[] = [];
    for (const slotRow of stale) {
      try {
        const value = await this.store.reExecuteQuery(slotRow);
        results.push({ slotRow, value });
      } catch (err: any) {
        console.warn(`FSR watcher: failed to re-execute query for ${slotRow.route}/${slotRow.slot}:`, err.message);
        results.push({ slotRow, value: null, err });
      }
    }

    // Phase 2a: build layout slot batches for file baking
    const htmlPatches = new Map<string, [string, any][]>();
    const jsonPatches = new Map<string, [string, any][]>();
    for (const { slotRow, value, err } of results) {
      if (err) continue;
      if (slotRow.promoted) {
        if (slotRow.htmlPath) {
          if (!htmlPatches.has(slotRow.htmlPath)) htmlPatches.set(slotRow.htmlPath, []);
          htmlPatches.get(slotRow.htmlPath)!.push([slotRow.slot, value]);
        }
        if (slotRow.jsonPath) {
          if (!jsonPatches.has(slotRow.jsonPath)) jsonPatches.set(slotRow.jsonPath, []);
          jsonPatches.get(slotRow.jsonPath)!.push([slotRow.slot, value]);
        }
      }
    }

    // Phase 2b: write to files
    for (const [htmlPath, patches] of htmlPatches.entries()) {
      await this.patchHtmlFileBatchReturning(htmlPath, patches);
    }
    for (const [jsonPath, patches] of jsonPatches.entries()) {
      await this.patchJsonFileBatch(jsonPath, patches);
    }

    // Phase 2c: broadcast SSE and mark fresh
    for (const { slotRow, value, err } of results) {
      if (err) continue;
      
      this.emitter.emit('patch', {
        route: slotRow.route,
        slot: slotRow.slot,
        value
      } as SlotPatch);

      try {
        await this.store.markFresh(slotRow.route, slotRow.slot);
      } catch (err: any) {
        console.warn(`FSR watcher: failed to mark slot fresh for ${slotRow.route}/${slotRow.slot}:`, err.message);
      }
    }
  }

  private async watcherTickRedis(): Promise<void> {
    const stale = await this.store.fetchStaleSlots();
    if (stale.length === 0) return;

    // Phase 1: run DB queries
    const results: { slotRow: StaleSlot; value: any; err?: any }[] = [];
    for (const slotRow of stale) {
      try {
        const value = await this.store.reExecuteQuery(slotRow);
        results.push({ slotRow, value });
      } catch (err: any) {
        console.warn(`FSR watcher (Redis): failed to re-execute query for ${slotRow.route}/${slotRow.slot}:`, err.message);
        results.push({ slotRow, value: null, err });
      }
    }

    // Phase 2a: build batches
    const htmlPatches = new Map<string, [string, any][]>();
    const jsonPatches = new Map<string, [string, any][]>();
    const redisJsonPatches = new Map<string, [string, any][]>();

    for (const { slotRow, value, err } of results) {
      if (err) continue;
      if (slotRow.promoted) {
        if (slotRow.htmlPath) {
          if (!htmlPatches.has(slotRow.htmlPath)) htmlPatches.set(slotRow.htmlPath, []);
          htmlPatches.get(slotRow.htmlPath)!.push([slotRow.slot, value]);
        }
        if (slotRow.jsonPath) {
          if (!jsonPatches.has(slotRow.jsonPath)) jsonPatches.set(slotRow.jsonPath, []);
          jsonPatches.get(slotRow.jsonPath)!.push([slotRow.slot, value]);
          
          if (!redisJsonPatches.has(slotRow.route)) redisJsonPatches.set(slotRow.route, []);
          redisJsonPatches.get(slotRow.route)!.push([slotRow.slot, value]);
        }
      }
    }

    // Phase 2b: patch files
    const htmlPatched = new Map<string, string | null>();
    for (const [htmlPath, patches] of htmlPatches.entries()) {
      const patched = await this.patchHtmlFileBatchReturning(htmlPath, patches);
      htmlPatched.set(htmlPath, patched);
    }
    for (const [jsonPath, patches] of jsonPatches.entries()) {
      await this.patchJsonFileBatch(jsonPath, patches);
    }

    // Phase 2c: Redis JSON read/merge/write
    if (this.redis) {
      for (const [route, patches] of redisJsonPatches.entries()) {
        try {
          const existing = await this.redis.getJson(route) || {};
          for (const [slot, val] of patches) {
            existing[slot] = val;
          }
          await this.redis.setJson(route, existing);
        } catch (e: any) {
          console.warn(`FSR watcher: Redis setJson failed for ${route}:`, e.message);
        }
      }
    }

    // Phase 2d: update Redis HASH, Redis HTML, publish, SSE, mark fresh
    for (const { slotRow, value, err } of results) {
      if (err) continue;

      if (this.redis) {
        let valStr = '';
        if (value === null || value === undefined) valStr = '';
        else if (typeof value === 'string') valStr = value;
        else if (typeof value === 'object') valStr = JSON.stringify(value);
        else valStr = String(value);

        try {
          await this.redis.patchSlot(slotRow.route, slotRow.slot, valStr);
        } catch (e: any) {
          console.warn(`FSR watcher: Redis patchSlot failed for ${slotRow.route}/${slotRow.slot}:`, e.message);
        }

        if (slotRow.promoted && slotRow.htmlPath) {
          const patchedHtml = htmlPatched.get(slotRow.htmlPath);
          if (patchedHtml) {
            try {
              await this.redis.setHtml(slotRow.route, patchedHtml);
            } catch (e: any) {
              console.warn(`FSR watcher: Redis setHtml failed for ${slotRow.route}:`, e.message);
            }
          }
        }

        try {
          await this.redis.publishPatch({
            route: slotRow.route,
            slot: slotRow.slot,
            value
          });
        } catch (e: any) {
          console.warn(`FSR watcher: Redis publishPatch failed for ${slotRow.route}/${slotRow.slot}:`, e.message);
        }
      }

      this.emitter.emit('patch', {
        route: slotRow.route,
        slot: slotRow.slot,
        value
      } as SlotPatch);

      try {
        await this.store.markFresh(slotRow.route, slotRow.slot);
      } catch (e: any) {
        console.warn(`FSR watcher: failed to mark slot fresh for ${slotRow.route}/${slotRow.slot}:`, e.message);
      }
    }
  }

  private async patchHtmlFileBatchReturning(htmlPath: string, patches: [string, any][]): Promise<string | null> {
    try {
      const html = await fs.readFile(htmlPath, 'utf8');
      const patched = injectFsrSlots(html, patches);
      await fs.writeFile(htmlPath, patched, 'utf8');
      return patched;
    } catch (err: any) {
      console.warn(`FSR watcher: failed to patch HTML file at ${htmlPath}:`, err.message);
      return null;
    }
  }

  private async patchJsonFileBatch(jsonPath: string, patches: [string, any][]): Promise<void> {
    try {
      let content = '{}';
      try {
        content = await fs.readFile(jsonPath, 'utf8');
      } catch {
        // ignore missing file, use empty JSON
      }
      let obj: any = {};
      try {
        obj = JSON.parse(content);
      } catch {
        obj = {};
      }
      for (const [slot, value] of patches) {
        obj[slot] = value;
      }
      await fs.writeFile(jsonPath, JSON.stringify(obj), 'utf8');
    } catch (err: any) {
      console.warn(`FSR watcher: failed to patch JSON file at ${jsonPath}:`, err.message);
    }
  }
}
