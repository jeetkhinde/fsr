export const KILN_FSR_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS kiln_fsr (
  route TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT '',
  query TEXT,
  query_params JSONB,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  stale BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  promoted BOOLEAN NOT NULL DEFAULT false,
  tombstoned BOOLEAN NOT NULL DEFAULT false,
  promote_after INTEGER,
  debounce_secs INTEGER,
  html_path TEXT,
  json_path TEXT,
  column_name TEXT,
  last_hit TIMESTAMP,
  last_patched_at TIMESTAMP,
  CONSTRAINT kiln_fsr_pkey PRIMARY KEY (route, slot)
);

CREATE TABLE IF NOT EXISTS kiln_fsr_lists (
  route TEXT NOT NULL,
  name TEXT NOT NULL,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  rows JSONB NOT NULL DEFAULT '[]',
  stale BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0,
  html_path TEXT,
  json_path TEXT,
  last_patched_at TIMESTAMP,
  PRIMARY KEY (route, name)
)`;
