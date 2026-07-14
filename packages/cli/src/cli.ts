#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';
import consola from 'consola';
import { loadConfig } from 'c12';
import type { KilnConfig } from '@kiln/core';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import { startKiln } from '@kiln/routekit';
import { FsrStore, FsrWatcher, RedisCache, startDbNotificationPipeline } from '@kiln/engine';
import { SQL } from 'bun';
import { Glob } from 'bun';
import { createServer, build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { kilnVitePlugin, kilnIslandsPlugin, listIslands } from '@kiln/routekit';
import * as path from 'path';

interface FsrRuntime {
  fsr: { fsr: true; store: FsrStore; watcher: FsrWatcher; redis?: RedisCache } | undefined;
  bunSql: SQL | null;
  redisCache: RedisCache | null;
  watcher: FsrWatcher | null;
}

/** Initialize the FSR store/watcher/notification pipeline when Postgres is
 * configured. FSR is optional: without fsr.postgresUrl the app runs as a
 * plain SSR/promotion-less server. Redis needs the store, so redisUrl
 * without postgresUrl is a config error rather than a silent no-op. */
async function initFsr(config: KilnConfig): Promise<FsrRuntime> {
  if (!config.fsr?.postgresUrl) {
    if (config.fsr?.redisUrl) {
      throw new Error(
        'fsr.redisUrl is set but fsr.postgresUrl is not — FSR live features need the PostgreSQL store. ' +
          'Set fsr.postgresUrl, or remove fsr.redisUrl to run without FSR.'
      );
    }
    return { fsr: undefined, bunSql: null, redisCache: null, watcher: null };
  }

  consola.info('Initializing FSR database store...');
  const bunSql = new SQL(config.fsr.postgresUrl);
  const store = new FsrStore(bunSql);
  await store.initialize();

  let redisCache: RedisCache | null = null;
  if (config.fsr.redisUrl) {
    consola.info('Initializing FSR Redis cache...');
    redisCache = new RedisCache(config.fsr.redisUrl, config.cache?.namespace);
    await redisCache.getClient().send('PING', []);
  }

  const watcher = new FsrWatcher(store, redisCache, {
    pollIntervalMs: config.fsr.pollIntervalMs ?? 1000,
    promoteAfterHits: config.fsr.promoteAfterHits,
    patchDebounceSecs: config.fsr.patchDebounceSecs,
    purgeAfterSeconds: config.fsr.purgeAfterSeconds,
    purgeSweepSeconds: config.fsr.purgeSweepSeconds,
    revalidateSeconds: config.fsr.revalidateSeconds,
    cacheDir: config.cache?.dir ?? '.kiln-cache',
    scheduledInvalidations: [],
  });

  await watcher.start();
  await startDbNotificationPipeline(config.fsr.postgresUrl, store, watcher);
  consola.success('FSR caching & notification supervisors started.');

  return {
    fsr: { fsr: true, store, watcher, redis: redisCache ?? undefined },
    bunSql,
    redisCache,
    watcher,
  };
}

async function loadKilnConfig(): Promise<KilnConfig> {
  const { config } = await loadConfig<KilnConfig>({
    name: 'kiln',
    configFile: 'kiln.config',
  });
  return config;
}

function registerShutdown(runtime: FsrRuntime, extra?: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    consola.info(`Received ${signal}, shutting down...`);
    if (runtime.watcher) await runtime.watcher.stop();
    if (runtime.redisCache) await runtime.redisCache.disconnect();
    runtime.bunSql?.close();
    await extra?.();
    process.exit(0);
  };
  // SIGTERM is what container/orchestrator shutdowns (Docker, k8s) send —
  // without a handler for it, they'd kill the process without a graceful
  // watcher/Redis/DB shutdown.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const devCommand = defineCommand({
  meta: {
    name: 'dev',
    description: 'Start the application in development mode',
  },
  args: {
    port: {
      type: 'string',
      description: 'Port to listen on (overrides config)',
      required: false,
    },
  },
  async run({ args }) {
    consola.info('Starting Kiln.js dev server...');

    const config = await loadKilnConfig();
    const port = (args.port ? parseInt(args.port, 10) : undefined) || config.port || config.web?.port || 3000;
    const pagesDir = config.pagesDir || './pages';

    const runtime = await initFsr(config);

    // Start Vite dev server in background
    consola.info('Booting Vite assets compiler...');
    const viteServer = await createServer({
      base: '/_kiln/client/',
      root: process.cwd(),
      plugins: [
        react(),
        kilnVitePlugin({
          pagesDir,
          onRoutesChanged: () => {
            consola.info('Routes changed, reloading manifest...');
          },
        }),
        kilnIslandsPlugin({ appRoot: process.cwd() }),
      ],
      server: {
        port: 5173,
        strictPort: true,
        hmr: {
          port: 5173,
        },
      },
    });
    await viteServer.listen();
    consola.success('Vite compiler listening on http://localhost:5173');

    consola.info('Starting Elysia adapter...');
    const adapter = new ElysiaAdapter();

    // Proxy Vite asset requests
    adapter.app.all('/_kiln/client/*', async (ctx) => {
      const url = new URL(ctx.request.url);
      const target = `http://localhost:5173${url.pathname}${url.search}`;
      try {
        const res = await fetch(target, {
          method: ctx.request.method,
          headers: ctx.request.headers,
          body: ctx.request.body,
        });
        return res;
      } catch (err: any) {
        return new Response(`Vite proxy error: ${err.message}`, { status: 502 });
      }
    });

    await startKiln(adapter, config, pagesDir, {
      ...(runtime.fsr ?? {}),
      // Dev: island names resolve through the Vite dev server's manifest.
      islandsManifestUrl: 'http://localhost:5173/kiln-islands.json',
    });

    await adapter.listen(port, (addr) => {
      consola.success(`Kiln.js dev server listening at ${addr}`);
    }, config.web?.host);

    registerShutdown(runtime, () => viteServer.close());
  },
});

