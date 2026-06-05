import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { FsrStore, StaleSlot } from './store.js';
import { RedisCache } from './cache.js';
import { injectFsrSlots } from './baking.js';
import {
  applyListPatchToHtml,
  applyListPatchToJson,
  createScalarPatch,
  isScalarPatch,
  reconcileListRows,
  type RenderedListPatch,
  type ScalarPatch,
} from '@kiln/live';
import type { LiveListSnapshot, LiveListSnapshotRow, UpsertLiveListSnapshot } from './list-store.js';
import { liveListTargetKey, type RegisteredLiveListTarget } from './live-list-runtime.js';

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

export type LivePatch = ScalarPatch | RenderedListPatch;

export class FsrWatcher {
  private active = false;
  private abortController = new AbortController();
  private emitter = new EventEmitter();
  private liveListTargets = new Map<string, RegisteredLiveListTarget<any>>();
  private warnedUnregisteredLists = new Set<string>();

  constructor(
    private store: FsrStore,
    private redis: RedisCache | null,
    private config: WatcherConfig
  ) {}

  getEmitter(): EventEmitter {
    return this.emitter;
  }

  async registerLiveList<T>(
    target: RegisteredLiveListTarget<T>,
    initialSnapshot: UpsertLiveListSnapshot<T>,
  ): Promise<void> {
    await this.store.lists.upsertSnapshot(initialSnapshot);
    const targetKey = liveListTargetKey(target.route, target.name);
    this.liveListTargets.set(targetKey, target);
    this.warnedUnregisteredLists.delete(targetKey);
  }

  hasRegisteredRoute(route: string): boolean {
    for (const target of this.liveListTargets.values()) {
      if (target.route === route) return true;
    }
    return false;
  }

  unregisterRoute(route: string): void {
    for (const [targetKey, target] of this.liveListTargets.entries()) {
      if (target.route === route) {
        this.liveListTargets.delete(targetKey);
        this.warnedUnregisteredLists.delete(targetKey);
      }
    }
  }

