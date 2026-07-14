-- Jag's List app schema. better-auth tables ("user", "session", "account",
-- "verification") are managed by `bun run auth:migrate` — user ids here are
-- TEXT with no FK so the two migrations are order-independent.

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS columns (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position DOUBLE PRECISION NOT NULL,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS columns_project_idx ON columns(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id BIGINT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT,
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  due_date DATE,
  position DOUBLE PRECISION NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks(column_id);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS tasks_search_idx ON tasks USING GIN (search);

CREATE TABLE IF NOT EXISTS labels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#8899aa',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE IF NOT EXISTS subtasks (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  position DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subtasks_task_idx ON subtasks(task_id);

CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comments_task_idx ON comments(task_id);

CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL,
  verb TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_project_idx ON activity(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('assigned', 'mentioned', 'commented')),
  task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS invites (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- updated_at touch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jags_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_touch ON projects;
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS columns_touch ON columns;
CREATE TRIGGER columns_touch BEFORE UPDATE ON columns FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS tasks_touch ON tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS labels_touch ON labels;
CREATE TRIGGER labels_touch BEFORE UPDATE ON labels FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS subtasks_touch ON subtasks;
CREATE TRIGGER subtasks_touch BEFORE UPDATE ON subtasks FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS comments_touch ON comments;
CREATE TRIGGER comments_touch BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();
DROP TRIGGER IF EXISTS invites_touch ON invites;
CREATE TRIGGER invites_touch BEFORE UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION jags_touch_updated_at();

-- ---------------------------------------------------------------------------
-- kiln_invalidate notifications. Contract (packages/engine/src/db-notify.ts):
-- payload {"depKey": string, "op": string}; op='DELETE' tombstones dependent
-- routes, anything else invalidates them. Dep-key matching is EXACT, so we
-- emit full key strings. List-scoped keys always use op 'UPDATE'; only
-- entity-page keys (projects:id=, tasks:id=) pass TG_OP through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jags_notify(dep_key TEXT, op TEXT) RETURNS void AS $$
BEGIN
  PERFORM pg_notify('kiln_invalidate', json_build_object('depKey', dep_key, 'op', op)::text);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_projects() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('projects:all', 'UPDATE');
  PERFORM jags_notify('projects:id=' || r.id, TG_OP);
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_columns() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('columns:project_id=' || r.project_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_tasks() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('tasks:project_id=' || r.project_id, 'UPDATE');
  PERFORM jags_notify('tasks:id=' || r.id, TG_OP);
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_subtasks() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('subtasks:task_id=' || r.task_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_comments() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('comments:task_id=' || r.task_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_labels() RETURNS trigger AS $$
BEGIN
  PERFORM jags_notify('labels:all', 'UPDATE');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_task_labels() RETURNS trigger AS $$
DECLARE r RECORD; pid BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT project_id INTO pid FROM tasks WHERE id = r.task_id;
  PERFORM jags_notify('tasks:id=' || r.task_id, 'UPDATE');
  IF pid IS NOT NULL THEN
    PERFORM jags_notify('tasks:project_id=' || pid, 'UPDATE');
  END IF;
  RETURN r;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_activity() RETURNS trigger AS $$
BEGIN
  PERFORM jags_notify('activity:project_id=' || NEW.project_id, 'UPDATE');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION jags_notify_notifications() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM jags_notify('notifications:user_id=' || r.user_id, 'UPDATE');
  RETURN r;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_kiln_invalidate ON projects;
CREATE TRIGGER projects_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION jags_notify_projects();

DROP TRIGGER IF EXISTS columns_kiln_invalidate ON columns;
CREATE TRIGGER columns_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON columns
FOR EACH ROW EXECUTE FUNCTION jags_notify_columns();

DROP TRIGGER IF EXISTS tasks_kiln_invalidate ON tasks;
CREATE TRIGGER tasks_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION jags_notify_tasks();

DROP TRIGGER IF EXISTS subtasks_kiln_invalidate ON subtasks;
CREATE TRIGGER subtasks_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON subtasks
FOR EACH ROW EXECUTE FUNCTION jags_notify_subtasks();

DROP TRIGGER IF EXISTS comments_kiln_invalidate ON comments;
CREATE TRIGGER comments_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON comments
FOR EACH ROW EXECUTE FUNCTION jags_notify_comments();

DROP TRIGGER IF EXISTS labels_kiln_invalidate ON labels;
CREATE TRIGGER labels_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON labels
FOR EACH ROW EXECUTE FUNCTION jags_notify_labels();

DROP TRIGGER IF EXISTS task_labels_kiln_invalidate ON task_labels;
CREATE TRIGGER task_labels_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON task_labels
FOR EACH ROW EXECUTE FUNCTION jags_notify_task_labels();

DROP TRIGGER IF EXISTS activity_kiln_invalidate ON activity;
CREATE TRIGGER activity_kiln_invalidate AFTER INSERT ON activity
FOR EACH ROW EXECUTE FUNCTION jags_notify_activity();

DROP TRIGGER IF EXISTS notifications_kiln_invalidate ON notifications;
CREATE TRIGGER notifications_kiln_invalidate AFTER INSERT OR UPDATE OR DELETE ON notifications
FOR EACH ROW EXECUTE FUNCTION jags_notify_notifications();
