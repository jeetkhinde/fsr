-- Role model: superadmin > admin > user.
--   superadmin — the first user; immutable (no one may modify/demote/delete it).
--   admin      — may manage admins and users (promote/demote UI lands in Plan 2),
--                but may never touch a superadmin.
--   user       — regular member (renamed from the old 'member').
--
-- This migration is idempotent: re-running it renames any stray 'member',
-- re-promotes the earliest user, and re-asserts the invites CHECK.

-- 1. Rename legacy 'member' role → 'user' on better-auth's user table, and
--    backfill any NULL role to 'user'.
UPDATE "user" SET role = 'user' WHERE role = 'member' OR role IS NULL;

-- 2. Promote the earliest-created account to superadmin (the immutable first
--    user). Only sets it when no superadmin exists yet, so re-runs are stable
--    and a later manual superadmin change is not clobbered.
UPDATE "user" SET role = 'superadmin'
WHERE id = (SELECT id FROM "user" ORDER BY "createdAt" ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'superadmin');

-- 3. Invites may grant 'admin' or 'user' only — never 'superadmin' (that role
--    is reserved for the first user). Drop the old ('admin','member') CHECK
--    FIRST so the rename below isn't rejected by it, then swap default, rename
--    legacy data, and add the new CHECK.
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_role_check;
ALTER TABLE invites ALTER COLUMN role SET DEFAULT 'user';
UPDATE invites SET role = 'user' WHERE role = 'member';
ALTER TABLE invites ADD CONSTRAINT invites_role_check CHECK (role IN ('admin', 'user'));
