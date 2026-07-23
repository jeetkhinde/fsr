import { describe, expect, it, spyOn } from 'bun:test';
import { DEFAULT_CONFIG, defineConfig } from './config.js';

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
