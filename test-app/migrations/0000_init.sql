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
