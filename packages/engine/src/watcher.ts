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
  /** Only eagerly revalidate stale slots on routes active within this many
   * seconds (last_active_at). Undefined = revalidate all stale slots
   * unconditionally (today's behavior, no dormancy tier). */
  activeWindowSecs?: number;
  /** Directory the watcher's event cursor file lives in. Default '.kiln-cache'. */
  cacheDir?: string;
  scheduledInvalidations: ScheduledInvalidation[];
}

export interface SlotPatch {
  route: string;
  slot: string;
  value: any;
  /** Set for bake='user' snapshots — the patch belongs to one user's artifact. */
  userKey?: string;
}

export type LivePatch = ScalarPatch | RenderedListPatch;

interface RegisteredLoaderTarget {
  route: string;
  /** '' / absent = the shared route; set = one user's bake='user' snapshot. */
  userKey?: string;
  load(): Promise<Record<string, unknown>>;
}

const loaderKey = (route: string, userKey?: string) => `${route}\u0000${userKey ?? ''}`;
const variantOf = (userKey?: string) => (userKey ? `u:${userKey}` : undefined);

// Bounds the same-process activity cache (markLocallyActive/isLocallyActive)
// so a long-running server with high route/user cardinality can't grow it
// without bound — mirrors the DEDUP_SET_MAX pattern in routekit/boot.ts.
// Losing an entry just means the next cache hit for that (route, userKey)
// falls back to the Postgres dormant-staleness check, never incorrect.
const LOCAL_ACTIVE_MAX = 10_000;

export class FsrWatcher {
  private active = false;
  private abortController = new AbortController();
  private emitter = new EventEmitter();
  private liveListTargets = new Map<string, RegisteredLiveListTarget<any>>();
  private loaderTargets = new Map<string, RegisteredLoaderTarget>();
  private warnedUnregisteredLists = new Set<string>();
  private notificationQueue: Promise<void> = Promise.resolve();
  // Same-process record of "this (route, userKey) was confirmed active
  // recently" (SSE subscribe calls markLocallyActive). Lets routekit's read
  // path skip its own dormant-staleness Postgres query for snapshots this
  // process already knows the watcher is keeping fresh via pg_notify —
  // restoring the zero-Postgres cached read path for active snapshots
  // (Plan 3 review Important #2). Purely a local optimization: a route this
  // process hasn't seen SSE traffic for (or another process's subscriber)
  // just falls back to the Postgres check, which is always correct either way.
  private locallyActiveAt = new Map<string, number>();

  constructor(
    private store: FsrStore,
    private redis: RedisCache | null,
    private config: WatcherConfig
  ) {}

  getEmitter(): EventEmitter {
    return this.emitter;
  }

  registerLoader(target: RegisteredLoaderTarget): void {
    this.loaderTargets.set(loaderKey(target.route, target.userKey), target);
  }

  /** Removes the (route, userKey) loader registration — called when its
   * snapshot is purged/evicted so `loaderTargets` doesn't grow unbounded as
   * users/routes churn (Plan-2 review #4). */
  unregisterLoader(route: string, userKey?: string): void {
    const key = loaderKey(route, userKey);
    this.loaderTargets.delete(key);
    this.locallyActiveAt.delete(key);
  }

  /**
   * Records that (route, userKey) was just confirmed active in THIS
   * process — called on SSE subscribe. `isLocallyActive` lets the read path
   * trust that signal instead of issuing its own Postgres dormant check.
   */
  markLocallyActive(route: string, userKey?: string): void {
    if (this.locallyActiveAt.size >= LOCAL_ACTIVE_MAX) this.locallyActiveAt.clear();
    this.locallyActiveAt.set(loaderKey(route, userKey), Date.now());
  }

