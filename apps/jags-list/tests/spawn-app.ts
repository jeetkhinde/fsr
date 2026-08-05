import { fileURLToPath } from 'node:url';

/**
 * How the integration suites boot the app.
 *
 * They used to spawn `bun src/main.ts` — a hand-built entry point that
 * duplicated the CLI's FSR wiring and drifted from it (it had to re-add
 * `pollIntervalMs ?? 1000` by hand after that default reached setTimeout as
 * NaN). Since ADR-020 the app's only non-page route lives in
 * `kiln.config.ts`'s `server.setup`, so the suites boot it exactly the way a
 * deploy does. A break in CLI boot now fails the app's own tests.
 *
 * `start`, not `dev`: `kiln dev` binds Vite to port 5173 with `strictPort`,
 * so two suites running back-to-back would collide on it. Island chunks are
 * read from `dist/client` in this mode, which is what a deploy serves too.
 */
export const CLI = fileURLToPath(
  new URL('../../../packages/cli/dist/cli.js', import.meta.url),
);

export const SPAWN_APP: string[] = ['bun', CLI, 'start'];
