#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import consola from 'consola';
import { loadConfig } from 'c12';
import type { PilcrowConfig } from '@fsr/core';
import { ElysiaAdapter } from '@fsr/adapter-elysia';
import { startPilcrow } from '@fsr/routekit';
import { FsrStore, FsrWatcher, RedisCache, startDbNotificationPipeline } from '@fsr/engine';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createServer, build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { pilcrowVitePlugin } from '@fsr/routekit';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve silcrow.js location
async function resolveSilcrowJs(): Promise<string> {
  const possiblePaths = [
    path.resolve(__dirname, '../../../../silcrow/dist/silcrow.js'),
    path.resolve(__dirname, '../../node_modules/silcrow/dist/silcrow.js'),
    path.resolve(process.cwd(), 'node_modules/silcrow/dist/silcrow.js'),
  ];

  for (const p of possiblePaths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  throw new Error('Could not resolve silcrow.js asset path.');
}

const devCommand = defineCommand({
  meta: {
    name: 'dev',
    description: 'Start the application in development mode',
  },
  async run() {
    consola.info('Starting Pilcrow.js dev server...');

    // 1. Load config
    const { config } = await loadConfig<PilcrowConfig>({
      name: 'pilcrow',
      configFile: 'pilcrow.config',
    });

    const port = config.port || 3000;
    const pagesDir = config.pagesDir || './pages';

    // 2. Initialize FSR if connection strings are set
    let fsr;
    let pool: pg.Pool | null = null;
    let redisCache: RedisCache | null = null;
    let watcher: FsrWatcher | null = null;

    if (config.fsr?.postgresUrl) {
      consola.info('Initializing FSR database store...');
      pool = new pg.Pool({ connectionString: config.fsr.postgresUrl });
      const db = drizzle(pool);
      const store = new FsrStore(db);

      if (config.fsr.redisUrl) {
        consola.info('Initializing FSR Redis cache...');
        redisCache = new RedisCache(config.fsr.redisUrl);
      }

      watcher = new FsrWatcher(store, redisCache, {
        pollIntervalMs: 1000,
        promoteAfterHits: config.fsr.promoteAfterHits ?? 1,
        patchDebounceSecs: 0,
        purgeAfterSeconds: 3600,
        scheduledInvalidations: [],
        idleEvictSecs: 1800,
        idleThresholdSecs: 3600,
      });

      await watcher.start();
      await startDbNotificationPipeline(config.fsr.postgresUrl, store, watcher);
      fsr = { store, watcher };
      consola.success('FSR caching & notification supervisors started.');
    }

    // 3. Start Vite dev server in background
    consola.info('Booting Vite assets compiler...');
    const viteServer = await createServer({
      base: '/_pilcrow/client/',
      root: process.cwd(),
      plugins: [
        react(),
        pilcrowVitePlugin({
          pagesDir,
          onRoutesChanged: () => {
            consola.info('Routes changed, reloading manifest...');
          },
        }),
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

    // 4. Start Elysia Server with Adapter
    consola.info('Starting Elysia adapter...');
    const adapter = new ElysiaAdapter({
      elysia: undefined, // Let it auto-create
    });

    // Proxy Vite asset requests
    adapter.app.all('/_pilcrow/client/*', async (ctx) => {
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

    // Register silcrow.js asset
    try {
      const silcrowJsPath = await resolveSilcrowJs();
      adapter.registerAsset('/_silcrow/silcrow.js', silcrowJsPath);
      consola.info('Registered silcrow.js client asset.');
    } catch (err: any) {
      consola.warn(`Warning: ${err.message}. Browser client navigation might fail.`);
    }

    await startPilcrow(adapter, config, pagesDir, fsr);

    await adapter.listen(port, (addr) => {
      consola.success(`Pilcrow.js server listening at ${addr}`);
    });

    // Handle shutdown
    process.on('SIGINT', async () => {
      consola.info('Shutting down dev servers...');
      if (watcher) await watcher.stop();
      if (redisCache) await redisCache.disconnect();
      if (pool) await pool.end();
      await viteServer.close();
      process.exit(0);
    });
  },
});

async function findClientEntries(dir: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(currentDir: string) {
    let files;
    try {
      files = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const file of files) {
      const fullPath = path.join(currentDir, file.name);
      if (file.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(file.name)) continue;
        await walk(fullPath);
      } else if (file.isFile()) {
        const ext = path.extname(file.name);
        if (['.tsx', '.ts', '.jsx', '.js'].includes(ext)) {
          entries.push(fullPath);
        }
      }
    }
  }
  await walk(dir);
  return entries;
}

const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Build the application for production',
  },
  async run() {
    consola.info('Building Pilcrow.js application for production...');
    const { config } = await loadConfig<PilcrowConfig>({
      name: 'pilcrow',
      configFile: 'pilcrow.config',
    });

    const pagesDir = config.pagesDir || './pages';
    const entries = await findClientEntries(path.resolve(process.cwd(), pagesDir));

    // 1. Compile TS modules
    consola.info('Compiling server TypeScript modules...');
    try {
      execSync('npx tsc', { stdio: 'inherit' });
      consola.success('TypeScript compilation completed successfully.');
    } catch (err) {
      consola.error('TypeScript compilation failed.');
      process.exit(1);
    }

    if (entries.length === 0) {
      consola.warn('No client page files found. Skipping client asset build.');
      consola.success('Build completed successfully! Outputs are in dist/');
      return;
    }

    // 2. Compile Vite production assets
    consola.info(`Bundling ${entries.length} client-side React assets...`);
    try {
      await viteBuild({
        base: '/_pilcrow/client/',
        root: process.cwd(),
        plugins: [react()],
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
    name: 'pilcrow',
    version: '0.1.0',
    description: 'Framework CLI for Pilcrow.js',
  },
  subCommands: {
    dev: devCommand,
    build: buildCommand,
  },
});

runMain(mainCommand);
