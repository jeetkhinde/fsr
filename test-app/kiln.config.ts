import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: 3000,
  pagesDir: './pages',
  apiDir: './api',
  fsr: {
    promoteAfterHits: 1,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    postgresUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres'
  }
});
