import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { LiveProp } from '@kiln/core';
import { FsrStore, StaleSlot } from './store.js';
import { RedisCache, atomicWrite } from './cache.js';
import {
  applyListPatchToHtml,
  applyListPatchToJson,
  createScalarPatch,
  isScalarPatch,
  reconcileListRows,
  type RenderedListPatch,
  type ScalarPatch
} from '@kiln/live';
import type { LiveListSnapshot, LiveListSnapshotRow, UpsertLiveListSnapshot } from './list-store.js';
import { liveListTargetKey, type RegisteredLiveListTarget } from './live-list-runtime.js';

export interface ScheduledInvalidation {
  depKey: string;
  intervalMs: number;
}

export interface WatcherConfig {
  pollIntervalMs: number;
  patchDebounceSecs: number;
  purgeAfterSeconds: number;
  purgeSweepSeconds?: number;
  revalidateSeconds?: number;
  /** Directory the watcher's event cursor file lives in. Default '.kiln-cache'. */
  cacheDir?: string;
  scheduledInvalidations: ScheduledInvalidation[];
  /** @deprecated Use purgeSweepSeconds. */
  idleEvictSecs?: number;
  /** @deprecated Use purgeAfterSeconds. */
  idleThresholdSecs?: number;
}

export interface SlotPatch {
  route: string;
  slot: string;
  value: any;
}

export type LivePatch = ScalarPatch | RenderedListPatch;

interface RegisteredLoaderTarget {
  route: string;
  load(): Promise<Record<string, unknown>>;
}

export class FsrWatcher {
  private active = false;
  private abortController = new AbortController();
  private emitter = new EventEmitter();
  private liveListTargets = new Map<string, RegisteredLiveListTarget<any>>();
  private loaderTargets = new Map<string, RegisteredLoaderTarget>();
  private warnedUnregisteredLists = new Set<string>();
  private notificationQueue: Promise<void> = Promise.resolve();

  constructor(
    private store: FsrStore,
    private redis: RedisCache | null,
    private config: WatcherConfig
  ) {}

  getEmitter(): EventEmitter {
    return this.emitter;
  }

  registerLoader(target: RegisteredLoaderTarget): void {
    this.loaderTargets.set(target.route, target);
  }

  async registerLiveList<T>(
    target: RegisteredLiveListTarget<T>,
    initialSnapshot: UpsertLiveListSnapshot<T>
  ): Promise<void> {
    const operation = this.notificationQueue.then(async () => {
      const previousSnapshot = await this.store.lists.getSnapshot(target.route, target.name);
      const patches = previousSnapshot
        ? this.reconcileRegistration(target, previousSnapshot, initialSnapshot)
        : [];

      await this.store.lists.upsertSnapshot(initialSnapshot);
      const targetKey = liveListTargetKey(target.route, target.name);
      this.liveListTargets.set(targetKey, target);
      this.warnedUnregisteredLists.delete(targetKey);

      if (this.redis) {
        for (const patch of patches) {
          await this.redis.publishPatch(toLegacySlotPatch(patch)).catch((err: any) => {
            console.warn(
              `FSR watcher: Redis publishPatch failed for ${initialSnapshot.route}/${initialSnapshot.name}:`,
              err.message
            );
          });
        }
      }
      for (const patch of patches) {
        this.emitter.emit('patch', patch);
      }
    });

    // Return the caught chain, not the raw `operation` — a caller that
    // doesn't await this (registerLiveList is commonly fire-and-forget from
    // load()) would otherwise get an unhandled rejection whenever `operation`
    // rejects, since only `notificationQueue` was ever guaranteed to have a
    // .catch() attached.
    this.notificationQueue = operation.catch((err) => {
      console.error(`Failed to register Live.list ${target.route}/${target.name}:`, err);
    });
    return this.notificationQueue;
  }

  private reconcileRegistration<T>(
    target: RegisteredLiveListTarget<T>,
    previousSnapshot: LiveListSnapshot,
    initialSnapshot: UpsertLiveListSnapshot<T>
  ): RenderedListPatch<T>[] {
    const nextRowsByKey = new Map(initialSnapshot.rows.map((row) => [row.key, row] as const));
    return reconcileListRows({
      route: initialSnapshot.route,
      list: initialSnapshot.name,
      keyOf: target.keyOf,
      previous: previousSnapshot.rows.map((row) => row.data as T),
      next: initialSnapshot.rows.map((row) => row.data)
    }).map((patch): RenderedListPatch<T> => {
      if (patch.op !== 'insert' && patch.op !== 'fields' && patch.op !== 'replace-row') {
        return patch;
      }

      const next = nextRowsByKey.get(patch.key);
      if (!next) {
        throw new Error(`Live.list renderer did not return HTML for key "${patch.key}"`);
      }
      if (patch.op === 'insert') {
        return { ...patch, html: next.html };
      }
      return {
        kind: 'list',
        op: 'replace-row',
        route: patch.route,
        list: patch.list,
        key: patch.key,
        row: next.data,
        html: next.html
      };
    });
  }

