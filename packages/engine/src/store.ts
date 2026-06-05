import type { LiveListQueryContext } from '@kiln/live';
import { FsrListStore } from './list-store.js';

export type BunSqlClient = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  unsafe(query: string, params?: unknown[]): Promise<any[]>;
};

export type HitStatus = 'Tombstoned' | 'JustPromoted' | 'Normal';

export interface StaleSlot {
  route: string;
  slot: string;
  query: string | null;
  queryParams: any;
  dependsOn: string[];
  promoted: boolean;
  debounceSecs: number | null;
  htmlPath: string | null;
  jsonPath: string | null;
  columnName: string | null;
}

export interface EvictedRoute {
  route: string;
  htmlPath: string | null;
  jsonPath: string | null;
}

export interface InspectRow {
  route: string;
  slot: string;
  dependsOn: string[];
  stale: boolean;
  version: number;
  hitCount: number;
  promoted: boolean;
  htmlPath: string | null;
  jsonPath: string | null;
  lastHit: string | null;
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

  async ensureRouteRow(route: string, promoteAfter?: number): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr (route, slot, promote_after)
      VALUES (${route}, '', ${promoteAfter ?? null})
      ON CONFLICT (route, slot) DO NOTHING
    `;
  }

  async upsertSlot(
    route: string,
    slot: string,
    querySql: string | null,
    queryParams: any,
    dependsOn: string[],
    debounceSecs?: number,
    columnName?: string
  ): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr
        (route, slot, query, query_params, depends_on, debounce_secs, column_name)
      VALUES (
        ${route}, 
        ${slot}, 
        ${querySql}, 
        ${queryParams}::jsonb,
        ARRAY(SELECT jsonb_array_elements_text(${dependsOn}::jsonb))::text[],
        ${debounceSecs ?? null}, 
        ${columnName ?? null}
      )
      ON CONFLICT (route, slot) DO UPDATE SET
        query         = EXCLUDED.query,
        query_params  = EXCLUDED.query_params,
        depends_on    = EXCLUDED.depends_on,
        debounce_secs = EXCLUDED.debounce_secs,
        column_name   = EXCLUDED.column_name
    `;
  }

  async incrementHit(route: string): Promise<HitStatus> {
    const rows = await this.sql`
      UPDATE kiln_fsr
      SET hit_count  = hit_count + 1,
          last_hit   = now(),
          promoted   = CASE
                           WHEN NOT promoted
                                AND promote_after IS NOT NULL
                                AND (hit_count + 1) >= promote_after
                           THEN TRUE
                           ELSE promoted
                       END
      WHERE route = ${route} AND slot = '' AND NOT tombstoned
      RETURNING hit_count as "hitCount", promoted, promote_after as "promoteAfter"
    `;

    const row = rows[0] as any;
    if (!row) {
      const checkRows = await this.sql`
        SELECT tombstoned FROM kiln_fsr WHERE route = ${route} AND slot = '' LIMIT 1
      `;
      const checkRow = checkRows[0] as any;
      if (checkRow && checkRow.tombstoned) {
        return 'Tombstoned';
      }
      return 'Normal';
    }

    const justPromoted = row.promoteAfter !== null && 
      row.promoted && 
      parseInt(row.hitCount, 10) === parseInt(row.promoteAfter, 10);

    return justPromoted ? 'JustPromoted' : 'Normal';
  }

  async tombstone(route: string): Promise<void> {
    const rows = await this.sql`
      UPDATE kiln_fsr
      SET tombstoned = TRUE, promoted = FALSE, stale = FALSE
      WHERE route = ${route}
      RETURNING slot, html_path as "htmlPath", json_path as "jsonPath"
    `;

    if (this.redis) {
      await this.redis.deleteRouteKeys(route).catch(() => {});
    }
    await this.lists.deleteRoute(route);

    const routeRow = rows.find((r) => r.slot === '');
    if (routeRow) {
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
      SELECT tombstoned FROM kiln_fsr WHERE route = ${route} AND slot = ''
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
      for (const route of routes) {
        await this.redis.publishInvalidate({
          route,
          slots: [],
          deps: [depKey]
        }).catch(() => {});
      }
    }

    return routes;
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
      SELECT s.route, s.slot, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn", 
             r.promoted, s.debounce_secs as "debounceSecs", r.html_path as "htmlPath", 
             r.json_path as "jsonPath", s.column_name as "columnName"
      FROM kiln_fsr s
      JOIN kiln_fsr r ON s.route = r.route AND r.slot = ''
      WHERE s.stale = TRUE AND s.slot != ''
        AND (
          COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) = 0
          OR s.last_patched_at IS NULL
          OR s.last_patched_at + (COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) * interval '1 second') <= NOW()
        )
    `;
    
    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      query: r.query,
      queryParams: r.queryParams,
      dependsOn: r.dependsOn || [],
      promoted: !!r.promoted,
      debounceSecs: r.debounceSecs,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath,
      columnName: r.columnName
    }));
  }

  async getPromotedPaths(route: string): Promise<{ htmlPath: string | null; jsonPath: string | null } | null> {
    const rows = await this.sql`
      SELECT html_path as "htmlPath", json_path as "jsonPath"
      FROM kiln_fsr
      WHERE route = ${route} AND slot = '' AND promoted = TRUE
    `;
    const row = rows[0] as any;
    return row ? { htmlPath: row.htmlPath, jsonPath: row.jsonPath } : null;
  }

  async setBakedPaths(route: string, htmlPath: string, jsonPath: string | null): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr
      SET html_path = ${htmlPath}, json_path = ${jsonPath}
      WHERE route = ${route} AND slot = ''
    `;
  }

  async evictIdleRoutes(thresholdSecs: number): Promise<EvictedRoute[]> {
    const rows = await this.sql`
      UPDATE kiln_fsr
      SET promoted = FALSE, hit_count = 0
      WHERE slot = ''
        AND promoted = TRUE
        AND NOT tombstoned
        AND last_hit < now() - (${thresholdSecs} * interval '1 second')
      RETURNING route, html_path as "htmlPath", json_path as "jsonPath"
    `;
    return rows.map((r: any) => ({
      route: r.route,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath
    }));
  }

  async markFresh(route: string, slot: string): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr SET stale = FALSE, version = version + 1, last_patched_at = NOW() WHERE route = ${route} AND slot = ${slot}
    `;
  }

  async fetchSlotsForSnapshot(route: string, slots: string[]): Promise<StaleSlot[]> {
    let rows: any[];
    if (slots.length === 0) {
      rows = await this.sql`
        SELECT s.route, s.slot, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn", 
               r.promoted, s.debounce_secs as "debounceSecs", r.html_path as "htmlPath", 
               r.json_path as "jsonPath", s.column_name as "columnName"
        FROM kiln_fsr s
        JOIN kiln_fsr r ON s.route = r.route AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != ''
        ORDER BY s.slot
      `;
    } else {
      rows = await this.sql`
        SELECT s.route, s.slot, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn", 
               r.promoted, s.debounce_secs as "debounceSecs", r.html_path as "htmlPath", 
               r.json_path as "jsonPath", s.column_name as "columnName"
        FROM kiln_fsr s
        JOIN kiln_fsr r ON s.route = r.route AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != '' AND s.slot = ANY(ARRAY(SELECT jsonb_array_elements_text(${slots}::jsonb)))
        ORDER BY s.slot
      `;
    }

    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      query: r.query,
      queryParams: r.queryParams,
      dependsOn: r.dependsOn || [],
      promoted: !!r.promoted,
      debounceSecs: r.debounceSecs,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath,
      columnName: r.columnName
    }));
  }

  async fetchAllForInspect(): Promise<InspectRow[]> {
    const rows = await this.sql`
      SELECT route, slot, depends_on as "dependsOn", stale, version, hit_count as "hitCount",
             promoted, html_path as "htmlPath", json_path as "jsonPath",
             to_char(last_hit AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS UTC') AS "lastHit"
      FROM kiln_fsr
      ORDER BY route, slot
    `;
    return rows.map((r: any) => ({
      route: r.route,
      slot: r.slot,
      dependsOn: r.dependsOn || [],
      stale: !!r.stale,
      version: r.version,
      hitCount: r.hitCount,
      promoted: !!r.promoted,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath,
      lastHit: r.lastHit
    }));
  }

  async reExecuteQuery(slot: StaleSlot): Promise<any> {
    if (!slot.query) return null;
    const params = Array.isArray(slot.queryParams) ? slot.queryParams : [];
    const rows = await this.sql.unsafe(slot.query, params);
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
}
