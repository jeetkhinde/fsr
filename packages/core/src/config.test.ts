import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { DEFAULT_CONFIG, defineConfig, loadConfigFromEnv } from './config.js';

describe('defineConfig — value validation', () => {
  // TS catches typo'd KEYS, but nothing caught out-of-range VALUES; they
  // surfaced as obscure runtime failures. JS-authored configs have no safety
  // net at all, which is the case this exists for.
  it('rejects an out-of-range image quality', () => {
    expect(() => defineConfig({ images: { quality: 150 } } as any)).toThrow(/quality/i);
    expect(() => defineConfig({ images: { quality: 0 } } as any)).toThrow(/quality/i);
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => defineConfig({ port: 'nope' } as any)).toThrow(/port/i);
    expect(() => defineConfig({ port: 70000 } as any)).toThrow(/port/i);
  });

  it('rejects a negative fsr duration', () => {
    expect(() => defineConfig({ fsr: { patchDebounceSecs: -1 } } as any)).toThrow(
      /patchDebounceSecs/i,
    );
  });

  it('names the offending key and the received value', () => {
    expect(() => defineConfig({ images: { quality: 150 } } as any)).toThrow(/150/);
  });

  it('accepts every config the repo actually uses', () => {
    expect(() => defineConfig({})).not.toThrow();
    expect(() =>
      defineConfig({
        port: 3200,
        images: { quality: 75, formats: ['webp', 'jpeg'] },
        fsr: { patchDebounceSecs: 5, revalidateSeconds: 300, purgeAfterSeconds: 2_592_000 },
      } as any),
    ).not.toThrow();
  });
});

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

  // The deprecated surface (config.live, fsr.idleEvictSecs,
  // fsr.idleThresholdSecs) was removed — it had warned on use since ADR-era
  // config consolidation. The canonical fields are now the only way in.
  it('accepts the canonical fsr duration fields', () => {
    const config = defineConfig({
      fsr: {
        patchDebounceSecs: 11,
        purgeSweepSeconds: 17,
        purgeAfterSeconds: 19,
      },
    });

    expect(config.fsr.patchDebounceSecs).toBe(11);
    expect(config.fsr.purgeSweepSeconds).toBe(17);
    expect(config.fsr.purgeAfterSeconds).toBe(19);
  });

  it('ignores the removed deprecated keys instead of mapping them', () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    // A stale JS config may still pass these. They must not silently override
    // the canonical values any more — and must not throw either.
    const config = defineConfig({
      fsr: { idleEvictSecs: 17, idleThresholdSecs: 19 },
      live: { patchDebounceSeconds: 11 },
    } as any);

    expect(config.fsr.purgeSweepSeconds).toBe(DEFAULT_CONFIG.fsr.purgeSweepSeconds);
    expect(config.fsr.purgeAfterSeconds).toBe(DEFAULT_CONFIG.fsr.purgeAfterSeconds);
    expect(config.fsr.patchDebounceSecs).toBe(DEFAULT_CONFIG.fsr.patchDebounceSecs);
    expect((config as any).live).toBeUndefined();
    warning.mockRestore();
  });
});
