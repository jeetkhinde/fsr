import { describe, it, expect } from 'bun:test';
import { buildPageHandler, applyLivePropMarkers, warnDomLiveInsideIslands, startKiln } from './boot.js';
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
  it('promotes on the second successful render and serves later requests without loaders or React', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    let loads = 0;
    let renders = 0;
    let hit = 0;
    const promoted = new Set<string>();
    const store = {
      ensureRouteRow: async () => {},
      incrementHit: async () => {
        hit += 1;
        if (hit === 2) {
          promoted.add('/lifecycle');
          return 'JustPromoted';
        }
        return 'Normal';
      },
      isPromoted: async (route: string) => promoted.has(route),
      setBakedPaths: async () => {},
      touchRoute: async () => {},
    };
    const pageModule = {
      load: async () => ({ title: `render-${++loads}` }),
      default: ({ title }: any) => {
        renders += 1;
        return createElement('h1', { 's-live': 'title' }, title);
      },
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/lifecycle', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );

    const first = makeRes();
    await handler(makeReq({ path: '/lifecycle' }) as any, first);
    expect(await Bun.file(path.join(tmpDir, 'lifecycle', 'index.html')).exists()).toBe(false);

    const second = makeRes();
    await handler(makeReq({ path: '/lifecycle' }) as any, second);
    expect(await Bun.file(path.join(tmpDir, 'lifecycle', 'index.html')).exists()).toBe(true);

    const third = makeRes();
    await handler(makeReq({ path: '/lifecycle' }) as any, third);
    expect(third.captured.body).toContain('render-2');
    expect(loads).toBe(2);
    expect(renders).toBe(2);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('materializes the latest JSON into an immutable promoted shell', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { KilnCache, createBakedSnapshot } = await import('@kiln/engine');
    const cache = new KilnCache({ cacheDir: tmpDir, ttlSecs: 0, redis: null });
    const shell = '<main><h1 s-live="title">Old</h1></main>';
    await cache.setHtml('/fresh', shell);
    await cache.setJson('/fresh', createBakedSnapshot({ title: 'Current' }));
    const handler = buildPageHandler(
      { load: () => { throw new Error('loader must not run'); }, default: () => { throw new Error('React must not run'); } },
      { pattern: '/fresh', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      {
        ensureRouteRow: async () => {},
        incrementHit: async () => 'Normal',
        isPromoted: async () => true,
        touchRoute: async () => {},
      } as any,
    );
    const res = makeRes();
    await handler(makeReq({ path: '/fresh' }) as any, res);
    expect(res.captured.body).toContain('Current');
    expect(await cache.getHtml('/fresh')).toBe(shell);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('returns a page fragment for enhanced navigation when the parent layout is present', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const layoutPath = path.join(tmpDir, '_layout.tsx');
    await Bun.write(layoutPath, `
      export default function Layout({ children }) {
        return children;
      }
    `);
    const { createElement } = await import('react');
    const handler = buildPageHandler(
      { default: () => createElement('h2', null, 'Detail') },
      { pattern: '/contacts/:id', layouts: [layoutPath], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [{ pattern: '/contacts', filePath: layoutPath, relativePath: '_layout.tsx', hasLoad: false }],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
    );
    const res = makeRes();
    await handler(makeReq({
      path: '/contacts/42',
      isEnhanced: true,
      layoutsPresent: ['/contacts'],
      headers: new Headers(),
    }) as any, res);
    expect(res.captured.type).toBe('html');
    expect(res.headers['content-type']).toContain('x-ps-fragment=1');
    expect(res.captured.body).toContain('data-ps-slot="/contacts"');
    expect(res.captured.body).toContain('Detail');
    await fs.rm(tmpDir, { recursive: true });
  });
  it('includes the missing intermediate layout when only the root layout is present (grandchild navigation)', async () => {
    // Chain: root ('/') -> dashboard ('/dashboard') -> page ('/dashboard/:id').
    // The client navigating in for the first time only has the root layout
    // mounted, so the response must include the dashboard layout's own
    // chrome (not just the bare page) — otherwise the dashboard layout would
    // never actually render on the client.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const rootLayoutPath = path.join(tmpDir, 'root_layout.tsx');
    const dashboardLayoutPath = path.join(tmpDir, 'dashboard_layout.tsx');
    await Bun.write(
      rootLayoutPath,
      `export default function RootLayout({ children }) {
        return ["ROOT_MARKER", children];
      }`,
    );
    await Bun.write(
      dashboardLayoutPath,
      `export default function DashboardLayout({ children }) {
        return ["DASHBOARD_MARKER", children];
      }`,
    );
    const { createElement } = await import('react');
    const handler = buildPageHandler(
      { default: () => createElement('h2', null, 'PAGE_MARKER') },
      {
        pattern: '/dashboard/:id',
        layouts: [rootLayoutPath, dashboardLayoutPath],
        liveFields: [],
        hasEntries: false,
        filePath: '',
        relativePath: '',
      },
      [
        { pattern: '/', filePath: rootLayoutPath, relativePath: 'root_layout.tsx', hasLoad: false },
        { pattern: '/dashboard', filePath: dashboardLayoutPath, relativePath: 'dashboard_layout.tsx', hasLoad: false },
      ],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
    );

    // Client only has the root layout mounted (e.g. first navigation from the home page).
    const rootOnlyRes = makeRes();
    await handler(
      makeReq({
        path: '/dashboard/42',
        isEnhanced: true,
        layoutsPresent: ['/'],
        headers: new Headers(),
      }) as any,
      rootOnlyRes,
    );
    expect(rootOnlyRes.headers['content-type']).toContain('x-ps-fragment=1');
    expect(rootOnlyRes.captured.body).toContain('data-ps-slot="/"');
    expect(rootOnlyRes.captured.body).toContain('DASHBOARD_MARKER'); // the missing layout is included
    expect(rootOnlyRes.captured.body).toContain('PAGE_MARKER');
    expect(rootOnlyRes.captured.body).not.toContain('ROOT_MARKER'); // root itself isn't resent

    // Client already has root + dashboard mounted (e.g. switching between sibling pages).
    const bothPresentRes = makeRes();
    await handler(
      makeReq({
        path: '/dashboard/42',
        isEnhanced: true,
        layoutsPresent: ['/', '/dashboard'],
        headers: new Headers(),
      }) as any,
      bothPresentRes,
    );
    expect(bothPresentRes.captured.body).toContain('data-ps-slot="/dashboard"');
    expect(bothPresentRes.captured.body).toContain('PAGE_MARKER');
    expect(bothPresentRes.captured.body).not.toContain('DASHBOARD_MARKER'); // already mounted, not resent
    expect(bothPresentRes.captured.body).not.toContain('ROOT_MARKER');

    await fs.rm(tmpDir, { recursive: true });
  });

  it('bakes a shared layout once and reuses it across sibling routes served by different page handlers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const layoutPath = path.join(tmpDir, 'section_layout.tsx');
    let layoutLoads = 0;
    await Bun.write(
      layoutPath,
      `export async function load() { return { marker: "LAYOUT_BAKED_" + (globalThis.__loadCount = (globalThis.__loadCount||0)+1) }; }
       export default function SectionLayout({ marker, children }) {
         return [marker, children];
       }`,
    );
    // Reset the counter this test relies on (module-level state written to
    // globalThis so the dynamically imported layout file can share it).
    (globalThis as any).__loadCount = 0;

    const { createElement } = await import('react');
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    const layoutNodes = [
      { pattern: '/section', filePath: layoutPath, relativePath: 'section_layout.tsx', hasLoad: true },
    ];

    // Two different pages, both under the same /section layout, each built
    // as its own handler (mirroring how startKiln registers one handler per
    // page route in a real app — they all share the same on-disk cache dir).
    const handlerA = buildPageHandler(
      { default: () => createElement('h2', null, 'PAGE_A') },
      { pattern: '/section/a', layouts: [layoutPath], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      layoutNodes,
      cacheOpts,
    );
    const handlerB = buildPageHandler(
      { default: () => createElement('h2', null, 'PAGE_B') },
      { pattern: '/section/b', layouts: [layoutPath], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      layoutNodes,
      cacheOpts,
    );

    const resA = makeRes();
    await handlerA(makeReq({ path: '/section/a' }) as any, resA);
    const resB = makeRes();
    await handlerB(makeReq({ path: '/section/b' }) as any, resB);

    expect(resA.captured.body).toContain('LAYOUT_BAKED_1');
    expect(resA.captured.body).toContain('PAGE_A');
    // Page B's request reused the /section layout from cache — it must show
    // the SAME baked marker as page A, not a fresh one, and the header
    // recording the cache hit must be set.
    expect(resB.captured.body).toContain('LAYOUT_BAKED_1');
    expect(resB.captured.body).toContain('PAGE_B');
    expect(resB.headers['x-kiln-layout-cache-hit']).toBe('/section');
    expect(resA.headers['x-kiln-layout-cache-hit']).toBeUndefined(); // A did the fresh bake

    await fs.rm(tmpDir, { recursive: true });
  });

  it('re-bakes a layout after its cache entry is explicitly invalidated', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const layoutPath = path.join(tmpDir, 'section2_layout.tsx');
    await Bun.write(
      layoutPath,
      `export async function load() { return { marker: "LAYOUT_BAKED_" + (globalThis.__loadCount2 = (globalThis.__loadCount2||0)+1) }; }
       export default function SectionLayout({ marker, children }) {
         return [marker, children];
       }`,
    );
    (globalThis as any).__loadCount2 = 0;

    const { createElement } = await import('react');
    const { KilnCache } = await import('@kiln/engine');
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    const layoutNodes = [
      { pattern: '/section2', filePath: layoutPath, relativePath: 'section2_layout.tsx', hasLoad: true },
    ];
    const handler = buildPageHandler(
      { default: () => createElement('h2', null, 'PAGE') },
      { pattern: '/section2/x', layouts: [layoutPath], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      layoutNodes,
      cacheOpts,
    );

    const first = makeRes();
    await handler(makeReq({ path: '/section2/x' }) as any, first);
    expect(first.captured.body).toContain('LAYOUT_BAKED_1');

    const second = makeRes();
    await handler(makeReq({ path: '/section2/x' }) as any, second);
    expect(second.captured.body).toContain('LAYOUT_BAKED_1'); // still cached

    // Simulate a deploy that invalidates just this one layout's cache entry.
    const cache = new KilnCache(cacheOpts);
    await cache.deleteLayout('/section2');

    const third = makeRes();
    await handler(makeReq({ path: '/section2/x' }) as any, third);
    expect(third.captured.body).toContain('LAYOUT_BAKED_2'); // re-baked

    await fs.rm(tmpDir, { recursive: true });
  });

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
      executeLiveListQuery: async (query: any, signal?: AbortSignal) => query({ sql: 'shared-sql', signal }),
      setBakedPaths: async () => {}
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

    // The handler catches the error and responds 500 instead of rejecting —
    // an unhandled throw would bypass Kiln's error-page rendering entirely.
    const res = makeRes();
    await handler(makeReq({ path: '/external' }) as any, res);
    expect(res.status).toBe(500);
    expect(res.captured?.type).toBe('html');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('maps AppError thrown from load() to its status instead of a generic 500', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-apperror-'));
    const { createElement } = await import('react');
    const { AppError } = await import('@kiln/core');
    const pageModule = {
      load: async () => {
        throw AppError.notFound('no such contact');
      },
      default: () => createElement('p', null, 'never rendered')
    };
    const handler = buildPageHandler(
      pageModule,
      {
        pattern: '/contacts/:id',
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
    await handler(makeReq({ path: '/contacts/999' }) as any, res);
    expect(res.status).toBe(404);
    expect(res.captured?.type).toBe('html');
    expect(res.captured?.body).toContain('no such contact');

    // JSON clients get a JSON error envelope with the same status.
    const jsonRes = makeRes();
    await handler(
      makeReq({ path: '/contacts/999', headers: new Headers({ accept: 'application/json' }) }) as any,
      jsonRes
    );
    expect(jsonRes.status).toBe(404);
    expect(jsonRes.captured?.type).toBe('json');
    expect(jsonRes.captured?.body).toEqual({ error: 'no such contact', status: 404 });
    await fs.rm(tmpDir, { recursive: true });
  });

  it('marks pages with live fields for SSE subscription (data-kiln-live wrapper)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-live-wrap-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const pageModule = {
      load: async () => ({
        title: 'Stats',
        activeUsers: Live.value<number>(0, ['sessions'], { target: 'store' }),
      }),
      default: ({ title }: any) => createElement('h1', null, title),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/stats', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );

    const res = makeRes();
    await handler(makeReq({ path: '/stats' }) as any, res);
    const html = String(res.captured?.body);
    // silcrow only opens the /__kiln/fsr subscription for [data-kiln-live]
    // containers; store-target fields have no DOM slot, so their names must
    // ride along explicitly.
    expect(html).toContain('data-kiln-live="/stats"');
    expect(html).toContain('data-kiln-live-store="activeUsers"');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('does not mark pages without live fields for SSE subscription', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-live-wrap2-'));
    const { createElement } = await import('react');
    const pageModule = {
      load: async () => ({ title: 'Plain' }),
      default: ({ title }: any) => createElement('h1', null, title),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/plain', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null }
    );

    const res = makeRes();
    await handler(makeReq({ path: '/plain' }) as any, res);
    const html = String(res.captured?.body);
    expect(html).not.toContain('data-kiln-live=');
    expect(html).not.toContain('data-kiln-live-store=');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('serves different cached HTML per cacheKey variant with no cross-contamination', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-variant-'));
    const { createElement } = await import('react');
    let hit = 0;
    const promoted = new Set<string>();
    const store = {
      ensureRouteRow: async () => {},
      incrementHit: async () => {
        hit += 1;
        if (hit === 2) { promoted.add('/dashboard'); return 'JustPromoted'; }
        return 'Normal';
      },
      isPromoted: async (route: string) => promoted.has(route),
      setBakedPaths: async () => {},
      touchRoute: async () => {},
    };

    const module = {
      cacheKey: (req: any) => req.headers.get('x-user-id') ?? 'anon',
      promote_after: 2,
      load: async (req: any) => ({ user: req.headers.get('x-user-id') ?? 'anon' }),
      default: ({ user }: { user: string }) => createElement('div', null, `Hello ${user}`),
    };

    const handler = buildPageHandler(
      module,
      { pattern: '/dashboard', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );

    const makeVariantReq = (userId: string) =>
      makeReq({ path: '/dashboard', headers: new Headers({ accept: 'text/html', 'x-user-id': userId }) });

    // Alice: two hits to reach promotion
    await handler(makeVariantReq('alice') as any, makeRes());
    const aliceRes = makeRes();
    await handler(makeVariantReq('alice') as any, aliceRes); // hit 2 — JustPromoted, bakes alice variant
    expect(aliceRes.captured?.body).toContain('Hello alice');

    // Bob: isPromoted returns true (route promoted), cache miss for bob variant → re-bakes bob
    const bobRes1 = makeRes();
    await handler(makeVariantReq('bob') as any, bobRes1); // cache miss → SSR + bake bob variant
    expect(bobRes1.captured?.body).toContain('Hello bob');

    // Bob: second request now hits bob's variant cache
    const bobRes2 = makeRes();
    await handler(makeVariantReq('bob') as any, bobRes2);
    expect(bobRes2.captured?.body).toContain('Hello bob');
    expect(bobRes2.captured?.body).not.toContain('alice');

    // Alice: still serves alice's variant — no cross-contamination
    const aliceRes2 = makeRes();
    await handler(makeVariantReq('alice') as any, aliceRes2);
    expect(aliceRes2.captured?.body).toContain('Hello alice');
    expect(aliceRes2.captured?.body).not.toContain('bob');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe('applyLivePropMarkers', () => {
  it('wraps a LiveProp value with an s-live span when the rendered text is unambiguous', async () => {
    const { LiveProp } = await import('@kiln/core');
    const html = '<main><h1>Widgets</h1><p>Count: 3</p></main>';
    const result = applyLivePropMarkers(html, { count: new LiveProp(3) });
    expect(result).toBe('<main><h1>Widgets</h1><p>Count: <span s-live="count">3</span></p></main>');
  });

  it('skips auto-tagging (does not mistag) when the value is ambiguous', async () => {
    const { LiveProp } = await import('@kiln/core');
    // Two LiveProps rendering the same text ("0") — the naive first-match
    // string replace would wrap the wrong element for one of them.
    const html = '<main><span>Likes: 0</span><span>Comments: 0</span></main>';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg?: any) => { warnings.push(String(msg)); };
    try {
      const result = applyLivePropMarkers(html, {
        likes: new LiveProp(0),
        comments: new LiveProp(0),
      });
      // Nothing gets auto-tagged; html is left untouched rather than guessed at.
      expect(result).toBe(html);
      expect(result).not.toContain('s-live=');
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not double-tag a value that already has an explicit s-live attribute', async () => {
    const { LiveProp } = await import('@kiln/core');
    const html = '<main><p>Count: <span s-live="count">3</span></p></main>';
    const result = applyLivePropMarkers(html, { count: new LiveProp(3) });
    expect(result).toBe(html);
  });

  it('does not auto-tag store-target LiveProps (ADR-014 I-4)', async () => {
    const { LiveProp } = await import('@kiln/core');
    const html = '<main><p>Active: 7</p></main>';
    const result = applyLivePropMarkers(html, {
      activeUsers: new LiveProp(7, ['sessions'], { target: 'store' }),
    });
    // Store-target fields flow through Silcrow atoms, never DOM slots.
    expect(result).toBe(html);
  });
});

describe('warnDomLiveInsideIslands', () => {
  function captureWarnings(fn: () => void): string[] {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (msg?: any) => { warnings.push(String(msg)); };
    try { fn(); } finally { console.warn = original; }
    return warnings;
  }

  it('warns when a dom-target live slot renders inside an island marker', () => {
    const html =
      '<main><div data-kiln-island="Chart" data-kiln-hydrate="load" style="display:contents">' +
      '<p>Total: <span s-live="total">5</span></p></div></main>';
    const warnings = captureWarnings(() => warnDomLiveInsideIslands(html, '/warn-island-a'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('island "Chart"');
    expect(warnings[0]).toContain("target: 'store'");
  });

  it('is silent when live slots are outside islands', () => {
    const html =
      '<main><span s-live="total">5</span>' +
      '<div data-kiln-island="Chart" style="display:contents"><p>static</p></div></main>';
    const warnings = captureWarnings(() => warnDomLiveInsideIslands(html, '/warn-island-b'));
    expect(warnings).toEqual([]);
  });

  it('warns only once per route+island (warnOnce)', () => {
    const html =
      '<div data-kiln-island="Feed" style="display:contents"><i s-live="n">1</i></div>';
    const first = captureWarnings(() => warnDomLiveInsideIslands(html, '/warn-island-c'));
    const second = captureWarnings(() => warnDomLiveInsideIslands(html, '/warn-island-c'));
    expect(first.length).toBe(1);
    expect(second).toEqual([]);
  });
});

describe('islands bootstrap injection', () => {
  async function renderPage(component: any): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-island-inject-'));
    const handler = buildPageHandler(
      { default: component },
      {
        pattern: '/inject',
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
    await handler(makeReq({ path: '/inject' }) as any, res);
    await fs.rm(tmpDir, { recursive: true, force: true });
    return String(res.captured?.body ?? '');
  }

  it('injects the islands bootstrap exactly once when markers are present', async () => {
    const { createElement } = await import('react');
    const html = await renderPage(() =>
      createElement(
        'div',
        { 'data-kiln-island': 'Counter', 'data-kiln-hydrate': 'load', 'data-kiln-props': '{}' },
        createElement('p', null, 'hi'),
      ),
    );
    const matches = html.match(/src="\/_silcrow\/islands\.js"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(html).toContain('type="module"');
  });

  it('does not inject the bootstrap on pages without island markers', async () => {
    const { createElement } = await import('react');
    const html = await renderPage(() => createElement('p', null, 'plain'));
    expect(html).not.toContain('/_silcrow/islands.js');
  });
});

describe('startKiln islands manifest route', () => {
  it('registers /_kiln/islands.json and serves an empty no-store manifest without a build', async () => {
    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-pages-'));
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    const adapter: any = {
      registerPage: (p: string, _l: string[], h: any) => { routes.set(p, h); },
      registerAction: () => {},
      registerSSE: () => {},
      registerAsset: () => {},
      applyMiddleware: () => {},
      applyServerHooks: async () => {},
      listen: async () => {},
    };
    await startKiln(adapter, { cache: { provider: 'filesystem' } } as any, pagesDir);

    const handler = routes.get('/_kiln/islands.json');
    expect(handler).toBeDefined();
    const res = makeRes();
    await handler!(makeReq({ path: '/_kiln/islands.json' }) as any, res);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.captured?.type).toBe('json');
    expect(res.captured?.body).toEqual({ version: 'none', islands: {} });
    await fs.rm(pagesDir, { recursive: true, force: true });
  });
});
