import { describe, it, expect } from 'bun:test';
import { buildPageHandler } from './boot.js';
import type { KilnRequest, KilnResponse } from '@kiln/core';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

function makeReq(overrides: Partial<KilnRequest> = {}): KilnRequest {
  return {
    path: '/contacts',
    method: 'GET',
    params: {},
    query: {},
    headers: new Headers({ accept: 'text/html' }),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    prebakeNext: () => {},
    ...overrides
  };
}

function makeRes(): any {
  const res: any = { status: 200, headers: {}, captured: null };
  res.html = (b: string) => {
    res.captured = { type: 'html', body: b };
  };
  res.json = (b: unknown) => {
    res.captured = { type: 'json', body: b };
  };
  res.redirect = (url: string) => {
    res.captured = { type: 'redirect', url };
  };
  res.sse = () => {};
  return res;
}

describe('buildPageHandler', () => {
  it('returns JSON when Accept: application/json', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const pageModule = {
      load: async () => ({ contacts: [{ id: '1', name: 'Alice' }] }),
      default: ({ contacts }: any) => null
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/contacts',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );
    const req = makeReq({
      headers: new Headers({ accept: 'application/json' })
    });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.type).toBe('json');
    expect(res.captured.body).toEqual({
      contacts: [{ id: '1', name: 'Alice' }]
    });
    await fs.rm(tmpDir, { recursive: true });
  });

  it('returns HTML when an enhanced request explicitly accepts text/html', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const layoutPath = path.join(tmpDir, 'layout.mjs');
    await fs.writeFile(layoutPath, 'export default function Layout({ children }) { return children; }');

    try {
      const { createElement } = await import('react');
      const pageModule = {
        load: async () => ({ title: 'Address Book' }),
        default: ({ title }: any) => createElement('h1', null, title)
      };
      const pageMeta = {
        pattern: '/contacts',
        layouts: [layoutPath],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      };
      const layouts = [
        {
          pattern: '/',
          filePath: layoutPath,
          relativePath: '_layout.tsx',
          hasLoad: false
        }
      ];
      const handler = buildPageHandler(pageModule, pageMeta, layouts, {
        cacheDir: tmpDir,
        ttlSecs: 0,
        redis: null
      });
      const req = makeReq({
        headers: new Headers({ accept: 'text/html' }),
        isEnhanced: true,
        layoutsPresent: ['/']
      });
      const res = makeRes();

      await handler(req, res);

      expect(res.captured.type).toBe('html');
      expect(res.captured.body).toContain('Address Book');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns HTML when Accept: text/html with no layouts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const pageModule = {
      load: async () => ({ title: 'Hello' }),
      default: ({ title }: any) => createElement('h1', null, title)
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/about',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );
    const req = makeReq({ path: '/about' });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.type).toBe('html');
    expect(res.captured.body).toContain('Hello');
    expect(res.captured.body).toContain('/_silcrow/silcrow.js');
    expect(res.captured.body).not.toContain('/_kiln/client.js');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('applies generated markers for Live.list output', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const pageModule = {
      load: async () => ({
        todos: Live.list<{
          id: number;
          title: string;
          completed: boolean;
          status: string;
        }>({
          key: (todo: { id: number }) => todo.id,
          dependsOn: 'another_table.col',
          initial: [{ id: 1, title: 'Ship', completed: false, status: 'in_progress' }],
          query: () => []
        })
      }),
      default: ({ todos }: any) =>
        createElement(
          'ul',
          null,
          todos.map((todo: any) =>
            createElement(
              'li',
              { key: todo.id },
              createElement('span', null, todo.title),
              createElement('span', null, todo.status)
            )
          )
        )
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/todos',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );
    const req = makeReq({ path: '/todos' });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.body).toContain('data-kiln-list="todos"');
    expect(res.captured.body).toContain('data-kiln-live="/todos"');
    expect(res.captured.body).toContain('data-kiln-key="1"');
    expect(res.captured.body).toContain('data-kiln-field="status"');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('materializes query-backed Live.list rows without initial and registers rendered snapshots', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const registrations: any[] = [];
    const store = {
      executeLiveListQuery: async (query: any, signal?: AbortSignal) => query({ sql: 'shared-sql', signal })
    };
    const watcher = {
      hasRegisteredRoute: () => false,
      registerLiveList: async (target: any, snapshot: any) => registrations.push({ target, snapshot })
    };
    const pageModule = {
      load: async () => ({
        todos: Live.list<{ id: number; title: string }>({
          key: (todo) => todo.id,
          dependsOn: 'todo_events',
          query: ({ sql }) => {
            expect(sql).toBe('shared-sql');
            return [{ id: 1, title: 'From query' }];
          }
        })
      }),
      default: ({ todos }: any) =>
        createElement(
          'ul',
          null,
          todos.map((todo: any) => createElement('li', { key: todo.id }, createElement('span', null, todo.title)))
        )
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/todos',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
      watcher as any
    );
    const res = makeRes();

    await handler(makeReq({ path: '/todos' }) as any, res);

    expect(res.captured.body).toContain('From query');
    expect(registrations).toHaveLength(1);
    expect(registrations[0].snapshot.rows[0].key).toBe('1');
    expect(registrations[0].snapshot.rows[0].html).toContain('data-kiln-key="1"');
    const rerendered = await registrations[0].target.renderRows([{ id: 2, title: 'Later' }]);
    expect(rerendered.get('2')).toContain('Later');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('bypasses a promoted cache on the first request after watcher restart', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    let title = 'First process';
    const store = {
      executeLiveListQuery: async (query: any) => query({ sql: 'shared-sql' }),
      ensureRouteRow: async () => {},
      incrementHit: async () => 'JustPromoted',
      setBakedPaths: async () => {}
    };
    const makeWatcher = () => {
      let registered = false;
      return {
        hasRegisteredRoute: () => registered,
        registerLiveList: async () => {
          registered = true;
        }
      };
    };
    const pageModule = {
      promoteAfter: 0,
      load: async () => ({
        todos: Live.list<{ id: number; title: string }>({
          key: (todo) => todo.id,
          dependsOn: 'todo_events',
          query: () => [{ id: 1, title }]
        })
      }),
      default: ({ todos }: any) =>
        createElement(
          'ul',
          null,
          todos.map((todo: any) => createElement('li', { key: todo.id }, todo.title))
        )
    };
    const meta = {
      pattern: '/restart',
      layouts: [],
      liveFields: [],
      hasEntries: false,
      filePath: '',
      relativePath: ''
    };
    const first = buildPageHandler(
      pageModule,
      meta,
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
      makeWatcher() as any
    );
    const firstRes = makeRes();
    await first(makeReq({ path: '/restart' }) as any, firstRes);
    expect(firstRes.captured.body).toContain('First process');

    title = 'Second process';
    const restarted = buildPageHandler(
      pageModule,
      meta,
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
      makeWatcher() as any
    );
    const restartedRes = makeRes();
    await restarted(makeReq({ path: '/restart' }) as any, restartedRes);
    expect(restartedRes.captured.body).toContain('Second process');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('rejects Live.list pages when the watcher mode is external', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const pageModule = {
      load: async () => ({
        todos: Live.list({
          key: (todo: any) => todo.id,
          dependsOn: 'todo_events',
          query: () => []
        })
      }),
      default: ({ todos }: any) => createElement('ul', null, todos)
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/external',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      { fsr: { watcher: 'external' } } as any,
      { executeLiveListQuery: async () => [] } as any,
      {} as any
    );

    await expect(handler(makeReq({ path: '/external' }) as any, makeRes())).rejects.toThrow(
      'Live.list requires config.fsr.watcher = "embedded"'
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it('writes scoped HTML and JSON to disk when promoteAfter is set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { KilnCache } = await import('@kiln/engine');

    const pageModule = {
      promoteAfter: 0,
      load: async () => ({ greeting: 'hello', count: 42 }),
      default: ({ greeting, count }: any) =>
        createElement('div', null, `${greeting}-${count}`)
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/bake-test',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );

    const req = makeReq({ path: '/bake-test' });
    const res = makeRes();
    await handler(req as any, res as any);

    // The response should be HTML
    expect(res.captured.type).toBe('html');
    expect(res.captured.body).toContain('hello-42');

    // Scoped HTML must be written to disk
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    const htmlOnDisk = await cache.getHtml('/bake-test');
    expect(htmlOnDisk).not.toBeNull();
    expect(htmlOnDisk).toContain('hello-42');

    // Scoped JSON must be written to disk
    const jsonOnDisk = await cache.getJson('/bake-test') as any;
    expect(jsonOnDisk).not.toBeNull();
    expect(jsonOnDisk.greeting).toBe('hello');
    expect(jsonOnDisk.count).toBe(42);

    await fs.rm(tmpDir, { recursive: true });
  });

  it('does not write baked files to disk when promoteAfter is not set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { KilnCache } = await import('@kiln/engine');

    // No promoteAfter on module
    const pageModule = {
      load: async () => ({ greeting: 'world' }),
      default: ({ greeting }: any) => createElement('p', null, greeting)
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/no-bake',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );

    await handler(makeReq({ path: '/no-bake' }) as any, makeRes());

    // Neither scoped HTML nor JSON should exist on disk
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    expect(await cache.getHtml('/no-bake')).toBeNull();
    expect(await cache.getJson('/no-bake')).toBeNull();

    await fs.rm(tmpDir, { recursive: true });
  });

  it('serves pre-baked scoped HTML from disk on the next request', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { KilnCache } = await import('@kiln/engine');

    // Pre-write a known HTML file to the cache
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    const prebakedHtml = '<html><body><p>pre-baked content</p></body></html>';
    await cache.setHtml('/cached-route', prebakedHtml);

    let loadCallCount = 0;
    const pageModule = {
      promoteAfter: 0,
      load: async () => {
        loadCallCount++;
        return { greeting: 'fresh render' };
      },
      default: ({ greeting }: any) => createElement('p', null, greeting)
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/cached-route',
        layouts: [],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: ''
      },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );

    const res = makeRes();
    await handler(makeReq({ path: '/cached-route' }) as any, res as any);

    // The pre-baked content should be served
    expect(res.captured.type).toBe('html');
    expect(res.captured.body).toContain('pre-baked content');
    // load() should not have been called (cache hit bypasses SSR)
    expect(loadCallCount).toBe(0);

    await fs.rm(tmpDir, { recursive: true });
  });
});
