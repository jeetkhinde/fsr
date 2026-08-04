export const KILN_FSR_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS kiln_fsr (
  route TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT '',
  user_key TEXT NOT NULL DEFAULT '',
  query TEXT,
  query_params JSONB,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  stale BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0,
  tombstoned BOOLEAN NOT NULL DEFAULT false,
  debounce_secs INTEGER,
  html_path TEXT,
  json_path TEXT,
  column_name TEXT,
  last_requested_at TIMESTAMP,
  revalidate_secs INTEGER,
  purge_after_secs INTEGER,
  refresh_claimed_until TIMESTAMP,
  last_patched_at TIMESTAMP,
  patch_mode VARCHAR(10) DEFAULT 'json',
  CONSTRAINT kiln_fsr_pkey PRIMARY KEY (route, user_key, slot)
);

CREATE TABLE IF NOT EXISTS kiln_fsr_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Event catch-up cursor. Lives here, next to the events it points into, rather
-- than on each process's local disk: the invalidations catch-up replays are
-- writes to the SHARED kiln_fsr tables, so "how far the stream has been
-- applied" is a property of the database, not of any one container. A local
-- file meant a container with no persistent cache dir adopted the current head
-- on every restart and could never recover a restart-sized gap.
--
-- One row per consumer name ('events' is the only one today) so a second
-- consumer can be added without a schema change. event_id is only ever moved
-- FORWARD — see FsrStore.writeEventCursor.
CREATE TABLE IF NOT EXISTS kiln_fsr_cursor (
  name TEXT PRIMARY KEY,
  event_id BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION kiln_emit_event() RETURNS trigger AS $$
DECLARE
  -- TEXT, not BIGINT: this is an AFTER ... FOR EACH ROW trigger, so anything
  -- raised here aborts the APPLICATION's write, not just the invalidation.
  -- Declaring it BIGINT made a uuid PK fail the cast ("invalid input syntax
  -- for type bigint") and turned every insert into a hard error.
  record_id TEXT;
  event_id BIGINT;
  owner_val TEXT;
BEGIN
  -- Read through to_jsonb rather than NEW.id: a table with no id column at
  -- all (composite/natural key) raises 'record "new" has no field "id"' on
  -- direct field access, while ->> simply yields NULL. A null id costs only
  -- row-level targeting — consumers skip the depKey:id form and the
  -- table-level depKey still invalidates, which is the safe direction.
  IF TG_OP = 'DELETE' THEN
    record_id := to_jsonb(OLD) ->> 'id';
  ELSE
    record_id := to_jsonb(NEW) ->> 'id';
  END IF;

  IF TG_NARGS > 1 THEN
    IF TG_OP = 'DELETE' THEN
      EXECUTE format('SELECT ($1).%I::text', TG_ARGV[1]) INTO owner_val USING OLD;
    ELSE
      EXECUTE format('SELECT ($1).%I::text', TG_ARGV[1]) INTO owner_val USING NEW;
    END IF;
  END IF;

  -- Only include 'owner' when a trigger actually names an owner column —
  -- json_build_object keeps NULL-valued keys rather than omitting them, and
  -- a present-but-null owner would wrongly narrow invalidateDepKey's WHERE
  -- clause to shared rows only for the (common) case of no owner column.
  INSERT INTO kiln_fsr_events (event_type, payload)
  VALUES (
    TG_OP,
    CASE WHEN TG_NARGS > 1
      THEN jsonb_build_object('depKey', TG_ARGV[0], 'id', record_id, 'owner', owner_val)
      ELSE jsonb_build_object('depKey', TG_ARGV[0], 'id', record_id)
    END
  ) RETURNING id INTO event_id;

  PERFORM pg_notify(
    'kiln_invalidate',
    (CASE WHEN TG_NARGS > 1
      THEN json_build_object('depKey', TG_ARGV[0], 'id', record_id, 'op', TG_OP, 'eventId', event_id, 'owner', owner_val)
      ELSE json_build_object('depKey', TG_ARGV[0], 'id', record_id, 'op', TG_OP, 'eventId', event_id)
    END)::text
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
  user_key TEXT NOT NULL DEFAULT '',
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
  PRIMARY KEY (route, user_key, name)
);

ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS last_requested_at TIMESTAMP;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS revalidate_secs INTEGER;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS purge_after_secs INTEGER;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS refresh_claimed_until TIMESTAMP;
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS patch_mode VARCHAR(10) DEFAULT 'json';
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS debounce_secs INTEGER;
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS revalidate_secs INTEGER;
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS refresh_claimed_until TIMESTAMP;

-- Partial index over exactly the rows the backfill below still needs to
-- touch. On a fresh/already-backfilled table this index stays empty, so
-- the UPDATE's WHERE clause — which otherwise re-runs a full sequential
-- scan matching zero rows on every process startup — becomes an
-- essentially free index-scan-of-nothing instead.
CREATE INDEX IF NOT EXISTS idx_kiln_fsr_needs_last_requested_backfill
  ON kiln_fsr (route)
  WHERE last_requested_at IS NULL;

UPDATE kiln_fsr
SET last_requested_at = COALESCE(last_requested_at, NOW())
WHERE last_requested_at IS NULL;

-- ADR-016 (bake classes): hit-count promotion removed. Promoted-ness is now
-- artifact presence (html_path IS NOT NULL); these columns are dead on any
-- database created before the change. incrementHit always wrote last_hit and
-- last_requested_at together, so dropping last_hit loses no recency signal.
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS hit_count;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS promoted;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS promote_after;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS promoted_at;
ALTER TABLE kiln_fsr DROP COLUMN IF EXISTS last_hit;

-- ADR-017 (per-user artifacts): rows gain a user_key dimension; '' = the
-- shared/route-level row, anything else scopes the row to one user's cache.
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS user_key TEXT NOT NULL DEFAULT '';
ALTER TABLE kiln_fsr_lists ADD COLUMN IF NOT EXISTS user_key TEXT NOT NULL DEFAULT '';

-- Plan-2 review #3: the PK swap above used to run unconditionally on every
-- boot (DROP CONSTRAINT + ADD CONSTRAINT), which is wasteful/unsafe to keep
-- unconditional long-term. Guard it: only rebuild the PK when its actual
-- columns don't already match the target shape.
--
-- NOTE: pg_attribute.attnum reflects each column's *physical declaration
-- order in the table* (e.g. kiln_fsr declares route, slot, user_key, ...),
-- which is NOT the same as the order columns appear in the PK constraint
-- (route, user_key, slot). Ordering the comparison by attnum against a
-- differently-ordered target array would never match, making the guard
-- always report "needs migration" and defeating the whole point. Both
-- sides are instead canonicalized alphabetically (by attname) so the
-- comparison is a true order-independent column-set check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_constraint c ON c.conindid = i.indexrelid
    WHERE c.conname = 'kiln_fsr_pkey'
      AND c.conrelid = 'kiln_fsr'::regclass
      AND (SELECT array_agg(attname ORDER BY attname) FROM pg_attribute
           WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey))
          = ARRAY['route','slot','user_key']::name[]
  ) THEN
    ALTER TABLE kiln_fsr DROP CONSTRAINT IF EXISTS kiln_fsr_pkey;
    ALTER TABLE kiln_fsr ADD CONSTRAINT kiln_fsr_pkey PRIMARY KEY (route, user_key, slot);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_constraint c ON c.conindid = i.indexrelid
    WHERE c.conname = 'kiln_fsr_lists_pkey'
      AND c.conrelid = 'kiln_fsr_lists'::regclass
      AND (SELECT array_agg(attname ORDER BY attname) FROM pg_attribute
           WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey))
          = ARRAY['name','route','user_key']::name[]
  ) THEN
    ALTER TABLE kiln_fsr_lists DROP CONSTRAINT IF EXISTS kiln_fsr_lists_pkey;
    ALTER TABLE kiln_fsr_lists ADD CONSTRAINT kiln_fsr_lists_pkey PRIMARY KEY (route, user_key, name);
  END IF;
END $$;

-- ADR-018 (active/dormant freshness tiers): route rows track last activity
-- (SSE subscription or read) so fetchStaleSlots can eagerly revalidate only
-- active routes, leaving dormant stale slots for lazy on-read rebuild.
ALTER TABLE kiln_fsr ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP`;
