import { describe, expect, it } from 'bun:test';
import config from '../kiln.config.js';

describe('jags-list scaffold', () => {
  it('loads the kiln config with FSR wiring', () => {
    expect(config.pagesDir).toBe('./pages');
    expect(config.fsr?.redisUrl).toBeTruthy();
    expect(config.fsr?.postgresUrl).toBeTruthy();
  });
});