  /** True if markLocallyActive(route, userKey) was called within windowSecs. */
  isLocallyActive(route: string, userKey: string | undefined, windowSecs: number): boolean {
    const at = this.locallyActiveAt.get(loaderKey(route, userKey));
    return at !== undefined && Date.now() - at < windowSecs * 1000;
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
    // loaderTargets is always keyed via loaderKey(route, userKey), which
    // appends a userKey suffix even for the shared/no-user case — so a
    // route can own multiple entries (one shared + one per bake='user'
    // variant). Clear all of them, not just a bare `route` key that never
    // matches a real entry. The NUL separator in loaderKey is what makes
    // the prefix scan safe: a "/foo" prefix cannot match "/foobar".
    const prefix = loaderKey(route, undefined);
    for (const key of this.loaderTargets.keys()) {
      if (key.startsWith(prefix)) this.loaderTargets.delete(key);
    }
    // Same keying, same reason unregisterLoader clears it: a leftover
    // local-active mark would keep boot.ts's read path skipping its
    // dormant-staleness check for a route that no longer has a loader.
    for (const key of this.locallyActiveAt.keys()) {
      if (key.startsWith(prefix)) this.locallyActiveAt.delete(key);
    }
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
  notifyChange(depKey: string, owner?: string): Promise<void> {
    return this.store.invalidateDepKey(depKey, owner)
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

  // Owner-scoped since 2026-08-01, matching notifyChange: a DELETE used to
  // tombstone the route for EVERY user, destroying artifacts and forcing a
  // full re-render apiece over one user's deleted row. An owner-less payload
  // (a trigger that doesn't emit one) still fans out route-wide.
  notifyDelete(depKey: string, owner?: string): Promise<void> {
    return this.store.tombstoneDependentRoutes(depKey, owner).then(async (routes) => {
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

  /**
   * Last event id this process has handled. The file is the cross-restart
   * copy; this is the authority while the process lives, so a reconnect
   * replays the right window even if the file could never be written (a
   * container with no writable cache dir, say).
   */
  private lastEventId: number | null = null;

  updateCursor(eventId: number): void {
    this.lastEventId = eventId;
    this.persistCursor(eventId).catch((err: any) => {
      console.warn(`FSR watcher: failed to persist cursor (eventId=${eventId}):`, err.message);
    });
  }

  /** mkdir first: nothing else creates the cache dir, and a failed cursor
   * write used to mean the next boot replayed from 0 — which was harmless only
   * while catch-up was a no-op, and is a stampede now that it works. */
  private async persistCursor(eventId: number): Promise<void> {
    await fs.mkdir(path.dirname(this.cursorPath()), { recursive: true });
    await fs.writeFile(this.cursorPath(), String(eventId), 'utf8');
  }

  private async readPersistedCursor(): Promise<number | null> {
    try {
      const parsed = Number(await fs.readFile(this.cursorPath(), 'utf8'));
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Replay every invalidation event recorded since the persisted cursor.
   *
   * Public, and called from two places: `start()`, and the DB notification
   * pipeline every time it (re)establishes `LISTEN`. The second caller is the
   * point — a mid-life connection drop used to re-LISTEN, log "reconnected to
   * Postgres" and replay nothing, so events emitted during the gap were lost
   * until a process restart. Always call it *after* LISTEN is established:
   * events arriving during the replay then also arrive as notifications, and
   * a double invalidation is a no-op (both paths set `stale = TRUE`), whereas
   * the reverse order leaves a real gap.
   */
  async catchUpMissedEvents(): Promise<void> {
    try {
      let cursor = this.lastEventId ?? (await this.readPersistedCursor());

      if (cursor === null) {
        // No cursor anywhere: this process has never handled an event and no
        // previous run left a mark. There is no gap to close, and
        // kiln_fsr_events is never pruned — replaying from 0 would invalidate
        // against the app's entire history on every cold start. Adopt the
        // current head instead and start recovering from here.
        //
        // KNOWN LIMITATION: the cursor lives on local disk while the events
        // live in shared Postgres, so a container without a persistent cache
        // dir takes this branch on every restart and cannot recover a
        // restart-sized gap (a reconnect gap is still covered — that uses the
        // in-memory cursor). Moving the cursor into Postgres is the real fix
        // and is out of scope here.
        const head = await this.store.getLatestEventId();
        this.lastEventId = head;
        if (head > 0) await this.persistCursor(head);
        console.info(
          `FSR watcher: no event cursor found; adopting current head (eventId=${head}) ` +
            `without replaying history`,
        );
        return;
      }

      // Adopt the resolved cursor in memory even when the replay below finds
      // nothing: otherwise a cursor that came from the file leaves lastEventId
      // null, and a later reconnect would have to re-read a file that may by
      // then be unreadable — the exact dependency this field exists to remove.
      this.lastEventId = Math.max(this.lastEventId ?? 0, cursor);

      const events = await this.store.fetchEventsSince(cursor);
      let lastProcessed = cursor;
      let undecodable = 0;
      let replayed = 0;

      for (const event of events) {
        // Never `event.payload.depKey` on an unchecked value: this destructured
        // a jsonb string for two releases, so `depKey` was always undefined and
        // every event silently did nothing while the cursor advanced past it.
        // fetchEventsSince now decodes, and hands back null when it cannot.
        const payload = event.payload;
        if (!payload) {
          undecodable++;
          lastProcessed = event.id;
          continue;
        }
        const { depKey, id } = payload;
        // Route-wide rather than owner-scoped, deliberately. The payload DOES
        // carry `owner` when the trigger names an owner column (see
        // schema.ts's kiln_emit_event) — but catch-up runs precisely when
        // state is uncertain, and over-invalidating costs a re-render while
        // under-invalidating serves stale data. Narrow this only with a test
        // that fails when the owner is wrong.
        if (event.eventType === 'DELETE') {
          if (depKey) await this.store.tombstoneDependentRoutes(depKey);
          if (depKey && id !== undefined && id !== null) await this.store.tombstoneDependentRoutes(`${depKey}:${id}`);
        } else {
          if (depKey) await this.store.invalidateDepKey(depKey);
          if (depKey && id !== undefined && id !== null) await this.store.invalidateDepKey(`${depKey}:${id}`);
        }
        if (depKey) replayed++;
        else undecodable++;
        lastProcessed = event.id;
      }

      if (undecodable > 0) {
        // Loud on purpose. The cursor still advances past these so one bad row
        // cannot wedge recovery forever — but silence is what let the whole
        // mechanism sit broken, so a skipped event must never be quiet again.
        console.warn(
          `FSR watcher: catch-up skipped ${undecodable} event(s) with no usable depKey ` +
            `(cursor advanced past them; they will not be retried)`,
        );
      }
      if (replayed > 0) {
        console.info(`FSR watcher: replayed ${replayed} missed invalidation event(s)`);
      }

      if (lastProcessed > cursor) {
        // Monotonic, never a plain assignment: a live notification can land
        // mid-replay and call updateCursor() with a HIGHER id, and finishing
        // the replay must not drag the cursor back behind it.
        this.lastEventId = Math.max(this.lastEventId ?? 0, lastProcessed);
        await this.persistCursor(lastProcessed);
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
            this.unregisterLoader(r.route, r.userKey);
            if (this.redis) {
              await this.redis.deleteRouteKeys(r.route, variantOf(r.userKey || undefined)).catch(() => {});
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
    return this.config.purgeSweepSeconds ?? 3_600;
  }

  private purgeAfterSeconds(): number {
    return this.config.purgeAfterSeconds ?? 2_592_000;
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
    const stale = await this.store.fetchStaleSlots({ activeWindowSecs: this.config.activeWindowSecs });
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
    const redisJsonPatches = new Map<string, { route: string; variant?: string; patches: [string, any][] }>();
    for (const { slotRow, value, err } of results) {
      if (err) continue;
      if (slotRow.promoted && slotRow.jsonPath) {
        if (!jsonPatches.has(slotRow.jsonPath)) jsonPatches.set(slotRow.jsonPath, []);
        jsonPatches.get(slotRow.jsonPath)!.push([slotRow.slot, value]);

        if (this.redis) {
          const rk = loaderKey(slotRow.route, slotRow.userKey);
          if (!redisJsonPatches.has(rk)) {
            redisJsonPatches.set(rk, {
              route: slotRow.route,
              variant: variantOf(slotRow.userKey || undefined),
              patches: [],
            });
          }
          redisJsonPatches.get(rk)!.patches.push([slotRow.slot, value]);
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
      for (const { route, variant, patches } of redisJsonPatches.values()) {
        try {
          const existing = (await this.redis.getJson(route, variant)) || {};
          const target =
            existing.data && typeof existing.data === 'object' && !Array.isArray(existing.data)
              ? existing.data
              : existing;
          // Keep the sibling pageData object (read by the JSON fast path)
          // patched alongside data — see patchJsonFileBatch above.
          const pageDataTarget =
            existing.pageData && typeof existing.pageData === 'object' && !Array.isArray(existing.pageData)
              ? existing.pageData
              : null;
          for (const [slot, val] of patches) {
            target[slot] = val;
            if (pageDataTarget) pageDataTarget[slot] = val;
          }
          if ('updatedAt' in existing) existing.updatedAt = new Date().toISOString();
          await this.redis.setJson(route, existing, variant);
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
          await this.redis.patchSlot(slotRow.route, slotRow.slot, valStr, variantOf(slotRow.userKey || undefined));
        } catch (e: any) {
          console.warn(`FSR watcher: Redis patchSlot failed for ${slotRow.route}/${slotRow.slot}:`, e.message);
        }

        try {
          const payload = toLegacySlotPatch(createWatcherPatch(slotRow, value));
          if (slotRow.userKey) payload.userKey = slotRow.userKey;
          await this.redis.publishPatch(payload);
        } catch (e: any) {
          console.warn(`FSR watcher: Redis publishPatch failed for ${slotRow.route}/${slotRow.slot}:`, e.message);
        }
      }

      {
        const patch = createWatcherPatch(slotRow, value) as any;
        if (slotRow.userKey) patch.userKey = slotRow.userKey;
        this.emitter.emit('patch', patch);
      }

      try {
        // slotRow.version is the version fetchStaleSlots claimed this slot
        // at — passing it back keeps an invalidation that arrived during the
        // requery from being cleared by this write.
        await this.store.markFresh(slotRow.route, slotRow.slot, slotRow.userKey, slotRow.version);
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
    const byTarget = new Map<string, StaleSlot[]>();
    for (const row of rows) {
      const key = loaderKey(row.route, row.userKey);
      const existing = byTarget.get(key) ?? [];
      existing.push(row);
      byTarget.set(key, existing);
    }

    for (const [key, targetRows] of byTarget) {
      const target = this.loaderTargets.get(key);
      if (!target) continue;
      const route = targetRows[0].route;
      const userKey = targetRows[0].userKey || '';
      const variant = variantOf(userKey || undefined);
      try {
        const loaded = await target.load();
        const paths = await this.store.getPromotedPaths(route, userKey);
        let snapshot: any = null;
        if (paths?.jsonPath) {
          try {
            snapshot = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
          } catch {
            snapshot = null;
          }
        }
        if (!snapshot && this.redis) snapshot = await this.redis.getJson(route, variant);
        if (!snapshot) continue;
        const data = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
        // Keep the sibling pageData object (read by the JSON fast path)
        // patched alongside data — see patchJsonFileBatch above.
        const pageData =
          snapshot.pageData && typeof snapshot.pageData === 'object' && !Array.isArray(snapshot.pageData)
            ? snapshot.pageData
            : null;

        for (const row of targetRows) {
          const raw = loaded[row.slot] as any;
          const value = raw instanceof LiveProp ? raw.value : raw;
          data[row.slot] = value;
          if (pageData) pageData[row.slot] = value;
          const patch = createScalarPatch(route, row.slot, value) as any;
          if (userKey) patch.userKey = userKey;
          this.emitter.emit('patch', patch);
          await this.store.markFresh(route, row.slot, userKey, row.version);
        }
        if ('updatedAt' in snapshot) snapshot.updatedAt = new Date().toISOString();
        if (paths?.jsonPath) await atomicWrite(paths.jsonPath, JSON.stringify(snapshot));
        if (this.redis) await this.redis.setJson(route, snapshot, variant);

        const patchMode = await this.store.getRoutePatchMode(route, userKey);
        if (patchMode === 'both' && paths?.htmlPath && paths?.jsonPath) {
          await this.materializeHtmlFile(paths.htmlPath, paths.jsonPath);
        }
      } catch (error: any) {
        console.warn(`FSR watcher: loader refresh failed for ${route} (${userKey || 'shared'}):`, error.message);
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
      // pageData is the sibling object the JSON fast path (Accept:
      // application/json on a baked route) actually reads — must stay in
      // lockstep with `data` or that path serves stale props.
      const pageDataTarget =
        obj.pageData && typeof obj.pageData === 'object' && !Array.isArray(obj.pageData) ? obj.pageData : null;
      for (const [slot, value] of patches) {
        target[slot] = value;
        if (pageDataTarget) pageDataTarget[slot] = value;
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
