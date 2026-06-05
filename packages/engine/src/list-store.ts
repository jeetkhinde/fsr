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
}

export interface UpsertLiveListSnapshot<T = unknown> {
  route: string;
  name: string;
  dependsOn: string[];
  rows: LiveListSnapshotRow<T>[];
  htmlPath?: string | null;
  jsonPath?: string | null;
}

export class FsrListStore {
  constructor(private sql: BunSqlClient) {}

  setSql(sql: BunSqlClient): void {
    this.sql = sql;
  }

  async upsertSnapshot(input: UpsertLiveListSnapshot): Promise<void> {
    await this.sql`
      INSERT INTO kiln_fsr_lists
        (route, name, depends_on, rows, stale, html_path, json_path, last_patched_at)
      VALUES (
        ${input.route},
        ${input.name},
        ARRAY(SELECT jsonb_array_elements_text(${input.dependsOn}::jsonb))::text[],
        ${input.rows}::jsonb,
        FALSE,
        ${input.htmlPath ?? null},
        ${input.jsonPath ?? null},
        NOW()
      )
      ON CONFLICT (route, name) DO UPDATE SET
        depends_on = EXCLUDED.depends_on,
        rows = EXCLUDED.rows,
        stale = FALSE,
        html_path = COALESCE(EXCLUDED.html_path, kiln_fsr_lists.html_path),
        json_path = COALESCE(EXCLUDED.json_path, kiln_fsr_lists.json_path),
        last_patched_at = NOW()
    `;
  }

  async getSnapshot(route: string, name: string): Promise<LiveListSnapshot | null> {
    const rows = await this.sql`
      SELECT route, name, depends_on as "dependsOn", rows, stale, version,
             html_path as "htmlPath", json_path as "jsonPath",
             last_patched_at as "lastPatchedAt"
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

  async fetchStaleLists(): Promise<LiveListSnapshot[]> {
    const rows = await this.sql`
      SELECT route, name, depends_on as "dependsOn", rows, stale, version,
             html_path as "htmlPath", json_path as "jsonPath",
             last_patched_at as "lastPatchedAt"
      FROM kiln_fsr_lists
      WHERE stale = TRUE
      ORDER BY route, name
    `;
    return rows.map(mapSnapshot);
  }

  async markFresh(route: string, name: string, rows: LiveListSnapshotRow[]): Promise<void> {
    await this.sql`
      UPDATE kiln_fsr_lists
      SET rows = ${rows}::jsonb, stale = FALSE, last_patched_at = NOW()
      WHERE route = ${route} AND name = ${name}
    `;
  }

  async deleteRoute(route: string): Promise<void> {
    await this.sql`
      DELETE FROM kiln_fsr_lists
      WHERE route = ${route}
    `;
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
  };
}

function uniqueSortedRoutes(rows: any[]): string[] {
  return Array.from(new Set(rows.map((row) => String(row.route)))).sort();
}
