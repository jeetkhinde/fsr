import type { BunSqlClient } from './store.js';

export interface LiveListSnapshotRow<T = unknown> {
  key: string;
  data: T;
  html: string;
}

export interface LiveListSnapshot<T = unknown> {
  route: string;
  name: string;
  dependsOn: string[];
  rows: LiveListSnapshotRow<T>[];
  stale: boolean;
  version: number;
  htmlPath: string | null;
  jsonPath: string | null;
  lastPatchedAt: Date | null;
  debounceSecs: number | null;
  revalidateSecs: number | null;
}

export interface UpsertLiveListSnapshot<T = unknown> {
  route: string;
  name: string;
  dependsOn: string[];
  rows: LiveListSnapshotRow<T>[];
  htmlPath?: string | null;
  jsonPath?: string | null;
  debounceSecs?: number;
  revalidateSecs?: number | false;
}

export class FsrListStore {
  constructor(private sql: BunSqlClient) {}

  setSql(sql: BunSqlClient): void {
    this.sql = sql;
  }

  async upsertSnapshot(input: UpsertLiveListSnapshot): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr_lists
        (route, name, depends_on, rows, stale, debounce_secs, revalidate_secs,
         html_path, json_path, last_patched_at)
      VALUES (
        ${input.route},
        ${input.name},
        ARRAY(SELECT jsonb_array_elements_text(${input.dependsOn}::jsonb))::text[],
        ${input.rows}::jsonb,
        FALSE,
        ${input.debounceSecs ?? null},
        ${input.revalidateSecs === false ? 0 : input.revalidateSecs ?? null},
        ${input.htmlPath ?? null},
        ${input.jsonPath ?? null},
        NOW()
      )
      ON CONFLICT (route, user_key, name) DO UPDATE SET
        depends_on = EXCLUDED.depends_on,
        debounce_secs = EXCLUDED.debounce_secs,
        revalidate_secs = EXCLUDED.revalidate_secs,
        html_path = COALESCE(EXCLUDED.html_path, kiln_fsr_lists.html_path),
        json_path = COALESCE(EXCLUDED.json_path, kiln_fsr_lists.json_path)
    `;
  }

  async getSnapshot(route: string, name: string): Promise<LiveListSnapshot | null> {
    const rows = await this.sql`
      SELECT route, name, depends_on as "dependsOn", rows, stale, version,
             html_path as "htmlPath", json_path as "jsonPath",
             last_patched_at as "lastPatchedAt",
             debounce_secs as "debounceSecs", revalidate_secs as "revalidateSecs"
      FROM kiln_fsr_lists
      WHERE route = ${route} AND name = ${name}
      LIMIT 1
    `;
    return rows[0] ? mapSnapshot(rows[0]) : null;
  }

  async invalidateDependency(depKey: string): Promise<string[]> {
    const rows = await this.sql`
      UPDATE kiln_fsr_lists
      SET stale = TRUE, version = version + 1
      WHERE ${depKey} = ANY(depends_on)
      RETURNING route
    `;
    return uniqueSortedRoutes(rows);
  }

  async fetchStaleLists(defaultRevalidateSecs = 300): Promise<LiveListSnapshot[]> {
    const rows = await this.sql`
      WITH candidates AS (
        SELECT route, name
        FROM kiln_fsr_lists
        WHERE (
          stale = TRUE
          OR (
            COALESCE(revalidate_secs, ${defaultRevalidateSecs}) > 0
            AND last_patched_at +
              (COALESCE(revalidate_secs, ${defaultRevalidateSecs}) * interval '1 second') <= NOW()
          )
        )
        AND (refresh_claimed_until IS NULL OR refresh_claimed_until <= NOW())
        AND (
          COALESCE(debounce_secs, 0) = 0
          OR last_patched_at IS NULL
          OR last_patched_at + (COALESCE(debounce_secs, 0) * interval '1 second') <= NOW()
        )
        ORDER BY route, name
        FOR UPDATE SKIP LOCKED
      )
      UPDATE kiln_fsr_lists l
      SET refresh_claimed_until = NOW() + interval '30 seconds'
      FROM candidates c
      WHERE l.route = c.route AND l.name = c.name
      RETURNING l.route, l.name, l.depends_on as "dependsOn", l.rows,
                l.stale, l.version, l.html_path as "htmlPath",
                l.json_path as "jsonPath", l.last_patched_at as "lastPatchedAt",
                l.debounce_secs as "debounceSecs",
                l.revalidate_secs as "revalidateSecs"
    `;
    return rows.map(mapSnapshot);
  }

  async markFresh(route: string, name: string, rows: LiveListSnapshotRow[]): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr_lists
      SET rows = ${rows}::jsonb, stale = FALSE, last_patched_at = NOW(),
          refresh_claimed_until = NULL
      WHERE route = ${route} AND name = ${name}
    `;
  }

  async deleteRoute(route: string): Promise<void> {
    await this.sql`
      DELETE FROM kiln_fsr_lists
      WHERE route = ${route}
    `;
  }

  async deleteDependentRoutes(depKey: string): Promise<string[]> {
    const rows = await this.sql`
      DELETE FROM kiln_fsr_lists
      WHERE ${depKey} = ANY(depends_on)
      RETURNING route
    `;
    return uniqueSortedRoutes(rows);
  }
}

function mapSnapshot(row: any): LiveListSnapshot {
  return {
    route: row.route,
    name: row.name,
    dependsOn: row.dependsOn ?? [],
    rows: Array.isArray(row.rows) ? row.rows : [],
    stale: Boolean(row.stale),
    version: Number(row.version ?? 0),
    htmlPath: row.htmlPath ?? null,
    jsonPath: row.jsonPath ?? null,
    lastPatchedAt: row.lastPatchedAt ?? null,
    debounceSecs: row.debounceSecs == null ? null : Number(row.debounceSecs),
    revalidateSecs: row.revalidateSecs == null ? null : Number(row.revalidateSecs),
  };
}

function uniqueSortedRoutes(rows: any[]): string[] {
  return Array.from(new Set(rows.map((row) => String(row.route)))).sort();
}
