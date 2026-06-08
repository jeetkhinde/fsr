import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: Number(process.env.PORT ?? 3100),
  pagesDir: './pages',
  fsr: {
    watcher: 'embedded',
    promoteAfterHits: 1,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    postgresUrl:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/postgres',
  },
});
