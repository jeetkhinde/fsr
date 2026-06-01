import { pgTable, text, jsonb, boolean, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const pilcrowFsr = pgTable('pilcrow_fsr', {
  route: text('route').notNull(),
  slot: text('slot').notNull().default(''),
  query: text('query'),
  queryParams: jsonb('query_params'),
  dependsOn: text('depends_on').array().notNull().default([]),
  stale: boolean('stale').notNull().default(false),
  version: integer('version').notNull().default(0),
  hitCount: integer('hit_count').notNull().default(0),
  promoted: boolean('promoted').notNull().default(false),
  tombstoned: boolean('tombstoned').notNull().default(false),
  promoteAfter: integer('promote_after'),
  debounceSecs: integer('debounce_secs'),
  htmlPath: text('html_path'),
  jsonPath: text('json_path'),
  columnName: text('column_name'),
  lastHit: timestamp('last_hit'),
  lastPatchedAt: timestamp('last_patched_at'),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.route, table.slot] }),
  };
});
