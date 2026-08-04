import type { LiveListQueryContext } from '@kiln/live';
import { FsrListStore } from './list-store.js';
import { KILN_FSR_SCHEMA_SQL } from './schema.js';

export type BunSqlClient = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  unsafe(query: string, params?: unknown[]): Promise<any[]>;
};

export interface StaleSlot {
  route: string;
  slot: string;
  userKey: string;
  /** The row's `version` when this slot was read/claimed. Hand it back to
   * `markFresh` so an invalidation arriving during the requery isn't cleared. */
  version: number;
  query: string | null;
  queryParams: any;
  dependsOn: string[];
  promoted: boolean;
  debounceSecs: number | null;
  htmlPath: string | null;
  jsonPath: string | null;
  columnName: string | null;
  patchMode: 'json' | 'both' | null;
}

export interface EvictedRoute {
  route: string;
  userKey: string;
  htmlPath: string | null;
  jsonPath: string | null;
}

export interface InspectRow {
  route: string;
  slot: string;
  userKey: string;
  dependsOn: string[];
  stale: boolean;
  version: number;
  promoted: boolean;
  /** Whether the row is tombstoned. Exposed so owner-scoped DELETE
   * fan-out can be asserted without dropping to raw SQL in a test. */
  tombstoned: boolean;
  htmlPath: string | null;
  jsonPath: string | null;
}

const REQUERY_TIMEOUT_MS = 10_000;

/**
 * Normalizes an event payload to an object, or null if it cannot be.
 *
 * **Corrected 2026-08-04:** this used to say "jsonb through bun's SQL arrives
 * as a string". Measured against bun 1.3.14, it does not — a jsonb object
 * comes back as a JS object and a jsonb array as a JS array. What arrives as a
 * string is a value *stored* through `${JSON.stringify(x)}::jsonb`, which
 * binds the JS string as a jsonb **string** (`jsonb_typeof` = string):
 * double-encoded going in, decoded faithfully coming out. Every payload
 * `kiln_emit_event` writes uses `jsonb_build_object`, so production events are
 * real objects and always were.
 *
 * The string branch therefore guards double-encoded rows and other drivers,
 * not a bun quirk. Kept — it costs one typeof and the alternative is silently
 * skipped events — but no longer sold as the cause of anything.
 */