  hasRegisteredRoute(route: string): boolean {
    for (const target of this.liveListTargets.values()) {
      if (target.route === route) return true;
    }
    return false;
  }

  unregisterRoute(route: string): void {
    this.loaderTargets.delete(route);
    for (const [targetKey, target] of this.liveListTargets.entries()) {
      if (target.route === route) {
        this.liveListTargets.delete(targetKey);
        this.warnedUnregisteredLists.delete(targetKey);
      }
    }
  }

  async runOnce(): Promise<void> {
    await this.watcherTick();
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // 0. Catch up on any missed events before we start sweeping
    await this.catchUpMissedEvents();

    // 1. Scheduled invalidations
    for (const scheduled of this.config.scheduledInvalidations) {
      this.spawnSupervisedInvalidation(scheduled, signal);
    }

    // 2. Idle eviction
    if (this.purgeSweepSeconds() > 0) {
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

  /** Returns a promise so callers (e.g. the DB notification pipeline) can
   * sequence follow-up work — like advancing the event cursor — after the
   * invalidation has actually been persisted. Errors are logged, never thrown. */
  notifyChange(depKey: string): Promise<void> {
    return this.store.invalidateDepKey(depKey)
      .then(async () => {
        if (this.redis) {
          await this.redis.publishInvalidate({
            route: '',
            slots: [],
            deps: [depKey],
          });
        }
      })
      .catch(err => {
        console.error(`Failed to invalidate dep key ${depKey}:`, err);
      });
  }

  notifyDelete(depKey: string): Promise<void> {
    return this.store.tombstoneDependentRoutes(depKey).then(async (routes) => {
      if (this.redis) {
        for (const route of routes) {
          await this.redis.publishInvalidate({
            route,
            slots: [],
            deps: [depKey],
          }).catch(() => {});
        }
      }
    }).catch(err => {
      console.error(`Failed to tombstone dependent routes for ${depKey}:`, err);
    });
  }

  private cursorPath(): string {
    return path.join(this.config.cacheDir ?? '.kiln-cache', 'cursor');
  }

  updateCursor(eventId: number): void {
    fs.writeFile(this.cursorPath(), String(eventId), 'utf8').catch((err: any) => {
      console.warn(`FSR watcher: failed to persist cursor (eventId=${eventId}):`, err.message);
    });
  }

  private async catchUpMissedEvents(): Promise<void> {
    try {
      const cursorPath = this.cursorPath();
      let cursor = 0;
      try {
        const parsed = Number(await fs.readFile(cursorPath, 'utf8'));
        if (Number.isFinite(parsed)) cursor = parsed;
      } catch {}

      const events = await this.store.fetchEventsSince(cursor);
      let lastProcessed = cursor;

      for (const event of events) {
        const { depKey, id } = event.payload;
        if (event.eventType === 'DELETE') {
          if (depKey) await this.store.tombstoneDependentRoutes(depKey);
          if (depKey && id !== undefined && id !== null) await this.store.tombstoneDependentRoutes(`${depKey}:${id}`);
        } else {
          if (depKey) await this.store.invalidateDepKey(depKey);
          if (depKey && id !== undefined && id !== null) await this.store.invalidateDepKey(`${depKey}:${id}`);
        }
        lastProcessed = event.id;
      }

      if (lastProcessed > cursor) {
        await fs.writeFile(cursorPath, String(lastProcessed), 'utf8');
      }
    } catch (err: any) {
      console.warn(`FSR watcher: failed to catch up missed events:`, err.message);
    }
  }

  private spawnSupervisedInvalidation(scheduled: ScheduledInvalidation, signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        try {
          await this.store.invalidateDepKey(scheduled.depKey);
        } catch (err: any) {
          console.error(`FSR: scheduled invalidation failed for ${scheduled.depKey}:`, err.message);
        }
        if (signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, scheduled.intervalMs));
      }
    };
    run();
  }

  private spawnSupervisedIdleEviction(signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, this.purgeSweepSeconds() * 1000));
        if (signal.aborted) break;
        try {
          const evicted = await this.store.purgeInactiveRoutes(this.purgeAfterSeconds());
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

  private purgeSweepSeconds(): number {
    return this.config.purgeSweepSeconds ?? this.config.idleEvictSecs ?? 3_600;
  }

  private purgeAfterSeconds(): number {
    return this.config.purgeAfterSeconds ?? this.config.idleThresholdSecs ?? 2_592_000;
  }

  private spawnSupervisedPollingWatcher(signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        try {
          await this.watcherTick();
        } catch (err: any) {
          console.error('FSR watcher tick failed:', err.message);
        }
        await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
      }
    };
    run();
  }

  private spawnSupervisedRedisWatcher(signal: AbortSignal): void {
    const run = async () => {
      let subClient: any = null;
      while (!signal.aborted) {
        // Both are cleaned up in `finally` each iteration so reconnect loops
        // never accumulate timers or abort listeners on the shared signal.
        let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
        let onAbort: (() => void) | null = null;
        try {
          if (!this.redis) break;
          subClient = await this.redis.getClient().duplicate();
          // Subscribe to the same namespaced channel this instance's
          // RedisCache publishes to (default `kiln:invalidate`).
          const invalidateChannel = this.redis.invalidateChannel();

          reconciliationInterval = setInterval(async () => {
            try {
              await this.watcherTick();
            } catch (err: any) {
              console.error('FSR watcher: reconciliation tick failed:', err.message);
            }
          }, Math.max(100, Math.min(this.config.pollIntervalMs || 1000, 1000)));

          await new Promise<void>((_, reject) => {
            subClient.onclose = (err?: Error) => {
              reject(err ?? new Error('Redis connection closed'));
            };

            onAbort = () => {
              subClient?.close();
              reject(new Error('Aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });

            subClient
              .subscribe(invalidateChannel, async (_message: string) => {
                try {
                  await this.watcherTick();
                } catch (err: any) {
                  console.error('FSR watcher: tick failed after invalidation event:', err.message);
                }
              })
              .then(() => {
                console.log(`FSR watcher: subscribed to ${invalidateChannel}`);
              })
              .catch(reject);
          });
        } catch (err: any) {
          if (signal.aborted) break;
          console.warn('FSR watcher: Redis connection dropped or failed. Switching to poll fallback...', err.message);
          try {
            await this.watcherTick();
          } catch (e: any) {
            console.error('FSR watcher: fallback tick failed:', e.message);
          }
          await new Promise((resolve) => setTimeout(resolve, Math.max(100, this.config.pollIntervalMs)));
        } finally {
          if (reconciliationInterval) clearInterval(reconciliationInterval);
          if (onAbort) signal.removeEventListener('abort', onAbort);
          if (subClient) subClient.close();
          subClient = null;
        }
      }
    };
    run();
  }

  /** Single tick for both polling and Redis modes — Redis-specific steps
   * no-op when no Redis client is configured. */
  private async watcherTick(): Promise<void> {
    const stale = await this.store.fetchStaleSlots();
    if (stale.length === 0) {
      await this.processStaleLists();
      return;
    }

    // Phase 1: run DB queries
    const loaderRows = stale.filter((slotRow) => !slotRow.query);
    const queryRows = stale.filter((slotRow) => Boolean(slotRow.query));
    await this.refreshRegisteredLoaders(loaderRows);
    const results: { slotRow: StaleSlot; value: any; err?: any }[] = [];
    for (const slotRow of queryRows) {
      try {
        const value = await this.store.reExecuteQuery(slotRow);
        results.push({ slotRow, value });
      } catch (err: any) {
        console.warn(`FSR watcher: failed to re-execute query for ${slotRow.route}/${slotRow.slot}:`, err.message);
        results.push({ slotRow, value: null, err });
      }
    }

    // Phase 2a: batch patches per JSON file (disk) and per route (Redis).
    // JSON snapshots are authoritative; shells are immutable.
    const jsonPatches = new Map<string, [string, any][]>();
    const redisJsonPatches = new Map<string, [string, any][]>();
    for (const { slotRow, value, err } of results) {
      if (err) continue;
      if (slotRow.promoted && slotRow.jsonPath) {
        if (!jsonPatches.has(slotRow.jsonPath)) jsonPatches.set(slotRow.jsonPath, []);
        jsonPatches.get(slotRow.jsonPath)!.push([slotRow.slot, value]);

        if (this.redis) {
          if (!redisJsonPatches.has(slotRow.route)) redisJsonPatches.set(slotRow.route, []);
          redisJsonPatches.get(slotRow.route)!.push([slotRow.slot, value]);
        }
      }
    }

    // Phase 2b: patch disk files
    for (const [jsonPath, patches] of jsonPatches.entries()) {
      await this.patchJsonFileBatch(jsonPath, patches);
    }

    const htmlToMaterialize = new Set<string>();
    for (const { slotRow, err } of results) {
      if (err) continue;
      if (slotRow.promoted && slotRow.patchMode === 'both' && slotRow.htmlPath && slotRow.jsonPath) {
        htmlToMaterialize.add(JSON.stringify({ htmlPath: slotRow.htmlPath, jsonPath: slotRow.jsonPath }));
      }
    }
    for (const pairStr of htmlToMaterialize) {
      const { htmlPath, jsonPath } = JSON.parse(pairStr);
      await this.materializeHtmlFile(htmlPath, jsonPath);
    }

    // Phase 2c: Redis JSON read/merge/write. The Redis entry holds the same
    // BakedSnapshot shape as the disk file ({ schemaVersion, data, ... }),
    // and materializeBakedShell only reads `data` — so patches must land
    // inside `data`, exactly like patchJsonFileBatch does for disk.
    if (this.redis) {
      for (const [route, patches] of redisJsonPatches.entries()) {
        try {
          const existing = (await this.redis.getJson(route)) || {};
          const target =
            existing.data && typeof existing.data === 'object' && !Array.isArray(existing.data)
              ? existing.data
              : existing;
          for (const [slot, val] of patches) {
            target[slot] = val;
          }
          if ('updatedAt' in existing) existing.updatedAt = new Date().toISOString();
          await this.redis.setJson(route, existing);
        } catch (e: any) {
          console.warn(`FSR watcher: Redis setJson failed for ${route}:`, e.message);
        }
      }
    }

    // Phase 2d: Redis slot hash + pub/sub, local SSE, mark fresh
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
    const staleLists = await this.store.lists.fetchStaleLists(this.config.revalidateSeconds ?? 300);
    for (const snapshot of staleLists) {
      const targetKey = liveListTargetKey(snapshot.route, snapshot.name);
      const target = this.liveListTargets.get(targetKey);
      if (!target) {
        if (!this.warnedUnregisteredLists.has(targetKey)) {
          console.warn(
            `FSR watcher: Live.list ${snapshot.route}/${snapshot.name} is stale but not registered; request the route once to restore embedded watcher callbacks`
          );
          this.warnedUnregisteredLists.add(targetKey);
        }
        continue;
      }

      await this.revalidateLiveList(target, snapshot);
    }
  }

  private async refreshRegisteredLoaders(rows: StaleSlot[]): Promise<void> {
    const byRoute = new Map<string, StaleSlot[]>();
    for (const row of rows) {
      const existing = byRoute.get(row.route) ?? [];
      existing.push(row);
      byRoute.set(row.route, existing);
    }

    for (const [route, routeRows] of byRoute) {
      const target = this.loaderTargets.get(route);
      if (!target) continue;
      try {
        const loaded = await target.load();
        const paths = await this.store.getPromotedPaths(route);
        let snapshot: any = null;
        if (paths?.jsonPath) {
          try {
            snapshot = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
          } catch {
            snapshot = null;
          }
        }
        if (!snapshot && this.redis) snapshot = await this.redis.getJson(route);
        if (!snapshot) continue;
        const data = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;

        for (const row of routeRows) {
          const raw = loaded[row.slot] as any;
          const value = raw instanceof LiveProp ? raw.value : raw;
          data[row.slot] = value;
          this.emitter.emit('patch', createScalarPatch(route, row.slot, value));
          await this.store.markFresh(route, row.slot);
        }
        if ('updatedAt' in snapshot) snapshot.updatedAt = new Date().toISOString();
        if (paths?.jsonPath) await atomicWrite(paths.jsonPath, JSON.stringify(snapshot));
        if (this.redis) await this.redis.setJson(route, snapshot);

        const patchMode = await this.store.getRoutePatchMode(route);
        if (patchMode === 'both' && paths?.htmlPath && paths?.jsonPath) {
          await this.materializeHtmlFile(paths.htmlPath, paths.jsonPath);
        }
      } catch (error: any) {
        console.warn(`FSR watcher: loader refresh failed for ${route}:`, error.message);
      }
    }
  }

  private async revalidateLiveList(
    target: RegisteredLiveListTarget<any>,
    snapshot: LiveListSnapshot,
  ): Promise<void> {
    const originalFiles = new Map<string, string>();
    let originalRedisJson: any | null = null;

    try {
      const nextRows = await this.store.executeLiveListQuery(target.query, this.abortController.signal);
      const renderedRows = await target.renderRows(nextRows);
      const rowsByKey = new Map(
        nextRows.map((row) => [String(target.keyOf(row)), row] as const),
      );
      const patches = reconcileListRows({
        route: snapshot.route,
        list: snapshot.name,
        keyOf: target.keyOf,
        previous: snapshot.rows.map((row) => row.data),
        next: nextRows
      }).map((patch): RenderedListPatch => {
        if (patch.op === 'fields') {
          const html = renderedRows.get(patch.key);
          const row = rowsByKey.get(patch.key);
          if (html === undefined || row === undefined) {
            throw new Error(`Live.list renderer did not return HTML for key "${patch.key}"`);
          }
          return {
            kind: 'list',
            op: 'replace-row',
            route: patch.route,
            list: patch.list,
            key: patch.key,
            row,
            html,
          };
        }
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

      let patchedJson: any | null = null;

      if (snapshot.jsonPath) {
        const originalJson = await fs.readFile(snapshot.jsonPath, 'utf8');
        originalFiles.set(snapshot.jsonPath, originalJson);
        const parsed = JSON.parse(originalJson);
        const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        patchedJson = patches.reduce(
          (json, patch) => applyListPatchToJson(json, patch, target.keyOf),
          data,
        );
        if (parsed.data && typeof parsed.data === 'object') {
          parsed.data = patchedJson;
          parsed.lists = {
            ...(parsed.lists ?? {}),
            [snapshot.name]: nextSnapshotRows.map((row) => ({ key: row.key, html: row.html })),
          };
          parsed.updatedAt = new Date().toISOString();
          patchedJson = parsed;
        }
      }

      if (this.redis) {
        originalRedisJson = await this.redis.getJson(snapshot.route);
      }

      if (snapshot.jsonPath && patchedJson !== null) {
        await atomicWrite(snapshot.jsonPath, JSON.stringify(patchedJson));
      }
      if (this.redis) {
        if (patchedJson !== null) await this.redis.setJson(snapshot.route, patchedJson);
      }

      const patchMode = await this.store.getRoutePatchMode(snapshot.route);
      if (patchMode === 'both' && snapshot.htmlPath && snapshot.jsonPath) {
        await this.materializeHtmlFile(snapshot.htmlPath, snapshot.jsonPath);
      }

      await this.store.lists.markFresh(snapshot.route, snapshot.name, nextSnapshotRows);

      if (this.redis) {
        for (const patch of patches) {
          await this.redis.publishPatch(toLegacySlotPatch(patch)).catch((err: any) => {
            console.warn(`FSR watcher: Redis publishPatch failed for ${snapshot.route}/${snapshot.name}:`, err.message);
          });
        }
      }
      for (const patch of patches) {
        this.emitter.emit('patch', patch);
      }

    } catch (err: any) {
      for (const [filePath, content] of originalFiles.entries()) {
        await fs.writeFile(filePath, content, 'utf8').catch(() => {});
      }
      if (this.redis) {
        if (originalRedisJson !== null) {
          await this.redis.setJson(snapshot.route, originalRedisJson).catch(() => {});
        }
      }
      console.warn(`FSR watcher: failed to revalidate Live.list ${snapshot.route}/${snapshot.name}:`, err.message);
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
      const target = obj.data && typeof obj.data === 'object' ? obj.data : obj;
      for (const [slot, value] of patches) {
        target[slot] = value;
      }
      if ('updatedAt' in obj) obj.updatedAt = new Date().toISOString();
      await atomicWrite(jsonPath, JSON.stringify(obj));
    } catch (err: any) {
      console.warn(`FSR watcher: failed to patch JSON file at ${jsonPath}:`, err.message);
    }
  }

  private async materializeHtmlFile(htmlPath: string, jsonPath: string): Promise<void> {
    try {
      const htmlShell = await fs.readFile(htmlPath, 'utf8');
      const jsonStr = await fs.readFile(jsonPath, 'utf8');
      const jsonSnapshot = JSON.parse(jsonStr);
      
      const { materializeBakedShell } = await import('./baking.js');
      const materialized = materializeBakedShell(htmlShell, jsonSnapshot);
      
      if (materialized) {
        await atomicWrite(htmlPath, materialized);
      }
    } catch (err: any) {
      console.warn(`FSR watcher: failed to materialize HTML file at ${htmlPath}:`, err.message);
    }
  }
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
