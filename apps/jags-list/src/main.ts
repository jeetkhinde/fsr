import { fileURLToPath } from 'node:url';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import {
  FsrStore,
  FsrWatcher,
  RedisCache,
  startDbNotificationPipeline,
} from '@kiln/engine';
import { startKiln } from '@kiln/routekit';
import config from '../kiln.config.js';
import { sql } from '../db/client.js';
import { auth } from '../lib/auth.js';

async function main() {
  const adapter = new ElysiaAdapter();
  // better-auth endpoints (sign-in/out, session). NOTE: these are public via
  // the hooks.ts allowlist — Elysia onRequest intercepts every route
  // regardless of registration order (verified 2026-07-14).
  adapter.app.all('/api/auth/*', (ctx: any) => auth.handler(ctx.request));

  // Form-post login/logout. These are raw Elysia routes, NOT Kiln actions,
  // because actions receive only `req` and cannot set Set-Cookie headers
  // (spec §9 gap 3). Public via the hooks.ts allowlist.
  adapter.app.post('/auth/login', async (ctx: any) => {
    const form = await ctx.request.formData();
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    try {
      const res = await auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
      });
      if (!res.ok) {
        return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
      }
      const headers = new Headers({ location: '/' });
      for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
      return new Response(null, { status: 303, headers });
    } catch {
      return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
    }
  });

  adapter.app.post('/auth/logout', async (ctx: any) => {
    const headers = new Headers({ location: '/login' });
    try {
      const res = await auth.api.signOut({
        headers: ctx.request.headers,
        asResponse: true,
      });
      for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
    } catch {
      // no/invalid session — still land on /login
    }
    return new Response(null, { status: 303, headers });
  });
  const store = new FsrStore(sql);
  const fsrConfig = config.fsr;
  const redis = fsrConfig.redisUrl
    ? new RedisCache(fsrConfig.redisUrl).withArtifactTtl(
        fsrConfig.artifactTtlSecs,
      )
    : null;
  if (process.env.NODE_ENV === 'production' && (!fsrConfig.postgresUrl || !redis)) {
    throw new Error("Jag's List production requires reachable PostgreSQL and Redis");
  }
  await store.initialize();
  if (redis) await redis.getClient().send('PING', []);
  const watcher = new FsrWatcher(store, redis, {
    pollIntervalMs: fsrConfig.pollIntervalMs,
    promoteAfterHits: fsrConfig.promoteAfterHits,
    patchDebounceSecs: fsrConfig.patchDebounceSecs,
    purgeAfterSeconds: fsrConfig.purgeAfterSeconds,
    purgeSweepSeconds: fsrConfig.purgeSweepSeconds,
    revalidateSeconds: fsrConfig.revalidateSeconds,
    scheduledInvalidations: [],
  });

  await watcher.start();
  await startDbNotificationPipeline(fsrConfig.postgresUrl!, store, watcher);

  adapter.registerAsset(
    '/assets/app.css',
    fileURLToPath(new URL('../styles/app.css', import.meta.url)),
  );

  await startKiln(adapter, config, './pages', {
    fsr: true,
    store,
    watcher,
    redis: redis ?? undefined,
  });
  await adapter.listen(config.port ?? 3200, (address) => {
    console.log(`Jag's List running at ${address}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
