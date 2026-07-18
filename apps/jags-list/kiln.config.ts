import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: Number(process.env.PORT ?? 3200),
  pagesDir: './pages',
  fsr: {
    watcher: 'embedded',
    patchDebounceSecs: 5,
    revalidateSeconds: 300,
    purgeAfterSeconds: 2_592_000,
    purgeSweepSeconds: 3_600,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    postgresUrl:
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist',
  },
});
