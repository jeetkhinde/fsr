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

-- Invalidation trigger: run `kiln sync-triggers` (after this migration) to
-- install/verify it, per fsr.triggerTables in kiln.config.ts. It uses the
-- shared kiln_emit_event() function (packages/engine/src/schema.ts,
-- installed by FsrStore.initialize() at boot) — no hand-written trigger
-- function needed for a table with a plain `id` primary key.
--
-- Drop the old hand-written trigger/function: CREATE OR REPLACE never
-- removes a function, and a stale trigger sharing kiln sync-triggers'
-- naming convention (<table>_kiln_invalidate) would block it from ever
-- installing the real one — sync-triggers only checks whether a trigger by
-- that name exists, not what function it points to.
DROP TRIGGER IF EXISTS todo_events_kiln_invalidate ON todo_events;
DROP FUNCTION IF EXISTS kiln_notify_change();
