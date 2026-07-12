import { Elysia } from 'elysia';
import { pathToFileURL } from 'url';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface KilnHooks {
  onRequest?: (ctx: any) => void | Promise<void>;
  onError?: (ctx: any) => void | Promise<void>;
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

export async function loadHooks(appRoot: string): Promise<KilnHooks> {
  const hooksPath = path.join(appRoot, 'hooks.ts');
  try {
    await fs.access(hooksPath);
  } catch {
    return {};
  }
  try {
    return await import(pathToFileURL(hooksPath).href);
  } catch (err) {
    // hooksPath exists (checked above) but failed to import — a syntax
    // error or a throw at module init, not "no hooks file". Silently
    // treating this the same as "absent" makes a broken hooks.ts
    // indistinguishable from one that was never written.
    console.error(`[kiln] failed to load hooks.ts at "${hooksPath}":`, err instanceof Error ? err.message : err);
    return {};
  }
}

export const serverHooks = (hooks: KilnHooks) => (app: Elysia) => {
  let plugin = new Elysia({ name: 'kiln-server-hooks' });
  if (hooks.onRequest) plugin = plugin.onRequest(hooks.onRequest);
  if (hooks.onError) plugin = plugin.onError(hooks.onError);
  if (hooks.onStart) plugin = plugin.onStart(hooks.onStart);
  if (hooks.onStop) plugin = plugin.onStop(hooks.onStop);
  return app.use(plugin);
};
