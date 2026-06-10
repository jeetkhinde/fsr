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
  last_requested_at TIMESTAMP,
  promoted_at TIMESTAMP,
  revalidate_secs INTEGER,
  purge_after_secs INTEGER,
  refresh_claimed_until TIMESTAMP,
  last_patched_at TIMESTAMP,
  CONSTRAINT kiln_fsr_pkey PRIMARY KEY (route, slot)
);

CREATE TABLE IF NOT EXISTS kiln_fsr_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION kiln_emit_event() RETURNS trigger AS $$
DECLARE
  record_id BIGINT;
  event_id BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    record_id := OLD.id;
  ELSE
    record_id := NEW.id;
  END IF;

  INSERT INTO kiln_fsr_events (event_type, payload)
  VALUES (
    TG_OP, 
    jsonb_build_object('depKey', TG_ARGV[0], 'id', record_id)
  ) RETURNING id INTO event_id;
  
  PERFORM pg_notify(
    'kiln_invalidate',
    json_build_object('depKey', TG_ARGV[0], 'id', record_id, 'op', TG_OP, 'eventId', event_id)::text
  );
  
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS kiln_fsr_lists (
  route TEXT NOT NULL,
  name TEXT NOT NULL,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  rows JSONB NOT NULL DEFAULT '[]',
  stale BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0,
  debounce_secs INTEGER,
  revalidate_secs INTEGER,
  html_path TEXT,
  json_path TEXT,
  refresh_claimed_until TIMESTAMP,
  last_patched_at TIMESTAMP,
  PRIMARY KEY (route, name)
);

ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS last_requested_at TIMESTAMP;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMP;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS revalidate_secs INTEGER;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS purge_after_secs INTEGER;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS refresh_claimed_until TIMESTAMP;
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS debounce_secs INTEGER;
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS revalidate_secs INTEGER;
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS refresh_claimed_until TIMESTAMP;
UPDATE kiln_fsr
SET last_requested_at = COALESCE(last_requested_at, last_hit, NOW())
WHERE last_requested_at IS NULL`;
