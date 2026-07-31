import { describe, expect, it } from 'bun:test';
import { defineConfig } from './config.js';
import type { KilnServerSetupContext } from './config.js';

describe('config.server.setup', () => {
  it('survives defineConfig as a callable function', async () => {
    const seen: string[] = [];
    const config = defineConfig({
      port: 3200,
      server: {
        setup({ adapter, mode }) {
          seen.push(mode);
          adapter.registerAsset('/assets/app.css', './styles/app.css');
        },
      },
    });

    const assets: string[] = [];
    const ctx = {
      adapter: { registerAsset: (urlPath: string) => assets.push(urlPath) },
      config,
      mode: 'start',
    } as unknown as KilnServerSetupContext;
    await config.server!.setup!(ctx);

    expect(seen).toEqual(['start']);
    expect(assets).toEqual(['/assets/app.css']);
  });

  it('is absent unless the app declares it', () => {
    expect(defineConfig({ port: 3000 }).server).toBeUndefined();
  });

  it('rejects a non-function setup at config time, not mid-boot', () => {
    expect(() => defineConfig({ server: { setup: '/api/auth' } as any })).toThrow(
      /server\.setup/,
    );
  });
});