export function decodeEventPayload(raw: unknown): Record<string, any> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export class FsrStore {
  readonly lists: FsrListStore;

  constructor(
    private sql: BunSqlClient,
    private globalDebounceSecs = 0,
    private redis: any = null
  ) {
    this.lists = new FsrListStore(sql);
  }

  withPool(sql: BunSqlClient): this {
    this.sql = sql;
    this.lists.setSql(sql);
    return this;
  }

  withGlobalDebounce(secs: number): this {
    this.globalDebounceSecs = secs;
    return this;
  }

  withRedis(redis: any): this {
    this.redis = redis;
    return this;
  }

  async initialize(): Promise<void> {
    await this.sql.unsafe(KILN_FSR_SCHEMA_SQL);
  }

  async ensureRouteRow(
    route: string,
    revalidateSecs = 300,
    purgeAfterSecs = 2_592_000,
    patchMode: 'json' | 'both' | null = 'json',
    userKey = '',
  ): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr
        (route, slot, user_key, revalidate_secs, purge_after_secs, patch_mode, last_requested_at)
      VALUES (${route}, '', ${userKey}, ${revalidateSecs}, ${purgeAfterSecs}, ${patchMode}, NOW())
      ON CONFLICT (route, user_key, slot) DO UPDATE SET
        revalidate_secs = ${revalidateSecs},
        purge_after_secs = ${purgeAfterSecs},
        patch_mode = ${patchMode}
    `;
  }

  /** Slot → `version` for one (route, user_key), for callers that need to
   * detect an invalidation landing mid-render. Snapshot this BEFORE running
   * `load()` and hand each slot's value back to `upsertSlot` as
   * `expectedVersion`; capturing it afterwards would already include the very
   * invalidation the guard exists to notice. Absent slots are simply missing
   * from the result (they'll take upsertSlot's INSERT path). */
  async fetchSlotVersions(route: string, userKey = ''): Promise<Record<string, number>> {
    const rows = await this.sql`
      SELECT slot, version FROM kiln_fsr
      WHERE route = ${route} AND user_key = ${userKey} AND slot != ''`;
    const out: Record<string, number> = {};
    for (const r of rows as any[]) out[r.slot] = Number(r.version);
    return out;
  }

  /**
   * @param expectedVersion the slot's `version` as observed BEFORE this
   * render's `load()` ran. `stale` is cleared only if the row still carries
   * that version — i.e. nothing invalidated the slot while we were rendering.
   *
   * Clearing `stale` unconditionally would swallow any invalidation that
   * landed between `load()` reading the data and this write, leaving the
   * freshly baked artifact holding pre-invalidation data with its stale flag
   * reset. On an ACTIVE route the time-based `revalidate_secs` branch of
   * fetchStaleSlots eventually recovers, but a DORMANT route has neither
   * tier — the watcher skips it and the read path's rebuild only triggers on
   * `stale = TRUE` — so it would serve that snapshot until the next
   * dependency write. `invalidateDepKey` bumps `version` alongside setting
   * `stale`, which is what makes the comparison meaningful.
   *
   * Omitting it leaves `stale` untouched rather than clearing blind. Both
   * failure directions are safe: a version that moved for a benign reason
   * (`markFresh` also bumps it) just costs one redundant rebuild, which
   * re-reads the current version and clears the flag then.
   */
  async upsertSlot(
    route: string,
    slot: string,
    querySql: string | null,
    queryParams: any,
    dependsOn: string[],
    debounceSecs?: number,
    columnName?: string | null,
    userKey = '',
    expectedVersion?: number
  ): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr
        (route, slot, user_key, query, query_params, depends_on, debounce_secs, column_name)
      VALUES (
        ${route},
        ${slot},
        ${userKey},
        ${querySql},
        ${queryParams}::jsonb,
        ARRAY(SELECT jsonb_array_elements_text(${dependsOn}::jsonb))::text[],
        ${debounceSecs ?? null},
        ${columnName ?? null}
      )
      ON CONFLICT (route, user_key, slot) DO UPDATE SET
        query         = EXCLUDED.query,
        query_params  = EXCLUDED.query_params,
        depends_on    = EXCLUDED.depends_on,
        debounce_secs = EXCLUDED.debounce_secs,
        column_name   = EXCLUDED.column_name,
        stale         = CASE
                          WHEN ${expectedVersion ?? null}::int IS NOT NULL
                           AND kiln_fsr.version = ${expectedVersion ?? null}::int
                          THEN FALSE
                          ELSE kiln_fsr.stale
                        END
    `;
  }

  async touchRoute(route: string, userKey = ''): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr SET last_requested_at = NOW()
      WHERE route = ${route} AND slot = '' AND user_key = ${userKey} AND NOT tombstoned
    `;
  }

  async markActive(route: string, userKey = ''): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr SET last_active_at = NOW()
      WHERE route = ${route} AND slot = '' AND user_key = ${userKey}`;
  }

  async tombstone(route: string): Promise<void> {
    const rows = await this.sql`
      UPDATE kiln_fsr
      SET tombstoned = TRUE, stale = FALSE
      WHERE route = ${route}
      RETURNING slot, html_path as "htmlPath", json_path as "jsonPath"
    `;

    if (this.redis) {
      await this.redis.deleteRouteKeys(route).catch(() => {});
    }
    await this.lists.deleteRoute(route);

    // One route-level row per user_key now — unlink every user's artifacts.
    for (const routeRow of rows.filter((r) => r.slot === '')) {
      try {
        const fs = await import('fs/promises');
        if (routeRow.htmlPath) {
          await fs.unlink(routeRow.htmlPath).catch(() => {});
        }
        if (routeRow.jsonPath) {
          await fs.unlink(routeRow.jsonPath).catch(() => {});
        }
      } catch (e) {
        // ignore fs errors
      }
    }
  }

  async isTombstoned(route: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT tombstoned FROM kiln_fsr WHERE route = ${route} AND slot = '' AND user_key = ''
    `;
    const row = rows[0] as any;
    return row ? !!row.tombstoned : false;
  }

  async invalidateDepKey(depKey: string, owner?: string): Promise<string[]> {
    // owner undefined → every user_key (route-wide change, today's behavior).
    // owner set → the shared row ('') plus that one user's rows only, so a
    // per-user snapshot fan-out doesn't invalidate on another user's write.
    const [rows, listRoutes] = await Promise.all([
      owner === undefined
        ? this.sql`
            UPDATE kiln_fsr
            SET stale = TRUE, version = version + 1
            WHERE ${depKey} = ANY(depends_on)
              AND slot != ''
            RETURNING route
          `
        : this.sql`
            UPDATE kiln_fsr
            SET stale = TRUE, version = version + 1
            WHERE ${depKey} = ANY(depends_on)
              AND slot != ''
              AND (user_key = '' OR user_key = ${owner})
            RETURNING route
          `,
      this.lists.invalidateDependency(depKey),
    ]);

    const routes = Array.from(new Set([
      ...rows.map((r: any) => String(r.route)),
      ...listRoutes,
    ])).sort();

    if (this.redis) {
      await Promise.all(
        routes.map((route) =>
          this.redis!.publishInvalidate({
            route,
            slots: [],
            deps: [depKey],
          }).catch(() => {})
        )
      );
    }

    return routes;
  }

  async tombstoneDependentRoutes(depKey: string, owner?: string): Promise<string[]> {
    // Owner scoping mirrors invalidateDepKey exactly: undefined → every
    // user_key (a route-wide change), set → the shared row ('') plus that one
    // user's rows. Without it a DELETE of one user's row tombstoned the route
    // for EVERY user — deleting their artifacts and forcing a full re-render
    // apiece over data none of them owned. INSERT/UPDATE were scoped from the
    // start; DELETE was left unscoped when tombstone behaviour was frozen.
    const rows =
      owner === undefined
        ? await this.sql`
            UPDATE kiln_fsr
            SET tombstoned = TRUE, stale = FALSE
            WHERE ${depKey} = ANY(depends_on)
            RETURNING route, slot, html_path as "htmlPath", json_path as "jsonPath"
          `
        : await this.sql`
            UPDATE kiln_fsr
            SET tombstoned = TRUE, stale = FALSE
            WHERE ${depKey} = ANY(depends_on)
              AND (user_key = '' OR user_key = ${owner})
            RETURNING route, slot, html_path as "htmlPath", json_path as "jsonPath"
          `;
    const routes = Array.from(new Set(rows.map((r: any) => String(r.route))));
    const listRoutes = await this.lists.deleteDependentRoutes(depKey, owner);
    const allRoutes = Array.from(new Set([...routes, ...listRoutes])).sort();

    const fs = await import('fs/promises');
    for (const row of rows) {
      if (row.slot === '') {
        if (row.htmlPath) await fs.unlink(row.htmlPath).catch(() => {});
        if (row.jsonPath) await fs.unlink(row.jsonPath).catch(() => {});
      }
    }

    if (this.redis) {
      for (const route of allRoutes) {
        await this.redis.deleteRouteKeys(route).catch(() => {});
      }
    }

    return allRoutes;
  }

  async invalidateRoute(route: string): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr
      SET stale = TRUE, version = version + 1
      WHERE route = ${route} AND slot != ''
    `;

    if (this.redis) {
      await this.redis.publishInvalidate({
        route,
        slots: [],
        deps: []
      }).catch(() => {});
    }
  }

  async fetchStaleSlots(opts?: { activeWindowSecs?: number }): Promise<StaleSlot[]> {
    const activeWindowSecs = opts?.activeWindowSecs;
    let rows: any[];
    if (activeWindowSecs === undefined) {
      rows = await this.sql`
        WITH candidates AS (
          SELECT s.route, s.slot, s.user_key
          FROM kiln_fsr s
          JOIN kiln_fsr r ON s.route = r.route AND r.user_key = s.user_key AND r.slot = ''
          WHERE s.slot != ''
          AND (
            s.stale = TRUE
            OR (
              COALESCE(r.revalidate_secs, 300) > 0
              AND s.last_patched_at +
                (COALESCE(r.revalidate_secs, 300) * interval '1 second') <= NOW()
            )
          )
          AND (s.refresh_claimed_until IS NULL OR s.refresh_claimed_until <= NOW())
          AND (
            COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) = 0
            OR s.last_patched_at IS NULL
            OR s.last_patched_at + (COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) * interval '1 second') <= NOW()
          )
          FOR UPDATE OF s SKIP LOCKED
        )
        UPDATE kiln_fsr s
        SET refresh_claimed_until = NOW() + interval '30 seconds'
        FROM candidates c, kiln_fsr r
        WHERE s.route = c.route AND s.slot = c.slot AND s.user_key = c.user_key
          AND r.route = s.route AND r.user_key = s.user_key AND r.slot = ''
        RETURNING s.route, s.slot, s.user_key as "userKey", s.version, s.query, s.query_params as "queryParams",
                  s.depends_on as "dependsOn", (r.html_path IS NOT NULL) as "promoted",
                  s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
                  r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
      `;
    } else {
      rows = await this.sql`
        WITH candidates AS (
          SELECT s.route, s.slot, s.user_key
          FROM kiln_fsr s
          JOIN kiln_fsr r ON s.route = r.route AND r.user_key = s.user_key AND r.slot = ''
          WHERE s.slot != ''
          AND (
            s.stale = TRUE
            OR (
              COALESCE(r.revalidate_secs, 300) > 0
              AND s.last_patched_at +
                (COALESCE(r.revalidate_secs, 300) * interval '1 second') <= NOW()
            )
          )
          AND (s.refresh_claimed_until IS NULL OR s.refresh_claimed_until <= NOW())
          AND (
            COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) = 0
            OR s.last_patched_at IS NULL
            OR s.last_patched_at + (COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) * interval '1 second') <= NOW()
          )
          AND (
            r.last_active_at IS NOT NULL
            AND r.last_active_at + (${activeWindowSecs} * interval '1 second') >= NOW()
          )
          FOR UPDATE OF s SKIP LOCKED
        )
        UPDATE kiln_fsr s
        SET refresh_claimed_until = NOW() + interval '30 seconds'
        FROM candidates c, kiln_fsr r
        WHERE s.route = c.route AND s.slot = c.slot AND s.user_key = c.user_key
          AND r.route = s.route AND r.user_key = s.user_key AND r.slot = ''
        RETURNING s.route, s.slot, s.user_key as "userKey", s.version, s.query, s.query_params as "queryParams",
                  s.depends_on as "dependsOn", (r.html_path IS NOT NULL) as "promoted",
                  s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
                  r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
      `;
    }

    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      userKey: r.userKey ?? '',
      version: Number(r.version ?? 0),
      query: r.query,
      queryParams: r.queryParams,
      dependsOn: r.dependsOn || [],
      promoted: !!r.promoted,
      debounceSecs: r.debounceSecs,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath,
      columnName: r.columnName,
      patchMode: r.patchMode
    }));
  }

  async getPromotedPaths(route: string, userKey = ''): Promise<{ htmlPath: string | null; jsonPath: string | null } | null> {
    const rows = await this.sql`
      SELECT html_path as "htmlPath", json_path as "jsonPath"
      FROM kiln_fsr
      WHERE route = ${route} AND slot = '' AND user_key = ${userKey} AND html_path IS NOT NULL
    `;
    const row = rows[0] as any;
    return row ? { htmlPath: row.htmlPath, jsonPath: row.jsonPath } : null;
  }

  async setBakedPaths(route: string, htmlPath: string | null, jsonPath: string | null, userKey = ''): Promise<void> {
    // Row may not exist yet for a per-user variant — upsert it.
    await this.sql`
      INSERT INTO kiln_fsr (route, slot, user_key, html_path, json_path, last_requested_at)
      VALUES (${route}, '', ${userKey}, ${htmlPath}, ${jsonPath}, NOW())
      ON CONFLICT (route, user_key, slot) DO UPDATE SET
        html_path = ${htmlPath}, json_path = ${jsonPath}
    `;
  }

  async purgeInactiveRoutes(globalThresholdSecs: number): Promise<EvictedRoute[]> {
    const rows = await this.sql`
      WITH candidates AS (
        SELECT route, user_key
        FROM kiln_fsr
        WHERE slot = ''
          AND NOT tombstoned
          AND COALESCE(last_requested_at, NOW()) <
              NOW() - (COALESCE(purge_after_secs, ${globalThresholdSecs}) * interval '1 second')
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM kiln_fsr f
        USING candidates c
        WHERE f.route = c.route AND f.user_key = c.user_key
        RETURNING f.route, f.user_key as "userKey", f.slot, f.html_path as "htmlPath", f.json_path as "jsonPath"
      )
      SELECT route, "userKey", "htmlPath", "jsonPath"
      FROM deleted
      WHERE slot = ''
    `;
    const routes = rows.map((row: any) => String(row.route));
    for (const route of routes) {
      await this.lists.deleteRoute(route);
    }
    return rows.map((row: any) => ({
      route: String(row.route),
      userKey: String(row.userKey ?? ''),
      htmlPath: row.htmlPath ?? null,
      jsonPath: row.jsonPath ?? null,
    }));
  }

  /**
   * @param expectedVersion the slot's `version` as of when the caller CLAIMED
   * it (`fetchStaleSlots` returns it). `stale` is cleared only if the row
   * still carries that version — an invalidation landing while the requery
   * was in flight bumps it, and that write must not be swallowed.
   *
   * Unlike `upsertSlot`, omitting it clears unconditionally. The asymmetry is
   * deliberate: `upsertSlot` runs on every render of a page with live fields
   * and has no inherent claim that its data is current, so clearing blind
   * there is simply wrong. `markFresh` exists *because* the caller just
   * performed a revalidation — "I refreshed this" is its contract, and a
   * caller that never claimed the slot (a test, a manual freshen) has no
   * version to offer and still means it.
   *
   * `refresh_claimed_until` and `last_patched_at` are updated either way: the
   * claim must be released even when the flag survives, or the slot sits
   * unclaimable for the 30s claim window instead of being re-requeried on the
   * next tick. `last_patched_at` is honest — a patch really was written out,
   * it just turned out to be superseded — and it makes the slot's debounce
   * apply to the retry, so a stream of invalidations can't hot-loop the
   * watcher.
   */
  async markFresh(route: string, slot: string, userKey = '', expectedVersion?: number): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr
      SET stale = CASE
                    WHEN ${expectedVersion ?? null}::int IS NULL
                      OR version = ${expectedVersion ?? null}::int
                    THEN FALSE
                    ELSE stale
                  END,
          version = version + 1, last_patched_at = NOW(),
          refresh_claimed_until = NULL
      WHERE route = ${route} AND slot = ${slot} AND user_key = ${userKey}
    `;
  }

  async fetchSlotsForSnapshot(route: string, slots: string[], userKey = ''): Promise<StaleSlot[]> {
    let rows: any[];
    if (slots.length === 0) {
      rows = await this.sql`
        SELECT s.route, s.slot, s.user_key as "userKey", s.version, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn",
               (r.html_path IS NOT NULL) as "promoted", s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
               r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
        FROM kiln_fsr s
        JOIN kiln_fsr r ON s.route = r.route AND r.user_key = s.user_key AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != '' AND s.user_key = ${userKey}
        ORDER BY s.slot
      `;
    } else {
      rows = await this.sql`
        SELECT s.route, s.slot, s.user_key as "userKey", s.version, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn",
               (r.html_path IS NOT NULL) as "promoted", s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
               r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
        FROM kiln_fsr s
        JOIN kiln_fsr r ON s.route = r.route AND r.user_key = s.user_key AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != '' AND s.user_key = ${userKey} AND s.slot = ANY(ARRAY(SELECT jsonb_array_elements_text(${slots}::jsonb)))
        ORDER BY s.slot
      `;
    }

    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      userKey: r.userKey ?? '',
      version: Number(r.version ?? 0),
      query: r.query,
      queryParams: r.queryParams,
      dependsOn: r.dependsOn || [],
      promoted: !!r.promoted,
      debounceSecs: r.debounceSecs,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath,
      columnName: r.columnName,
      patchMode: r.patchMode
    }));
  }

  async fetchDormantStaleSlot(route: string, userKey = ''): Promise<StaleSlot | null> {
    const rows = await this.sql`
      SELECT s.route, s.slot, s.user_key as "userKey", s.version, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn",
             (r.html_path IS NOT NULL) as "promoted", s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
             r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
      FROM kiln_fsr s
      JOIN kiln_fsr r ON s.route = r.route AND r.user_key = s.user_key AND r.slot = ''
      WHERE s.route = ${route} AND s.slot != '' AND s.user_key = ${userKey} AND s.stale = TRUE
      LIMIT 1
    `;
    const r = rows[0] as any;
    if (!r) return null;
    return {
      route: r.route,
      slot: r.slot,
      userKey: r.userKey ?? '',
      version: Number(r.version ?? 0),
      query: r.query,
      queryParams: r.queryParams,
      dependsOn: r.dependsOn || [],
      promoted: !!r.promoted,
      debounceSecs: r.debounceSecs,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath,
      columnName: r.columnName,
      patchMode: r.patchMode
    };
  }

  async fetchAllForInspect(): Promise<InspectRow[]> {
    const rows = await this.sql`
      SELECT route, slot, user_key as "userKey", depends_on as "dependsOn", stale, version,
             tombstoned, (html_path IS NOT NULL) as "promoted",
             html_path as "htmlPath", json_path as "jsonPath"
      FROM kiln_fsr
      ORDER BY route, user_key, slot
    `;
    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      userKey: r.userKey ?? '',
      dependsOn: r.dependsOn || [],
      stale: !!r.stale,
      version: r.version,
      promoted: !!r.promoted,
      tombstoned: !!r.tombstoned,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath
    }));
  }

  async reExecuteQuery(slot: StaleSlot): Promise<any> {
    if (!slot.query) return null;
    const params = Array.isArray(slot.queryParams) ? slot.queryParams : [];
    // A hung query here blocks FSR revalidation for that slot indefinitely;
    // cap it so one bad query can't stall the watcher. Clear the timer once
    // the race settles — otherwise a won race leaves a live timer dangling
    // for the full timeout (keeping the event loop busy / delaying exit).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rows = await Promise.race([
      this.sql.unsafe(slot.query, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`reExecuteQuery timed out after ${REQUERY_TIMEOUT_MS}ms for slot "${slot.slot}"`)),
          REQUERY_TIMEOUT_MS
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const row = rows[0];
    if (!row) return null;
    const colKey = slot.columnName || slot.slot;
    return row[colKey] !== undefined ? row[colKey] : null;
  }

  async executeLiveListQuery<T>(
    query: (ctx: LiveListQueryContext) => Promise<T[]> | T[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    const rows = await query({ sql: this.sql, signal });
    if (!Array.isArray(rows)) {
      throw new Error('Live.list query must return an array');
    }
    return rows;
  }

  /**
   * Events since the cursor, for crash/disconnect catch-up.
   *
   * `payload` is normalized here rather than at the call site so the watcher
   * never destructures a value whose shape depends on the driver. See
   * `decodeEventPayload` — and note the rationale recorded here on 2026-08-01
   * ("bun's SQL hands jsonb back as a string, so every event was a silent
   * no-op") was **wrong**, and is corrected there. Trigger-emitted payloads
   * are jsonb objects and always decoded correctly; what was actually broken
   * was catch-up never running on a LISTEN reconnect.
   *
   * A payload that cannot be decoded is returned as `null` and left for the
   * caller to report; never `{}`, which would be indistinguishable from a
   * real event carrying no dep key.
   */
  async fetchEventsSince(cursorId: number): Promise<Array<{ id: number, eventType: string, payload: any }>> {
    const rows = await this.sql`
      SELECT id, event_type as "eventType", payload
      FROM kiln_fsr_events
      WHERE id > ${cursorId}
      ORDER BY id ASC
    `;
    return rows.map((r: any) => ({
      id: Number(r.id),
      eventType: r.eventType,
      payload: decodeEventPayload(r.payload),
    }));
  }

  /**
   * The shared catch-up cursor: the highest event id whose invalidations have
   * been applied to `kiln_fsr` by *some* process. Null when no process has ever
   * recorded one.
   *
   * Shared rather than per-process on purpose. Replay writes only to the shared
   * tables (`invalidateDepKey` / `tombstoneDependentRoutes`), so once any
   * instance has applied an event, every instance's view of it is settled — a
   * restarting container should resume from where the fleet got to, not from
   * where its own local disk happened to be.
   */
  async readEventCursor(name = 'events'): Promise<number | null> {
    const rows = await this.sql`
      SELECT event_id as "eventId" FROM kiln_fsr_cursor WHERE name = ${name}
    `;
    const raw = rows[0]?.eventId;
    if (raw === undefined || raw === null) return null;
    // Number(): bun's SQL hands BIGINT back as a string, same as elsewhere in
    // this file. A string cursor would make `lastProcessed > cursor` a
    // lexicographic comparison ('9' > '10') and silently stall the cursor.
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Move the cursor forward. GREATEST, never a plain assignment: instances
   * advance it concurrently and out of order, and a late write from a lagging
   * instance must not drag the fleet's cursor backwards — that would re-replay
   * (harmless) or, worse, interleave with a peer that then skips the window it
   * thought was already covered.
   */
  async writeEventCursor(eventId: number, name = 'events'): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr_cursor (name, event_id) VALUES (${name}, ${eventId})
      ON CONFLICT (name) DO UPDATE
        SET event_id = GREATEST(kiln_fsr_cursor.event_id, EXCLUDED.event_id),
            updated_at = NOW()
    `;
  }

  /** Highest recorded event id, or 0 when the table is empty. Used to adopt a
   * starting point when no cursor exists, instead of replaying all history. */
  async getLatestEventId(): Promise<number> {
    const rows = await this.sql`SELECT COALESCE(MAX(id), 0) AS id FROM kiln_fsr_events`;
    return Number(rows[0]?.id ?? 0);
  }

  async getRoutePatchMode(route: string, userKey = ''): Promise<'json' | 'both' | null> {
    const rows = await this.sql`
      SELECT patch_mode as "patchMode" FROM kiln_fsr WHERE route = ${route} AND slot = '' AND user_key = ${userKey}
    `;
    const row = rows[0] as any;
    return row ? row.patchMode : null;
  }
}
