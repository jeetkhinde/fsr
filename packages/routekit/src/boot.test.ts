import { describe, it, expect } from 'bun:test';
import { buildPageHandler, applyLivePropMarkers } from './boot.js';
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

    await expect(handler(makeReq({ path: '/external' }) as any, makeRes())).rejects.toThrow(
      'Live.list requires config.fsr.watcher = "embedded"'
    );
    await fs.rm(tmpDir, { recursive: true });
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
});
