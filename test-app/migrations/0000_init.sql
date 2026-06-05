-- Create kiln_fsr table
CREATE TABLE IF NOT EXISTS kiln_fsr (
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
);

CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS todo_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO todos (title, completed)
SELECT seed.title, seed.completed
FROM (VALUES
  ('Ship Live.list', false),
  ('Verify watcher patches', false)
) AS seed(title, completed)
WHERE NOT EXISTS (SELECT 1 FROM todos);

-- Invalidation function & trigger utility
CREATE OR REPLACE FUNCTION kiln_notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'kiln_invalidate',
    json_build_object('depKey', TG_ARGV[0], 'id', NEW.id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS todo_events_kiln_invalidate ON todo_events;
CREATE TRIGGER todo_events_kiln_invalidate
AFTER INSERT ON todo_events
FOR EACH ROW EXECUTE FUNCTION kiln_notify_change('todo_events');