const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the application in production mode (no Vite dev server)',
  },
  args: {
    port: {
      type: 'string',
      description: 'Port to listen on (overrides config)',
      required: false,
    },
  },
  async run({ args }) {
    consola.info('Starting Kiln.js production server...');

    const config = await loadKilnConfig();
    const port = (args.port ? parseInt(args.port, 10) : undefined) || config.port || config.web?.port || 3000;
    const pagesDir = config.pagesDir || './pages';

    if (!config.fsr?.postgresUrl) {
      consola.info('No fsr.postgresUrl configured — running without FSR promotion/live features.');
    }
    const runtime = await initFsr(config);

    const adapter = new ElysiaAdapter({
      bodyLimitBytes: config.web?.requestBodyLimitBytes,
    });

    // Serve the built client assets (island chunks, bundles) that Vite
    // proxies in dev. Hashed filenames are immutable; the islands manifest
    // itself is served no-store by startKiln, so skew resolves there.
    const clientDir = path.resolve(process.cwd(), 'dist/client');
    adapter.app.get('/_kiln/client/*', async (ctx) => {
      const rel = decodeURIComponent(new URL(ctx.request.url).pathname.slice('/_kiln/client/'.length));
      const filePath = path.resolve(clientDir, rel);
      if (filePath !== clientDir && !filePath.startsWith(clientDir + path.sep)) {
        return new Response('Not found', { status: 404 });
      }
      const f = Bun.file(filePath);
      if (!(await f.exists())) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(f, {
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      });
    });

    await startKiln(adapter, config, pagesDir, runtime.fsr);

    await adapter.listen(port, (addr) => {
      consola.success(`Kiln.js server listening at ${addr}`);
    }, config.web?.host);

    registerShutdown(runtime);
  },
});

async function findClientEntries(dir: string): Promise<string[]> {
  const glob = new Glob('**/*.{ts,tsx,js,jsx}');
  const results: string[] = [];
  for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (!file.startsWith('node_modules/') && !file.startsWith('.git/') && !file.startsWith('dist/')) {
      results.push(path.join(dir, file));
    }
  }
  return results;
}

const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Build the application for production',
  },
  async run() {
    consola.info('Building Kiln.js application for production...');
    const config = await loadKilnConfig();

    const pagesDir = config.pagesDir || './pages';
    const entries = await findClientEntries(path.resolve(process.cwd(), pagesDir));
    // kilnIslandsPlugin registers island entries itself (via its own
    // listIslands() scan) independent of `entries` — checking only
    // entries.length below would skip the whole Vite build, and every
    // island with it, for an app with islands but no other client files.
    const hasIslands = listIslands(path.join(process.cwd(), 'islands')).length > 0;

    // 1. Compile TS modules
    consola.info('Compiling server TypeScript modules...');
    const tscProc = Bun.spawn(['bun', 'tsc'], { stdio: ['inherit', 'inherit', 'inherit'] });
    if (await tscProc.exited !== 0) {
      consola.error('TypeScript compilation failed.');
      process.exit(1);
    }
    consola.success('TypeScript compilation completed successfully.');

    if (entries.length === 0 && !hasIslands) {
      consola.warn('No client-side files found. Skipping client asset build.');
      consola.success('Build completed successfully! Outputs are in dist/');
      return;
    }

    // 2. Compile Vite production assets
    consola.info(`Bundling ${entries.length} client-side React assets...`);
    try {
      await viteBuild({
        base: '/_kiln/client/',
        root: process.cwd(),
        plugins: [react(), kilnIslandsPlugin({ appRoot: process.cwd() })],
        build: {
          outDir: 'dist/client',
          emptyOutDir: true,
          rollupOptions: {
            input: entries,
          },
        },
      });
      consola.success('Vite client-side bundles compiled.');
    } catch (err: any) {
      consola.error(`Vite compilation failed: ${err.message}`);
      process.exit(1);
    }

    consola.success('Build completed successfully! Outputs are in dist/');
  },
});

const mainCommand = defineCommand({
  meta: {
    name: 'kiln',
    version: '0.1.0',
    description: 'Framework CLI for Kiln.js',
  },
  subCommands: {
    dev: devCommand,
    start: startCommand,
    build: buildCommand,
  },
});

runMain(mainCommand);
