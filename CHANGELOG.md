# Changelog

All notable changes to Kiln are tracked here, per package where relevant.
This file starts from the point tracking began — see `git log` for full
history predating it.

## Unreleased

- Fixed a `DEFAULT_CONFIG` mutation bug in `@kiln/core`'s `defineConfig` (the
  deprecated `config.live` → `config.fsr` bridging could corrupt the shared
  default config object for the life of the process).
- Fixed non-atomic Redis `SET` + `EXPIRE` pairs in `@kiln/engine`'s cache
  layer (a crash between the two calls could leave a key without a TTL).
- Added Postgres reconnection with backoff to the FSR `LISTEN/NOTIFY`
  pipeline (`@kiln/engine`'s `db-notify.ts`).
- Implemented real gzip compression in `@kiln/adapter-elysia` (previously a
  no-op despite being wired in by default).
- Various correctness and hardening fixes across `@kiln/core`, `@kiln/engine`,
  `@kiln/routekit`, `@kiln/adapter-elysia`, `@kiln/client`, `@kiln/react`,
  `@kiln/cli`, and `create-kiln` — see commit history for the full list.
