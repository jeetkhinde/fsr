import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

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
  private pool: any = null;

  constructor(
    private db: NodePgDatabase<any>,
    private globalDebounceSecs = 0,
    private redis: any = null
  ) {}

  withPool(pool: any): this {
    this.pool = pool;
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
    await this.db.execute(sql`
      INSERT INTO pilcrow_fsr (route, slot, promote_after)
      VALUES (${route}, '', ${promoteAfter ?? null})
      ON CONFLICT (route, slot) DO NOTHING
    `);
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
    await this.db.execute(sql`
      INSERT INTO pilcrow_fsr
        (route, slot, query, query_params, depends_on, debounce_secs, column_name)
      VALUES (
        ${route}, 
        ${slot}, 
        ${querySql}, 
        ${JSON.stringify(queryParams)}, 
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(dependsOn)}::jsonb))::text[], 
        ${debounceSecs ?? null}, 
        ${columnName ?? null}
      )
      ON CONFLICT (route, slot) DO UPDATE SET
        query         = EXCLUDED.query,
        query_params  = EXCLUDED.query_params,
        depends_on    = EXCLUDED.depends_on,
        debounce_secs = EXCLUDED.debounce_secs,
        column_name   = EXCLUDED.column_name
    `);
  }

  async incrementHit(route: string): Promise<HitStatus> {
    const res = await this.db.execute(sql`
      UPDATE pilcrow_fsr
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
    `);

    const row = res.rows[0] as any;
    if (!row) {
      const checkRes = await this.db.execute(sql`
        SELECT tombstoned FROM pilcrow_fsr WHERE route = ${route} AND slot = '' LIMIT 1
      `);
      const checkRow = checkRes.rows[0] as any;
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
    const res = await this.db.execute(sql`
      UPDATE pilcrow_fsr
      SET tombstoned = TRUE, promoted = FALSE, stale = FALSE
      WHERE route = ${route}
      RETURNING slot, html_path as "htmlPath", json_path as "jsonPath"
    `);

    if (this.redis) {
      await this.redis.deleteRouteKeys(route).catch(() => {});
    }

    const rows = res.rows as any[];
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
    const res = await this.db.execute(sql`
      SELECT tombstoned FROM pilcrow_fsr WHERE route = ${route} AND slot = ''
    `);
    const row = res.rows[0] as any;
    return row ? !!row.tombstoned : false;
  }

  async invalidateDepKey(depKey: string): Promise<string[]> {
    const res = await this.db.execute(sql`
      UPDATE pilcrow_fsr
      SET stale = TRUE, version = version + 1
      WHERE ${depKey} = ANY(depends_on)
        AND slot != ''
      RETURNING route
    `);

    const routes = Array.from(new Set(res.rows.map((r: any) => r.route))) as string[];
    routes.sort();

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
    await this.db.execute(sql`
      UPDATE pilcrow_fsr
      SET stale = TRUE, version = version + 1
      WHERE route = ${route} AND slot != ''
    `);

    if (this.redis) {
      await this.redis.publishInvalidate({
        route,
        slots: [],
        deps: []
      }).catch(() => {});
    }
  }

  async fetchStaleSlots(): Promise<StaleSlot[]> {
    const res = await this.db.execute(sql`
      SELECT s.route, s.slot, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn", 
             r.promoted, s.debounce_secs as "debounceSecs", r.html_path as "htmlPath", 
             r.json_path as "jsonPath", s.column_name as "columnName"
      FROM pilcrow_fsr s
      JOIN pilcrow_fsr r ON s.route = r.route AND r.slot = ''
      WHERE s.stale = TRUE AND s.slot != ''
        AND (
          COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) = 0
          OR s.last_patched_at IS NULL
          OR s.last_patched_at + (COALESCE(s.debounce_secs, ${this.globalDebounceSecs}) * interval '1 second') <= NOW()
        )
    `);
    
    return res.rows.map((r: any) => ({
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
    const res = await this.db.execute(sql`
      SELECT html_path as "htmlPath", json_path as "jsonPath"
      FROM pilcrow_fsr
      WHERE route = ${route} AND slot = '' AND promoted = TRUE
    `);
    const row = res.rows[0] as any;
    return row ? { htmlPath: row.htmlPath, jsonPath: row.jsonPath } : null;
  }

  async setBakedPaths(route: string, htmlPath: string, jsonPath: string | null): Promise<void> {
    await this.db.execute(sql`
      UPDATE pilcrow_fsr
      SET html_path = ${htmlPath}, json_path = ${jsonPath}
      WHERE route = ${route} AND slot = ''
    `);
  }

  async evictIdleRoutes(thresholdSecs: number): Promise<EvictedRoute[]> {
    const res = await this.db.execute(sql`
      UPDATE pilcrow_fsr
      SET promoted = FALSE, hit_count = 0
      WHERE slot = ''
        AND promoted = TRUE
        AND NOT tombstoned
        AND last_hit < now() - (${thresholdSecs} * interval '1 second')
      RETURNING route, html_path as "htmlPath", json_path as "jsonPath"
    `);
    return res.rows.map((r: any) => ({
      route: r.route,
      htmlPath: r.htmlPath,
      jsonPath: r.jsonPath
    }));
  }

  async markFresh(route: string, slot: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE pilcrow_fsr SET stale = FALSE, version = version + 1, last_patched_at = NOW() WHERE route = ${route} AND slot = ${slot}
    `);
  }

  async fetchSlotsForSnapshot(route: string, slots: string[]): Promise<StaleSlot[]> {
    let res;
    if (slots.length === 0) {
      res = await this.db.execute(sql`
        SELECT s.route, s.slot, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn", 
               r.promoted, s.debounce_secs as "debounceSecs", r.html_path as "htmlPath", 
               r.json_path as "jsonPath", s.column_name as "columnName"
        FROM pilcrow_fsr s
        JOIN pilcrow_fsr r ON s.route = r.route AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != ''
        ORDER BY s.slot
      `);
    } else {
      res = await this.db.execute(sql`
        SELECT s.route, s.slot, s.query, s.query_params as "queryParams", s.depends_on as "dependsOn", 
               r.promoted, s.debounce_secs as "debounceSecs", r.html_path as "htmlPath", 
               r.json_path as "jsonPath", s.column_name as "columnName"
        FROM pilcrow_fsr s
        JOIN pilcrow_fsr r ON s.route = r.route AND r.slot = ''
        WHERE s.route = ${route} AND s.slot != '' AND s.slot = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(slots)}::jsonb)))
        ORDER BY s.slot
      `);
    }

    return res.rows.map((r: any) => ({
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
    const res = await this.db.execute(sql`
      SELECT route, slot, depends_on as "dependsOn", stale, version, hit_count as "hitCount",
             promoted, html_path as "htmlPath", json_path as "jsonPath",
             to_char(last_hit AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS UTC') AS "lastHit"
      FROM pilcrow_fsr
      ORDER BY route, slot
    `);
    return res.rows.map((r: any) => ({
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
    const client = this.pool ?? (this.db as any).$client ?? (this.db as any).session?.client;
    if (!client) throw new Error('FsrStore: no pg pool — call .withPool(pool) after construction');
    const params = Array.isArray(slot.queryParams) ? slot.queryParams : [];
    const res = await client.query(slot.query, params);
    const row = res.rows[0];
    if (!row) return null;
    const colKey = slot.columnName || slot.slot;
    return row[colKey] !== undefined ? row[colKey] : null;
  }
}
