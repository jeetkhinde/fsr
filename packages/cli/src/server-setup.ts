import type { KilnConfig, ServerAdapter } from '@kiln/core';

/**
 * Give the app its shot at the adapter before pages are mounted (raw routes,
 * static assets, adapter plugins).
 *
 * Called from both `kiln dev` and `kiln start` so an app that needs one raw
 * route no longer has to abandon the CLI — and with it the Vite/islands
 * pipeline — for a hand-built entry point. Ordering is load-bearing: setup
 * runs BEFORE `startKiln`, so an app route wins over a page at the same path.
 *
 * Lives outside cli.ts because cli.ts calls `runMain` at import time and so
 * cannot be imported by a test.
 */
export async function runServerSetup(
  config: KilnConfig,
  adapter: ServerAdapter,
  mode: 'dev' | 'start',
  log?: (message: string) => void,
): Promise<void> {
  if (!config.server?.setup) return;
  log?.('Running config.server.setup()...');
  await config.server.setup({ adapter, config, mode });
}
