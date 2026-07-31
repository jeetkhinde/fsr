import { describe, expect, it } from 'bun:test';
import type { KilnConfig, ServerAdapter } from '@kiln/core';
import { runServerSetup } from './server-setup.js';

function fakeAdapter(calls: string[]): ServerAdapter {
  return {
    registerPage: () => {},
    registerAction: () => {},
    registerSSE: () => {},
    registerAsset: (urlPath: string) => calls.push(`asset ${urlPath}`),
    registerRaw: (pattern: string) => calls.push(`raw ${pattern}`),
    applyMiddleware: () => {},
    listen: async () => {},
  };
}

describe('runServerSetup', () => {
  it('hands the app the adapter, the config, and which command is running', async () => {
    const calls: string[] = [];
    let sawMode = '';
    let sawPort: number | undefined;
    const config = {
      port: 3200,
      server: {
        setup({ adapter, config: cfg, mode }: any) {
          sawMode = mode;
          sawPort = cfg.port;
          adapter.registerRaw('/api/auth/*', () => new Response('ok'));
          adapter.registerAsset('/assets/app.css', './styles/app.css');
        },
      },
    } as unknown as KilnConfig;

    await runServerSetup(config, fakeAdapter(calls), 'dev');

    expect(calls).toEqual(['raw /api/auth/*', 'asset /assets/app.css']);
    expect(sawMode).toBe('dev');
    expect(sawPort).toBe(3200);
  });

  it('awaits an async setup, so a route registered after an await is still mounted first', async () => {
    const calls: string[] = [];
    const config = {
      server: {
        async setup({ adapter }: any) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          adapter.registerRaw('/api/auth/*', () => new Response('ok'));
        },
      },
    } as unknown as KilnConfig;

    await runServerSetup(config, fakeAdapter(calls), 'start');

    expect(calls).toEqual(['raw /api/auth/*']);
  });

  it('is a no-op — and logs nothing — for a config without it', async () => {
    const logged: string[] = [];
    await runServerSetup({} as KilnConfig, fakeAdapter([]), 'start', (m) => logged.push(m));
    expect(logged).toEqual([]);
  });

  it('lets a setup failure surface instead of booting a half-wired server', async () => {
    const config = {
      server: {
        setup() {
          throw new Error('auth secret missing');
        },
      },
    } as unknown as KilnConfig;

    await expect(runServerSetup(config, fakeAdapter([]), 'start')).rejects.toThrow(
      'auth secret missing',
    );
  });
});
