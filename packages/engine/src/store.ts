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
  htmlPath: string | null;
  jsonPath: string | null;
}

const REQUERY_TIMEOUT_MS = 10_000;

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

  async upsertSlot(
    route: string,
    slot: string,
    querySql: string | null,
    queryParams: any,
    dependsOn: string[],
    debounceSecs?: number,
    columnName?: string | null,
    userKey = ''
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
        column_name   = EXCLUDED.column_name
    `;
  }

  async touchRoute(route: string, userKey = ''): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr SET last_requested_at = NOW()
      WHERE route = ${route} AND slot = '' AND user_key = ${userKey} AND NOT tombstoned
    `;
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

  async invalidateDepKey(depKey: string): Promise<string[]> {
    const [rows, listRoutes] = await Promise.all([
      this.sql`
        UPDATE kiln_fsr
        SET stale = TRUE, version = version + 1
        WHERE ${depKey} = ANY(depends_on)
          AND slot != ''
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

  async tombstoneDependentRoutes(depKey: string): Promise<string[]> {
    const rows = await this.sql`
      UPDATE kiln_fsr
      SET tombstoned = TRUE, stale = FALSE
      WHERE ${depKey} = ANY(depends_on)
      RETURNING route, slot, html_path as "htmlPath", json_path as "jsonPath"
    `;
    const routes = Array.from(new Set(rows.map((r: any) => String(r.route))));
    const listRoutes = await this.lists.deleteDependentRoutes(depKey);
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

  async fetchStaleSlots(): Promise<StaleSlot[]> {
    const rows = await this.sql`
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
      RETURNING s.route, s.slot, s.user_key as "userKey", s.query, s.query_params as "queryParams",
                s.depends_on as "dependsOn", (r.html_path IS NOT NULL) as "promoted",
                s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
                r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
    `;
    
    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      userKey: r.userKey ?? '',
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
        RETURNING f.route, f.slot, f.html_path as "htmlPath", f.json_path as "jsonPath"
      )
      SELECT route, "htmlPath", "jsonPath"
      FROM deleted
      WHERE slot = ''
    `;
    const routes = rows.map((row: any) => String(row.route));
    for (const route of routes) {
      await this.lists.deleteRoute(route);
    }
    return rows.map((row: any) => ({
      route: String(row.route),
      htmlPath: row.htmlPath ?? null,
      jsonPath: row.jsonPath ?? null,
    }));
  }

  async markFresh(route: string, slot: string, userKey = ''): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr
      SET stale = FALSE, version = version + 1, last_patched_at = NOW(),
          refresh_claimed_until = NULL
      WHERE route = ${route} AND slot = ${slot} AND user_key = ${userKey}
    `;
  }

  async fetchSlotsForSnapshot(route: string, slots: string[], userKey = ''): Promise<StaleSlot[]> {
    let rows: any[];
    if (slots.length === 0) {
      rows = await this.sql`
        SELECT s.route, s.slot, s.user_key as "userKey", s.query, s.query_params as "queryParams", s.depends_on as "dependsOn",
               (r.html_path IS NOT NULL) as "promoted", s.debounce_secs as "debounceSecs", r.html_path as "htmlPath",
               r.json_path as "jsonPath", s.column_name as "columnName", r.patch_mode as "patchMode"
        FROM kiln_fsr s
        JOIN kiln_fsr r ON s.route = r.route AND r.user_key = s.user_key AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != '' AND s.user_key = ${userKey}
        ORDER BY s.slot
      `;
    } else {
      rows = await this.sql`
        SELECT s.route, s.slot, s.user_key as "userKey", s.query, s.query_params as "queryParams", s.depends_on as "dependsOn",
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

  async fetchAllForInspect(): Promise<InspectRow[]> {
    const rows = await this.sql`
      SELECT route, slot, user_key as "userKey", depends_on as "dependsOn", stale, version,
             (html_path IS NOT NULL) as "promoted", html_path as "htmlPath", json_path as "jsonPath"
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
      payload: r.payload,
    }));
  }

  async getRoutePatchMode(route: string): Promise<'json' | 'both' | null> {
    const rows = await this.sql`
      SELECT patch_mode as "patchMode" FROM kiln_fsr WHERE route = ${route} AND slot = ''
    `;
    const row = rows[0] as any;
    return row ? row.patchMode : null;
  }
}
