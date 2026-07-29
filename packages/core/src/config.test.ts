import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { DEFAULT_CONFIG, defineConfig, loadConfigFromEnv } from './config.js';

describe('loadConfigFromEnv — deployment-critical overrides', () => {
  const touched = [
    'KILN_FSR_POSTGRES_URL',
    'KILN_FSR_REDIS_URL',
    'KILN_FSR_BUILD_ID',
    'KILN_CACHE_URL',
  ];
  afterEach(() => {
    for (const k of touched) delete process.env[k];
  });

  it('overrides fsr.postgresUrl, fsr.redisUrl and fsr.buildId from the environment', () => {
    const base = defineConfig({ fsr: { postgresUrl: 'postgresql://from-file/db' } });
    process.env.KILN_FSR_POSTGRES_URL = 'postgresql://env-host:5432/envdb';
    process.env.KILN_FSR_REDIS_URL = 'redis://env-host:6379/7';
    // buildId is meant to be a per-deploy git SHA (ADR-018) — exactly the
    // thing you want supplied by the environment rather than committed.
    process.env.KILN_FSR_BUILD_ID = 'deadbeef';

    const cfg = loadConfigFromEnv(base);
    expect(cfg.fsr?.postgresUrl).toBe('postgresql://env-host:5432/envdb');
    expect(cfg.fsr?.redisUrl).toBe('redis://env-host:6379/7');
    expect(cfg.fsr?.buildId).toBe('deadbeef');
  });

  it('overrides cache.url from the environment', () => {
    const base = defineConfig({});
    process.env.KILN_CACHE_URL = 'redis://cache-host:6379/2';
    expect(loadConfigFromEnv(base).cache?.url).toBe('redis://cache-host:6379/2');
  });

  it('does not mutate the base config or leak into DEFAULT_CONFIG', () => {
    const base = defineConfig({ fsr: { postgresUrl: 'postgresql://from-file/db' } });
    process.env.KILN_FSR_POSTGRES_URL = 'postgresql://env-host:5432/envdb';
    loadConfigFromEnv(base);
    // The existing function copies web/backend for exactly this reason; the
    // new fsr/cache overrides must not alias their sub-objects either.
    expect(base.fsr?.postgresUrl).toBe('postgresql://from-file/db');
    expect(DEFAULT_CONFIG.fsr?.postgresUrl).not.toBe('postgresql://env-host:5432/envdb');
  });
});

describe('FSR configuration', () => {
  it('uses the canonical baked-shell lifecycle defaults', () => {
    expect(DEFAULT_CONFIG.fsr.patchDebounceSecs).toBe(5);
    expect(DEFAULT_CONFIG.fsr.revalidateSeconds).toBe(300);
    expect(DEFAULT_CONFIG.fsr.purgeAfterSeconds).toBe(2_592_000);
    expect(DEFAULT_CONFIG.fsr.purgeSweepSeconds).toBe(3_600);
  });

  it('maps deprecated live and idle fields to canonical fsr fields', () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const config = defineConfig({
      live: {
        patchDebounceSeconds: 11,
        purgeAfterSeconds: 13,
      },
      fsr: {
        idleEvictSecs: 17,
        idleThresholdSecs: 19,
      },
    });

    expect(config.fsr.patchDebounceSecs).toBe(11);
    expect(config.fsr.purgeAfterSeconds).toBe(19);
    expect(config.fsr.purgeSweepSeconds).toBe(17);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
