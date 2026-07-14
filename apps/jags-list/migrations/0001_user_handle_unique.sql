-- Requires better-auth's migration to have created "user" (bun run auth:migrate).
CREATE UNIQUE INDEX IF NOT EXISTS user_handle_unique
  ON "user" (lower(handle))
  WHERE handle IS NOT NULL;