  async runOnce(): Promise<void> {
    if (this.redis) {
      await this.watcherTickRedis();
    } else {
      await this.watcherTick();
    }
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
          subClient = await this.redis.getClient().duplicate();

          const reconciliationInterval = setInterval(async () => {
            try {
              await this.watcherTickRedis();
            } catch (err: any) {
              console.error('FSR watcher: reconciliation tick failed:', err.message);
            }
          }, 60000);

          await new Promise<void>((_, reject) => {
            subClient.onclose = (err?: Error) => {
              clearInterval(reconciliationInterval);
              reject(err ?? new Error('Redis connection closed'));
            };

            signal.addEventListener('abort', () => {
              clearInterval(reconciliationInterval);
              subClient?.close();
              reject(new Error('Aborted'));
            });

            subClient.subscribe('kiln:invalidate', async (_message: string) => {
              try {
                await this.watcherTickRedis();
              } catch (err: any) {
                console.error('FSR watcher: tick failed after invalidation event:', err.message);
              }
            }).then(() => {
              console.log('FSR watcher: subscribed to kiln:invalidate');
            }).catch(reject);
          });

        } catch (err: any) {
          if (signal.aborted) break;
          console.warn('FSR watcher: Redis connection dropped or failed. Switching to poll fallback...', err.message);
          try {
            await this.watcherTickRedis();
          } catch (e: any) {
            console.error('FSR watcher: fallback tick failed:', e.message);
          }
          await new Promise(resolve => setTimeout(resolve, Math.max(100, this.config.pollIntervalMs)));
        } finally {
          if (subClient) subClient.close();
          subClient = null;
        }
      }
    };
    run();
  }

  private async watcherTick(): Promise<void> {
    const stale = await this.store.fetchStaleSlots();
    if (stale.length === 0) {
      await this.processStaleLists();
      return;
    }

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
      
      this.emitter.emit('patch', createWatcherPatch(slotRow, value));

      try {
        await this.store.markFresh(slotRow.route, slotRow.slot);
      } catch (err: any) {
        console.warn(`FSR watcher: failed to mark slot fresh for ${slotRow.route}/${slotRow.slot}:`, err.message);
      }
    }

    await this.processStaleLists();
  }

  private async watcherTickRedis(): Promise<void> {
    const stale = await this.store.fetchStaleSlots();
    if (stale.length === 0) {
      await this.processStaleLists();
      return;
    }

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
          await this.redis.publishPatch(toLegacySlotPatch(createWatcherPatch(slotRow, value)));
        } catch (e: any) {
          console.warn(`FSR watcher: Redis publishPatch failed for ${slotRow.route}/${slotRow.slot}:`, e.message);
        }
      }

      this.emitter.emit('patch', createWatcherPatch(slotRow, value));

      try {
        await this.store.markFresh(slotRow.route, slotRow.slot);
      } catch (e: any) {
        console.warn(`FSR watcher: failed to mark slot fresh for ${slotRow.route}/${slotRow.slot}:`, e.message);
      }
    }

    await this.processStaleLists();
  }

  private async processStaleLists(): Promise<void> {
    const staleLists = await this.store.lists.fetchStaleLists();
    for (const snapshot of staleLists) {
      const targetKey = liveListTargetKey(snapshot.route, snapshot.name);
      const target = this.liveListTargets.get(targetKey);
      if (!target) {
        if (!this.warnedUnregisteredLists.has(targetKey)) {
          console.warn(
            `FSR watcher: Live.list ${snapshot.route}/${snapshot.name} is stale but not registered; request the route once to restore embedded watcher callbacks`,
          );
          this.warnedUnregisteredLists.add(targetKey);
        }
        continue;
      }

      await this.revalidateLiveList(target, snapshot);
    }
  }

  private async revalidateLiveList(
    target: RegisteredLiveListTarget<any>,
    snapshot: LiveListSnapshot,
  ): Promise<void> {
    const originalFiles = new Map<string, string>();
    let originalRedisHtml: string | null = null;
    let originalRedisJson: any | null = null;

    try {
      const nextRows = await this.store.executeLiveListQuery(target.query, this.abortController.signal);
      const renderedRows = await target.renderRows(nextRows);
      const patches = reconcileListRows({
        route: snapshot.route,
        list: snapshot.name,
        keyOf: target.keyOf,
        previous: snapshot.rows.map((row) => row.data),
        next: nextRows,
      }).map((patch): RenderedListPatch => {
        if (patch.op !== 'insert' && patch.op !== 'replace-row') return patch;
        const html = renderedRows.get(patch.key);
        if (html === undefined) {
          throw new Error(`Live.list renderer did not return HTML for key "${patch.key}"`);
        }
        return { ...patch, html };
      });

      const nextSnapshotRows: LiveListSnapshotRow[] = nextRows.map((row) => {
        const key = String(target.keyOf(row));
        const html = renderedRows.get(key);
        if (html === undefined) {
          throw new Error(`Live.list renderer did not return HTML for key "${key}"`);
        }
        return { key, data: row, html };
      });

      let patchedHtml: string | null = null;
      let patchedJson: any | null = null;
      let needsReregistration = false;

      if (snapshot.htmlPath) {
        const originalHtml = await fs.readFile(snapshot.htmlPath, 'utf8');
        originalFiles.set(snapshot.htmlPath, originalHtml);
        needsReregistration = patches.some(
          (patch) =>
            patch.op === 'insert' &&
            !originalHtml.includes(`data-kiln-list="${escapeAttribute(snapshot.name)}"`),
        );
        patchedHtml = patches.reduce(
          (html, patch) => applyListPatchToHtml(html, patch),
          originalHtml,
        );
      }

      if (snapshot.jsonPath) {
        const originalJson = await fs.readFile(snapshot.jsonPath, 'utf8');
        originalFiles.set(snapshot.jsonPath, originalJson);
        patchedJson = patches.reduce(
          (json, patch) => applyListPatchToJson(json, patch, target.keyOf),
          JSON.parse(originalJson),
        );
      }

      if (this.redis) {
        originalRedisHtml = await this.redis.getHtml(snapshot.route);
        originalRedisJson = await this.redis.getJson(snapshot.route);
      }

      if (snapshot.htmlPath && patchedHtml !== null) {
        await fs.writeFile(snapshot.htmlPath, patchedHtml, 'utf8');
      }
      if (snapshot.jsonPath && patchedJson !== null) {
        await fs.writeFile(snapshot.jsonPath, JSON.stringify(patchedJson), 'utf8');
      }
      if (this.redis) {
        if (patchedHtml !== null) await this.redis.setHtml(snapshot.route, patchedHtml);
        if (patchedJson !== null) await this.redis.setJson(snapshot.route, patchedJson);
      }

      await this.store.lists.markFresh(snapshot.route, snapshot.name, nextSnapshotRows);

      if (this.redis) {
        for (const patch of patches) {
          await this.redis.publishPatch(toLegacySlotPatch(patch)).catch((err: any) => {
            console.warn(
              `FSR watcher: Redis publishPatch failed for ${snapshot.route}/${snapshot.name}:`,
              err.message,
            );
          });
        }
      }
      for (const patch of patches) {
        this.emitter.emit('patch', patch);
      }

      if (needsReregistration) {
        this.unregisterRoute(snapshot.route);
      }
    } catch (err: any) {
      for (const [filePath, content] of originalFiles.entries()) {
        await fs.writeFile(filePath, content, 'utf8').catch(() => {});
      }
      if (this.redis) {
        if (originalRedisHtml !== null) {
          await this.redis.setHtml(snapshot.route, originalRedisHtml).catch(() => {});
        }
        if (originalRedisJson !== null) {
          await this.redis.setJson(snapshot.route, originalRedisJson).catch(() => {});
        }
      }
      console.warn(
        `FSR watcher: failed to revalidate Live.list ${snapshot.route}/${snapshot.name}:`,
        err.message,
      );
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

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function createWatcherPatch(slotRow: StaleSlot, value: any): LivePatch {
  if (isScalarPatch(value)) return value;
  return createScalarPatch(slotRow.route, slotRow.slot, value);
}

function toLegacySlotPatch(patch: LivePatch): SlotPatch {
  if (patch.kind === 'scalar') {
    return { route: patch.route, slot: patch.field, value: patch.value };
  }
  return { route: patch.route, slot: patch.list, value: patch };
}
