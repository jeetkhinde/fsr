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
  } catch {
    return {};
  }
}

export const serverHooks = (hooks: KilnHooks) => (app: Elysia) => {
  if (hooks.onRequest) app.onRequest(hooks.onRequest);
  if (hooks.onError) app.onError(hooks.onError);
  return app;
};
