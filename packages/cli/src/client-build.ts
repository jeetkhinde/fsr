import * as path from 'path';
import { build as viteBuild, type InlineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { kilnIslandsPlugin, listIslands } from '@kiln/routekit';

/**
 * The client entry points a Kiln app has.
 *
 * Islands are the only ones (ADR-014: no page-level hydration). `kiln build`
 * used to also glob every `.ts`/`.tsx` under `pagesDir` into rollup's `input`.
 * Nothing could ever load the resulting chunks — the runtime resolves island
 * names through `/_kiln/islands.json` and has no notion of a page bundle — so
 * that output was dead weight at best. At worst it broke the build outright:
 * a page module is server code, and the moment one reached a server-only
 * import (`@kiln/core/sql` pulls in `node:async_hooks`) rollup failed on a
 * browser-externalized builtin. Every real app trips this; only apps whose
 * pages import nothing server-side ever built.
 */
export function listClientEntries(appRoot: string): string[] {
  return listIslands(path.join(appRoot, 'islands'));
}

/**
 * The Vite config `kiln build` runs. Deliberately passes NO
 * `rollupOptions.input`: `kilnIslandsPlugin` fills it with one virtual entry
 * per island in its own `config()` hook, which is the single place entries
 * are decided.
 */
export function clientBuildConfig(appRoot: string): InlineConfig {
  return {
    base: '/_kiln/client/',
    root: appRoot,
    plugins: [react(), kilnIslandsPlugin({ appRoot })],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
  };
}

/**
 * Bundle the app's islands. Returns the island names built, or `null` when
 * the app has none and the client build was skipped.
 */
export async function buildClientAssets(appRoot: string): Promise<string[] | null> {
  const islands = listClientEntries(appRoot);
  if (islands.length === 0) return null;
  await viteBuild(clientBuildConfig(appRoot));
  return islands;
}
