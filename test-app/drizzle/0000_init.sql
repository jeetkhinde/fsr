-- Create pilcrow_fsr table
CREATE TABLE IF NOT EXISTS pilcrow_fsr (
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
  CONSTRAINT pilcrow_fsr_pkey PRIMARY KEY (route, slot)
);

-- Invalidation function & trigger utility
CREATE OR REPLACE FUNCTION pilcrow_notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'pilcrow_invalidate',
    json_build_object('depKey', TG_ARGV[0], 'id', NEW.id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
