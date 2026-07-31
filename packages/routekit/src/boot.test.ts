import { describe, it, expect, spyOn } from 'bun:test';
import { buildPageHandler, applyLivePropMarkers, warnDomLiveInsideIslands, startKiln } from './boot.js';
import { createCookies } from '@kiln/core';
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
    locals: {},
    prebakeNext: () => {},
    ...overrides
  };
}

function makeRes(): any {
  const headers = new Headers();
  const res: any = { status: 200, headers, cookies: createCookies(headers), captured: null };
  res.html = (b: string) => {
    res.bodyType = 'html';
    res.captured = { type: 'html', body: b };
  };
  res.json = (b: unknown) => {
    res.bodyType = 'json';
    res.captured = { type: 'json', body: b };
  };
  res.redirect = (url: string) => {
    res.bodyType = 'redirect';
    res.captured = { type: 'redirect', url };
  };
  res.sse = () => {};
  return res;
}

describe('buildPageHandler', () => {
  it('bakes on the first successful pure render and serves later requests without loaders or React', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    let loads = 0;
    let renders = 0;
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
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
    expect(await Bun.file(path.join(tmpDir, 'lifecycle', 'index.html')).exists()).toBe(true);

    const second = makeRes();
    await handler(makeReq({ path: '/lifecycle' }) as any, second);
    expect(second.captured.body).toContain('render-1');
    expect(loads).toBe(1);
    expect(renders).toBe(1);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('never bakes a route whose load() reads req.locals, no matter how many hits', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    let loads = 0;
    const pageModule = {
      load: async (req: any) => {
        loads += 1;
        return { who: (req.locals as any).user ?? 'anon' };
      },
      default: ({ who }: any) => createElement('div', null, `hello ${who}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/private', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
    );
    for (let i = 0; i < 4; i++) {
      const res = makeRes();
      await handler(makeReq({ path: '/private', locals: { user: `u${i}` } }) as any, res);
      expect(res.captured.body).toContain(`hello u${i}`);
    }
    expect(loads).toBe(4); // every hit re-rendered; nothing served from cache
    expect(await Bun.file(path.join(tmpDir, 'private', 'index.html')).exists()).toBe(false);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('bake=false never writes artifacts even for a pure load()', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    let loads = 0;
    const pageModule = {
      bake: false,
      load: async () => ({ n: ++loads }),
      default: ({ n }: any) => createElement('div', null, `count-${n}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/ssr-only', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
    );
    await handler(makeReq({ path: '/ssr-only' }) as any, makeRes());
    const second = makeRes();
    await handler(makeReq({ path: '/ssr-only' }) as any, second);
    expect(second.captured.body).toContain('count-2'); // re-rendered, not cached
    expect(await Bun.file(path.join(tmpDir, 'ssr-only', 'index.html')).exists()).toBe(false);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("bake='user' serves each user their own cached artifact and SSRs anonymous", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-user-'));
    const { createElement } = await import('react');
    let loads = 0;
    const pageModule = {
      bake: 'user',
      load: async (req: any) => {
        loads++;
        return { who: (req.locals as any).user ?? 'anon' };
      },
      default: ({ who }: any) => createElement('div', null, `hello ${who}`),
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/mine', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      undefined,
      undefined,
      undefined,
      identity as any,
    );
    // tom: hit 1 bakes his variant, hit 2 serves it (no load)
    await handler(makeReq({ path: '/mine', locals: { user: 'tom' } }) as any, makeRes());
    const tom2 = makeRes();
    await handler(makeReq({ path: '/mine', locals: { user: 'tom' } }) as any, tom2);
    expect(tom2.captured.body).toContain('hello tom');
    expect(loads).toBe(1);
    // adam: his own variant, never tom's
    const adam = makeRes();
    await handler(makeReq({ path: '/mine', locals: { user: 'adam' } }) as any, adam);
    expect(adam.captured.body).toContain('hello adam');
    expect(adam.captured.body).not.toContain('tom');
    expect(loads).toBe(2);
    // anonymous: pure SSR every hit, no artifacts written
    await handler(makeReq({ path: '/mine', locals: {} }) as any, makeRes());
    await handler(makeReq({ path: '/mine', locals: {} }) as any, makeRes());
    expect(loads).toBe(4);
    expect(await Bun.file(path.join(tmpDir, 'mine', 'index.html')).exists()).toBe(false); // no base-key artifact
    await fs.rm(tmpDir, { recursive: true });
  });

  it('serves cached page-only JSON for a baked route without re-running load()', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-json-'));
    const { createElement } = await import('react');
    let loads = 0;
    const pageModule = {
      load: async () => {
        loads++;
        return { n: 42 };
      },
      default: ({ n }: any) => createElement('div', null, `n=${n}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/nums', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
    );
    await handler(makeReq({ path: '/nums' }) as any, makeRes()); // bakes on hit 1
    const jsonRes = makeRes();
    await handler(
      makeReq({ path: '/nums', headers: new Headers({ accept: 'application/json' }) }) as any,
      jsonRes,
    );
    expect(jsonRes.captured.type).toBe('json');
    expect(jsonRes.captured.body).toEqual({ n: 42 }); // page-only props, not seed shape
    expect(loads).toBe(1); // served from the snapshot, load() not re-run
    await fs.rm(tmpDir, { recursive: true });
  });

  it('serves live-patched values via the JSON fast path, not the stale bake-time pageData (Task 8)', async () => {
    // Regression: cache.patchJsonField only patched the snapshot's `data`
    // object, never the sibling `pageData` the JSON fast path actually
    // reads — so a client hitting Accept: application/json after a live
    // patch got stale props even though `data` (and the HTML shell) were
    // fresh.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-pagedata-fresh-'));
    const pageModule = {
      load: async () => ({ count: 1 }),
      default: ({ count }: any) => null,
    };
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/counter', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      cacheOpts,
    );
    await handler(makeReq({ path: '/counter' }) as any, makeRes()); // bakes: data.count = pageData.count = 1

    // Simulate the live patch a watcher/hub applies on a value change.
    const { KilnCache } = await import('@kiln/engine');
    const cache = new KilnCache(cacheOpts);
    await cache.patchJsonField('/counter', 'count', 99);

    const jsonRes = makeRes();
    await handler(
      makeReq({ path: '/counter', headers: new Headers({ accept: 'application/json' }) }) as any,
      jsonRes,
    );
    expect(jsonRes.captured.body).toEqual({ count: 99 }); // fresh, not the baked 1
    await fs.rm(tmpDir, { recursive: true });
  });

  it('a changed fsr.buildId invalidates baked artifacts on read', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-build-'));
    const { createElement } = await import('react');
    let loads = 0;
    const pageModule = {
      load: async () => ({ v: ++loads }),
      default: ({ v }: any) => createElement('div', null, `v=${v}`),
    };
    const meta = { pattern: '/deploy', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' };
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    const buildA = buildPageHandler(pageModule, meta, [], cacheOpts, { fsr: { buildId: 'build-A' } } as any);
    await buildA(makeReq({ path: '/deploy' }) as any, makeRes()); // bakes under build-A
    const cachedA = makeRes();
    await buildA(makeReq({ path: '/deploy' }) as any, cachedA);
    expect(cachedA.captured.body).toContain('v=1'); // cache hit within build-A
    expect(loads).toBe(1);

    const buildB = buildPageHandler(pageModule, meta, [], cacheOpts, { fsr: { buildId: 'build-B' } } as any);
    const fresh = makeRes();
    await buildB(makeReq({ path: '/deploy' }) as any, fresh);
    expect(fresh.captured.body).toContain('v=2'); // build mismatch forced a re-bake
    expect(loads).toBe(2);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("an action deletes the actor's bake='user' artifacts so the redirect GET is fresh", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-ryw-'));
    const { createElement } = await import('react');
    const { buildActionHandler } = await import('./boot.js');
    let title = 'before';
    let loads = 0;
    const pageModule = {
      bake: 'user',
      load: async (req: any) => {
        loads++;
        return { title: `${title}-${(req.locals as any).user}` };
      },
      default: ({ title }: any) => createElement('h1', null, title),
      actions: {
        rename: async () => {
          title = 'after';
          return { ok: true };
        },
      },
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    const meta = { pattern: '/doc', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' };
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    const pageHandler = buildPageHandler(pageModule, meta, [], cacheOpts, undefined, undefined, undefined, undefined, identity as any);
    const { KilnCache } = await import('@kiln/engine');
    const actionHandler = buildActionHandler(pageModule.actions, {
      cache: new KilnCache(cacheOpts),
      identity: identity as any,
      bake: 'user',
    });

    // bake tom's and adam's variants
    await pageHandler(makeReq({ path: '/doc', locals: { user: 'tom' } }) as any, makeRes());
    await pageHandler(makeReq({ path: '/doc', locals: { user: 'adam' } }) as any, makeRes());
    expect(loads).toBe(2);

    // tom acts
    const actRes = makeRes();
    await actionHandler(
      makeReq({ path: '/doc', method: 'POST', query: { '/rename': '' } as any, locals: { user: 'tom' } }) as any,
      actRes,
    );

    // tom's next GET re-renders fresh (his artifact was deleted)
    const tomAfter = makeRes();
    await pageHandler(makeReq({ path: '/doc', locals: { user: 'tom' } }) as any, tomAfter);
    expect(tomAfter.captured.body).toContain('after-tom');
    expect(loads).toBe(3);

    // adam's cached artifact is untouched — served without a load
    const adamAfter = makeRes();
    await pageHandler(makeReq({ path: '/doc', locals: { user: 'adam' } }) as any, adamAfter);
    expect(adamAfter.captured.body).toContain('before-adam');
    expect(loads).toBe(3);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('passes res to the action, so it can set cookies', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      signin: async (_req: any, res: any) => {
        res.cookies.set('sid', 'abc', { httpOnly: true });
        return { ok: true };
      },
    });

    const res = makeRes();
    await handler(
      makeReq({ path: '/login', method: 'POST', query: { '/signin': '' } as any }) as any,
      res,
    );

    expect(res.headers.getSetCookie()).toEqual(['sid=abc; Path=/; HttpOnly']);
    expect(res.captured).toEqual({ type: 'json', body: { ok: true } });
  });

  it('preserves a status the action set, so 409 is reachable', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      claim: async (_req: any, res: any) => {
        res.status = 409;
        return { error: 'already claimed' };
      },
    });

    const res = makeRes();
    await handler(
      makeReq({ path: '/t', method: 'POST', query: { '/claim': '' } as any }) as any,
      res,
    );

    expect(res.status).toBe(409);
    expect(res.captured).toEqual({ type: 'json', body: { error: 'already claimed' } });
  });

  it('keeps cookies staged before an AppError.redirect', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const { AppError } = await import('@kiln/core');
    const handler = buildActionHandler({
      signout: async (_req: any, res: any) => {
        res.cookies.delete('sid');
        throw AppError.redirect('/login');
      },
    });

    const res = makeRes();
    await handler(
      makeReq({ path: '/login', method: 'POST', query: { '/signout': '' } as any }) as any,
      res,
    );

    expect(res.captured).toEqual({ type: 'redirect', url: '/login' });
    expect(res.headers.getSetCookie()).toEqual(['sid=; Path=/; Max-Age=0']);
  });

  it('does not overwrite a body the action committed itself', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      csv: async (_req: any, res: any) => {
        res.headers.set('content-type', 'text/csv');
        res.html('a,b\n1,2');
      },
    });

    const res = makeRes();
    await handler(
      makeReq({ path: '/t', method: 'POST', query: { '/csv': '' } as any }) as any,
      res,
    );

    expect(res.captured).toEqual({ type: 'html', body: 'a,b\n1,2' });
  });

  it('warns when an action both commits a body and returns a value', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const handler = buildActionHandler({
        both: async (_req: any, res: any) => {
          res.html('committed');
          return { ignored: true };
        },
      });
      const res = makeRes();
      await handler(
        makeReq({ path: '/warn-both', method: 'POST', query: { '/both': '' } as any }) as any,
        res,
      );
      expect(res.captured).toEqual({ type: 'html', body: 'committed' });
    } finally {
      console.warn = original;
    }

    expect(warnings.some((w) => w.includes('both wrote to res and returned a value'))).toBe(true);
  });

  it('still supports a one-argument action', async () => {
    const { buildActionHandler } = await import('./boot.js');
    const handler = buildActionHandler({
      legacy: async (_req: any) => ({ greeting: 'hi' }),
    });

    const res = makeRes();
    await handler(
      makeReq({ path: '/t', method: 'POST', query: { '/legacy': '' } as any }) as any,
      res,
    );

    expect(res.captured).toEqual({ type: 'json', body: { greeting: 'hi' } });
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
        isTombstoned: async () => false,
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
    expect(res.headers.get('content-type')).toContain('x-ps-fragment=1');
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
    expect(rootOnlyRes.headers.get('content-type')).toContain('x-ps-fragment=1');
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
    expect(resB.headers.get('x-kiln-layout-cache-hit')).toBe('/section');
    expect(resA.headers.get('x-kiln-layout-cache-hit')).toBeNull(); // A did the fresh bake

    await fs.rm(tmpDir, { recursive: true });
  });

  it('renders each concrete instance of a dynamic layout with its own data', async () => {
    // Regression: layouts were cached by PATTERN alone, so "/projects/:id"
    // had one shared entry and the first project baked leaked its chrome
    // (name, nav hrefs) into every other project's page. ADR-011 explicitly
    // allows a layout to read params its own pattern owns, so the key — not
    // the layout — was the thing that had to change.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const layoutPath = path.join(tmpDir, 'project_layout.tsx');
    await Bun.write(
      layoutPath,
      `export async function load(req) {
         globalThis.__projectLayoutLoads = (globalThis.__projectLayoutLoads||0)+1;
         return { name: "PROBE-" + req.params.id };
       }
       export default function ProjectLayout({ name, children }) {
         return [name, children];
       }`,
    );
    (globalThis as any).__projectLayoutLoads = 0;

    const { createElement } = await import('react');
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    const layoutNodes = [
      { pattern: '/projects/:id', filePath: layoutPath, relativePath: 'project_layout.tsx', hasLoad: true },
    ];
    const pageMeta = (pattern: string) => ({
      pattern, layouts: [layoutPath], liveFields: [], hasEntries: false, filePath: '', relativePath: '',
    });
    const activity = buildPageHandler(
      { default: () => createElement('h2', null, 'ACTIVITY') },
      pageMeta('/projects/:id/activity'),
      layoutNodes,
      cacheOpts,
    );
    const board = buildPageHandler(
      { default: () => createElement('h2', null, 'BOARD') },
      pageMeta('/projects/:id/board'),
      layoutNodes,
      cacheOpts,
    );

    const alpha = makeRes();
    await activity(makeReq({ path: '/projects/ALPHA/activity', params: { id: 'ALPHA' } }) as any, alpha);
    const beta = makeRes();
    await activity(makeReq({ path: '/projects/BETA/activity', params: { id: 'BETA' } }) as any, beta);

    expect(alpha.captured.body).toContain('PROBE-ALPHA');
    expect(beta.captured.body).toContain('PROBE-BETA');
    // The leak, stated directly: beta's page must not carry alpha's chrome.
    expect(beta.captured.body).not.toContain('PROBE-ALPHA');
    expect(alpha.captured.body).not.toContain('PROBE-BETA');
    // Both were fresh bakes — neither could reuse the other's entry.
    expect((globalThis as any).__projectLayoutLoads).toBe(2);

    // ...and sharing across a SIBLING page of the same project still works,
    // which is the benefit pattern-scoping exists for: no third load().
    const alphaBoard = makeRes();
    await board(makeReq({ path: '/projects/ALPHA/board', params: { id: 'ALPHA' } }) as any, alphaBoard);
    expect(alphaBoard.captured.body).toContain('PROBE-ALPHA');
    expect(alphaBoard.captured.body).toContain('BOARD');
    expect(alphaBoard.headers.get('x-kiln-layout-cache-hit')).toBe('/projects/:id');
    expect((globalThis as any).__projectLayoutLoads).toBe(2);

    await fs.rm(tmpDir, { recursive: true });
  });

  it('does not share a layout that reads a param its own pattern does not own', async () => {
    // ADR-011 enforcement. The sibling test above covers a layout reading its
    // OWN param — allowed, and keyed. This is the inverse: a layout at
    // "/section" reading req.params.id, which belongs to a DESCENDANT page.
    // `id` is absent from the layout's cache key, so caching it would serve
    // the first instance's chrome for every instance — the exact shape the
    // deleted address-book ContactsLayout had.
    //
    // Correct behaviour is to stop caching it, not to cache it wrongly: the
    // guard marks the layout impure, which routes it through the existing
    // deleteLayout self-heal. Output stays right; only the sharing is lost.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const layoutPath = path.join(tmpDir, 'stray_layout.tsx');
    await Bun.write(
      layoutPath,
      `export async function load(req) {
         globalThis.__strayLayoutLoads = (globalThis.__strayLayoutLoads||0)+1;
         return { tag: "STRAY-" + req.params.id };
       }
       export default function StrayLayout({ tag, children }) {
         return [tag, children];
       }`,
    );
    (globalThis as any).__strayLayoutLoads = 0;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    const { createElement } = await import('react');
    const cacheOpts = { cacheDir: tmpDir, ttlSecs: 0, redis: null };
    // Pattern owns NO params; the descendant page supplies :id.
    const layoutNodes = [
      { pattern: '/section', filePath: layoutPath, relativePath: 'stray_layout.tsx', hasLoad: true },
    ];
    const detail = buildPageHandler(
      { default: () => createElement('h2', null, 'DETAIL') },
      { pattern: '/section/:id', layouts: [layoutPath], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      layoutNodes,
      cacheOpts,
    );

    const one = makeRes();
    await detail(makeReq({ path: '/section/ONE', params: { id: 'ONE' } }) as any, one);
    const two = makeRes();
    await detail(makeReq({ path: '/section/TWO', params: { id: 'TWO' } }) as any, two);

    // Each instance renders its own data — no cross-instance leak.
    expect(one.captured.body).toContain('STRAY-ONE');
    expect(two.captured.body).toContain('STRAY-TWO');
    expect(two.captured.body).not.toContain('STRAY-ONE');
    // Both re-loaded: the layout was never cached, which is the correct
    // trade for a layout whose output varies by something not in its key.
    expect((globalThis as any).__strayLayoutLoads).toBe(2);
    expect(two.headers.get('x-kiln-layout-cache-hit')).toBeNull();
    // And the developer is told why, naming the offending read.
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('ADR-011') && m.includes('params.id'))).toBe(true);

    warn.mockRestore();
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
      isTombstoned: async () => false,
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

  it('rejects fsr.watcher = "external" at config time, by name', async () => {
    // The mode was typed for two releases with nothing behind it, so an app
    // that set it was silently running uncached. Removing the option without
    // saying so would just move the surprise.
    const { defineConfig } = await import('@kiln/core');
    expect(() => defineConfig({ fsr: { watcher: 'external' } } as any)).toThrow(
      /fsr\.watcher = "external"/,
    );
    expect(() => defineConfig({ fsr: { watcher: 'embedded' } })).not.toThrow();
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

  it('auto-derives depends_on from tables read during load()', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-autodep-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    // collectDeps lives on the server-only subpath — the '@kiln/core'
    // barrel has to stay client-bundleable (sql.ts imports node:async_hooks).
    const { collectDeps } = await import('@kiln/core/sql');
    const upserts: any[] = [];
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      upsertSlot: async (...args: any[]) => {
        upserts.push(args);
      },
    };
    const pageModule = {
      load: async () => {
        // simulate a captured query by adding to the active scope directly:
        collectDeps()?.add('tasks');
        return { count: Live.value(0) }; // live field, NO explicit deps
      },
      default: ({ count }: any) => createElement('div', null, `n=${count}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/auto', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );
    await handler(makeReq({ path: '/auto' }) as any, makeRes());
    const countUpsert = upserts.find((a) => a[1] === 'count');
    expect(countUpsert).toBeDefined();
    expect(countUpsert[4]).toContain('tasks'); // dependsOn arg (index 4) unions the observed table
    await fs.rm(tmpDir, { recursive: true });
  });

  it('snapshots slot versions BEFORE load() and passes them to upsertSlot (stale race guard)', async () => {
    // upsertSlot clears `stale` so a rebuild-on-read doesn't leave the flag
    // set forever, but it must not swallow an invalidation that landed while
    // load() was running — on a dormant route neither freshness tier would
    // ever notice, so the snapshot would serve pre-invalidation data
    // indefinitely. The guard is the slot's `version` as observed before
    // load(); capturing it after would already include that invalidation.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-stalerace-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const calls: string[] = [];
    const upserts: any[] = [];
    let version = 7;
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      fetchSlotVersions: async () => {
        calls.push('fetchSlotVersions');
        return { count: version };
      },
      upsertSlot: async (...args: any[]) => {
        upserts.push(args);
      },
    };
    const pageModule = {
      load: async () => {
        calls.push('load');
        // A dependency write lands mid-render: invalidateDepKey bumps version.
        version = 8;
        return { count: Live.value(0) };
      },
      default: ({ count }: any) => createElement('div', null, `n=${count}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/race', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );
    await handler(makeReq({ path: '/race' }) as any, makeRes());

    expect(calls).toEqual(['fetchSlotVersions', 'load']); // ordering is the whole point
    const countUpsert = upserts.find((a) => a[1] === 'count');
    expect(countUpsert).toBeDefined();
    // expectedVersion (arg index 8) is the PRE-load value, so the store's
    // guard sees a version mismatch and declines to clear the stale flag.
    expect(countUpsert[8]).toBe(7);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('skips the pre-load version snapshot once a route is known to have no live fields', async () => {
    // The snapshot is only useful to upsertSlot, which only runs for pages
    // with live fields — a plain static page must not pay a Postgres query
    // per render for it. First render can't know yet, so it still asks.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-stalerace-skip-'));
    const { createElement } = await import('react');
    let versionCalls = 0;
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      fetchSlotVersions: async () => { versionCalls++; return {}; },
      upsertSlot: async () => {},
    };
    const pageModule = {
      load: async () => ({ title: 'no live fields here' }),
      default: ({ title }: any) => createElement('div', null, title),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/plain', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );
    await handler(makeReq({ path: '/plain' }) as any, makeRes());
    expect(versionCalls).toBe(1); // first render: live fields still unknown
    await handler(makeReq({ path: '/plain?x=1' }) as any, makeRes());
    await handler(makeReq({ path: '/plain?x=2' }) as any, makeRes());
    expect(versionCalls).toBe(1); // now known live-field-free: no further queries
    await fs.rm(tmpDir, { recursive: true });
  });

  it('unions auto-derived tables with an explicit dependsOn, never replacing it', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-autodep-union-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    // collectDeps lives on the server-only subpath — the '@kiln/core'
    // barrel has to stay client-bundleable (sql.ts imports node:async_hooks).
    const { collectDeps } = await import('@kiln/core/sql');
    const upserts: any[] = [];
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      upsertSlot: async (...args: any[]) => {
        upserts.push(args);
      },
    };
    const pageModule = {
      load: async () => {
        collectDeps()?.add('tasks');
        return { count: Live.value(0, ['sessions']) }; // explicit dep + observed table
      },
      default: ({ count }: any) => createElement('div', null, `n=${count}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/auto2', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );
    await handler(makeReq({ path: '/auto2' }) as any, makeRes());
    const countUpsert = upserts.find((a) => a[1] === 'count');
    expect(countUpsert).toBeDefined();
    expect(countUpsert[4]).toEqual(expect.arrayContaining(['sessions', 'tasks']));
    expect(countUpsert[4]).toHaveLength(2);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('skips the auto-derived union when fsr.autoDeps is false, keeping only explicit deps', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-autodep-off-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    // collectDeps lives on the server-only subpath — the '@kiln/core'
    // barrel has to stay client-bundleable (sql.ts imports node:async_hooks).
    const { collectDeps } = await import('@kiln/core/sql');
    const upserts: any[] = [];
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      upsertSlot: async (...args: any[]) => {
        upserts.push(args);
      },
    };
    const pageModule = {
      load: async () => {
        collectDeps()?.add('tasks');
        return { count: Live.value(0, ['sessions']) };
      },
      default: ({ count }: any) => createElement('div', null, `n=${count}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/auto3', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      { fsr: { autoDeps: false } } as any,
      store as any,
    );
    await handler(makeReq({ path: '/auto3' }) as any, makeRes());
    const countUpsert = upserts.find((a) => a[1] === 'count');
    expect(countUpsert).toBeDefined();
    expect(countUpsert[4]).toEqual(['sessions']);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('serves different cached HTML per cacheKey variant with no cross-contamination', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-variant-'));
    const { createElement } = await import('react');
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
    };

    const module = {
      cacheKey: (req: any) => req.headers.get('x-user-id') ?? 'anon',
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

    // Alice: first hit bakes her variant (cache_key pages bake per variant;
    // reading the keyed header is expected, not an impurity demotion)
    const aliceRes = makeRes();
    await handler(makeVariantReq('alice') as any, aliceRes);
    expect(aliceRes.captured?.body).toContain('Hello alice');

    // Bob: cache miss for bob's variant → SSR + bake bob variant
    const bobRes1 = makeRes();
    await handler(makeVariantReq('bob') as any, bobRes1);
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

  it('rebuilds a dormant stale snapshot on read instead of serving it stale', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-dormant-'));
    const { createElement } = await import('react');
    let n = 0;
    let dormantStale = false;
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      fetchDormantStaleSlot: async (_route: string, _userKey: string) => {
        if (!dormantStale) return null;
        dormantStale = false; // one-shot: cleared once observed, like a real stale flag flip
        return { route: '/dz', slot: 'n', userKey: '', query: null, queryParams: null, dependsOn: [], promoted: true, debounceSecs: null, htmlPath: null, jsonPath: null, columnName: null, patchMode: null };
      },
      __setDormantStale: (_route: string, _userKey: string, val: boolean) => {
        dormantStale = val;
      },
    };
    const pageModule = {
      load: async () => ({ n: ++n }),
      default: ({ n }: any) => createElement('div', null, `n=${n}`),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/dz', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );
    await handler(makeReq({ path: '/dz' }) as any, makeRes()); // bake n=1
    (store as any).__setDormantStale('/dz', '', true); // slot goes stale, dormant
    const r2 = makeRes();
    await handler(makeReq({ path: '/dz' }) as any, r2);
    expect(r2.captured?.body).toContain('n=2'); // rebuilt, not served stale
    expect(n).toBe(2);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('rebuilds a dormant stale snapshot on the JSON fast path instead of serving stale pageData (Important #1)', async () => {
    // Regression: the JSON fast path (Accept: application/json) read
    // snap.pageData straight from cache with NO dormant-stale check at all.
    // A route hit only via its JSON endpoint (never SSE-subscribed, so
    // never "active") would serve known-stale pageData forever once its
    // dependency changed — the watcher's eager loop skips dormant routes by
    // design, and only the read path's own dormant check can catch this.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-dormant-json-'));
    let n = 0;
    let dormantStale = false;
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      fetchDormantStaleSlot: async (_route: string, _userKey: string) => {
        if (!dormantStale) return null;
        dormantStale = false; // one-shot: cleared once observed, like a real stale flag flip
        return { route: '/dzj', slot: 'n', userKey: '', query: null, queryParams: null, dependsOn: [], promoted: true, debounceSecs: null, htmlPath: null, jsonPath: null, columnName: null, patchMode: null };
      },
      __setDormantStale: (_route: string, _userKey: string, val: boolean) => {
        dormantStale = val;
      },
    };
    const pageModule = {
      load: async () => ({ n: ++n }),
      default: ({ n }: any) => null,
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/dzj', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
    );
    await handler(makeReq({ path: '/dzj' }) as any, makeRes()); // bakes n=1, writes JSON snapshot

    // Sanity: before invalidation, the JSON fast path serves the cached
    // snapshot without re-running load().
    const preRes = makeRes();
    await handler(
      makeReq({ path: '/dzj', headers: new Headers({ accept: 'application/json' }) }) as any,
      preRes,
    );
    expect(preRes.captured.body).toEqual({ n: 1 });
    expect(n).toBe(1);

    (store as any).__setDormantStale('/dzj', '', true); // slot goes stale, dormant
    const jsonRes = makeRes();
    await handler(
      makeReq({ path: '/dzj', headers: new Headers({ accept: 'application/json' }) }) as any,
      jsonRes,
    );
    expect(jsonRes.captured.body).toEqual({ n: 2 }); // rebuilt, not served stale pageData
    expect(n).toBe(2);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('skips the dormant-staleness Postgres check for a route this process knows is SSE-active (Important #2)', async () => {
    // Regression: fetchDormantStaleSlot ran on EVERY validated cache hit,
    // including hot routes the watcher is already keeping fresh via
    // pg_notify because an SSE subscriber pinned them active in this
    // process (FsrWatcher.markLocallyActive). That's a Postgres query on
    // the "zero-Postgres cached read path for active snapshots" the plan's
    // Global Constraints require staying zero-Postgres.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-active-noquery-'));
    let n = 0;
    let dormantCheckCalls = 0;
    const store = {
      ensureRouteRow: async () => {},
      isTombstoned: async () => false,
      setBakedPaths: async () => {},
      touchRoute: async () => {},
      fetchDormantStaleSlot: async (_route: string, _userKey: string) => {
        dormantCheckCalls++;
        // Even though the store WOULD report dormant-stale if asked, the
        // route is locally active — the check must never fire at all.
        return { route: '/actv', slot: 'n', userKey: '', query: null, queryParams: null, dependsOn: [], promoted: true, debounceSecs: null, htmlPath: null, jsonPath: null, columnName: null, patchMode: null };
      },
    };
    const watcher = {
      hasRegisteredRoute: () => true, // materialized cache hits respond immediately
      isLocallyActive: (_route: string, _userKey: string, _windowSecs: number) => true,
    };
    const pageModule = {
      load: async () => ({ n: ++n }),
      default: ({ n }: any) => null,
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/actv', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
      watcher as any,
    );
    await handler(makeReq({ path: '/actv' }) as any, makeRes()); // bakes n=1

    const r2 = makeRes();
    await handler(makeReq({ path: '/actv' }) as any, r2); // cache hit, HTML path
    expect(dormantCheckCalls).toBe(0); // never queried — isLocallyActive gated it out
    expect(n).toBe(1); // served straight from cache, not rebuilt

    const jsonRes = makeRes();
    await handler(
      makeReq({ path: '/actv', headers: new Headers({ accept: 'application/json' }) }) as any,
      jsonRes,
    ); // cache hit, JSON fast path
    expect(dormantCheckCalls).toBe(0); // still never queried
    expect(jsonRes.captured.body).toEqual({ n: 1 });

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("dynamic bake='user' + live fields warning (Task 8 fix)", () => {
  async function captureWarningsAsync(fn: () => Promise<void>): Promise<string[]> {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (msg?: any) => { warnings.push(String(msg)); };
    try {
      await fn();
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  it("no longer warns for a dynamic-pattern bake='user' page with a LiveProp field", async () => {
    // Was the silently-broken combination: bakeByPattern is keyed by
    // page.pattern and was looked up with the concrete request pathname, so
    // the SSE + snapshot handlers fell back to the shared ('') key. The
    // handlers now match the path back to its pattern first
    // (resolveRouteUserKey), so the combination works and the warning that
    // told authors to avoid it would be false. Scoping itself is covered by
    // route-user-key.test.ts.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-dynuser-warn-'));
    const { LiveProp } = await import('@kiln/core');
    const pageModule = {
      bake: 'user',
      load: async () => ({ count: new LiveProp(1) }),
      default: ({ count }: any) => null,
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/users/:id', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      undefined,
      {} as any,
      undefined,
      identity as any,
    );
    const warnings = await captureWarningsAsync(async () => {
      await handler(makeReq({ path: '/users/5', locals: { user: 'tom' } }) as any, makeRes());
    });
    expect(warnings.filter((w: string) => w.includes('dynamic path segment'))).toHaveLength(0);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("does not warn for a static bake='user' page with a LiveProp field (this combination works correctly)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-statuser-nowarn-'));
    const { LiveProp } = await import('@kiln/core');
    const pageModule = {
      bake: 'user',
      load: async () => ({ count: new LiveProp(1) }),
      default: ({ count }: any) => null,
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/profile', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      undefined,
      {} as any,
      undefined,
      identity as any,
    );
    const warnings = await captureWarningsAsync(async () => {
      await handler(makeReq({ path: '/profile', locals: { user: 'tom' } }) as any, makeRes());
    });
    expect(warnings).toEqual([]);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("does not warn for a dynamic bake='user' page with NO live fields (nothing to break)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-dynuser-nolive-nowarn-'));
    const pageModule = {
      bake: 'user',
      load: async () => ({ name: 'static value' }),
      default: ({ name }: any) => null,
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/users/:id', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      undefined,
      {} as any,
      undefined,
      identity as any,
    );
    const warnings = await captureWarningsAsync(async () => {
      await handler(makeReq({ path: '/users/5', locals: { user: 'tom' } }) as any, makeRes());
    });
    expect(warnings).toEqual([]);
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

describe('startKiln cache provider guard', () => {
  // CacheProvider no longer types 'memory'/'sqlite', so TS blocks them in a
  // TS-authored config — but a JS-authored config (or a cast) still can, and
  // the runtime must refuse rather than silently writing to disk. This guard
  // is now the ONLY protection for that path, so it needs its own test.
  it.each(['memory', 'sqlite'])('refuses the unimplemented %s provider', async (provider) => {
    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-pages-'));
    const adapter: any = {
      registerPage: () => {},
      registerAction: () => {},
      registerSSE: () => {},
      registerAsset: () => {},
      applyMiddleware: () => {},
      applyServerHooks: async () => {},
      listen: async () => {},
    };
    await expect(
      startKiln(adapter, { cache: { provider } } as any, pagesDir),
    ).rejects.toThrow(/not implemented/i);
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
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.captured?.type).toBe('json');
    expect(res.captured?.body).toEqual({ version: 'none', islands: {} });
    await fs.rm(pagesDir, { recursive: true, force: true });
  });
});

describe('__kiln/fsr SSE subscribe', () => {
  it('marks the (route, user) snapshot active on subscribe (Task 7)', async () => {
    // A page someone has open in a browser tab should get eager patches even
    // though nobody is re-requesting it — the SSE subscribe itself must ping
    // store.markActive so the watcher's activeWindowSecs gate (Task 6) treats
    // the route as active.
    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-pages-'));
    const sseRoutes = new Map<string, (req: any, res: any) => Promise<void>>();
    const markActiveCalls: [string, string][] = [];
    const fakeStore: any = {
      markActive: async (route: string, userKey = '') => {
        markActiveCalls.push([route, userKey]);
      },
    };
    const adapter: any = {
      registerPage: () => {},
      registerAction: () => {},
      registerSSE: (p: string, h: any) => { sseRoutes.set(p, h); },
      registerAsset: () => {},
      applyMiddleware: () => {},
      applyServerHooks: async () => {},
      listen: async () => {},
    };
    await startKiln(adapter, { cache: { provider: 'filesystem' } } as any, pagesDir, { store: fakeStore } as any);

    const handler = sseRoutes.get('/__kiln/fsr');
    expect(handler).toBeDefined();
    const res = makeRes();
    await handler!(makeReq({ path: '/__kiln/fsr', query: { route: '/dash', slots: '' } }) as any, res);

    expect(markActiveCalls).toEqual([['/dash', '']]);
    await fs.rm(pagesDir, { recursive: true, force: true });
  });

  it('pins the (route, user) snapshot locally active on subscribe, in addition to store.markActive (Important #2)', async () => {
    // The read path's dormant-staleness check (isDormantStale) consults
    // FsrWatcher.isLocallyActive to skip its Postgres query for routes this
    // process already knows are SSE-active — markLocallyActive is what
    // populates that signal, and it must fire on every subscribe alongside
    // the existing store.markActive call.
    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-pages-'));
    const sseRoutes = new Map<string, (req: any, res: any) => Promise<void>>();
    const markLocallyActiveCalls: [string, string | undefined][] = [];
    const fakeStore: any = { markActive: async () => {} };
    const fakeWatcher: any = {
      markLocallyActive: (route: string, userKey?: string) => {
        markLocallyActiveCalls.push([route, userKey]);
      },
    };
    const adapter: any = {
      registerPage: () => {},
      registerAction: () => {},
      registerSSE: (p: string, h: any) => { sseRoutes.set(p, h); },
      registerAsset: () => {},
      applyMiddleware: () => {},
      applyServerHooks: async () => {},
      listen: async () => {},
    };
    await startKiln(
      adapter,
      { cache: { provider: 'filesystem' } } as any,
      pagesDir,
      { store: fakeStore, watcher: fakeWatcher } as any,
    );

    const handler = sseRoutes.get('/__kiln/fsr');
    expect(handler).toBeDefined();
    const res = makeRes();
    await handler!(makeReq({ path: '/__kiln/fsr', query: { route: '/dash', slots: '' } }) as any, res);

    expect(markLocallyActiveCalls).toEqual([['/dash', '']]);
    await fs.rm(pagesDir, { recursive: true, force: true });
  });

  it("scopes sseUserKey to identity only for bake='user' routes; shared routes always get userKey='' (Task 8)", async () => {
    // Regression: the SSE handler applied identity(req) to compute
    // sseUserKey for EVERY route regardless of that route's bake mode. With
    // an identity hook configured, subscribing to a SHARED route incorrectly
    // narrowed sseUserKey to the caller's identity, so that route's shared
    // (userKey='') patches never reached the subscriber. bakeByPattern gates
    // the identity lookup to bake='user' routes only.
    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-pages-'));
    await fs.writeFile(
      path.join(pagesDir, 'shared.ts'),
      "export const bake = 'shared';\nexport default function Page() { return null; }\n",
    );
    await fs.writeFile(
      path.join(pagesDir, 'priv.ts'),
      "export const bake = 'user';\nexport default function Page() { return null; }\n",
    );

    const sseRoutes = new Map<string, (req: any, res: any) => Promise<void>>();
    const markActiveCalls: [string, string][] = [];
    const fakeStore: any = {
      markActive: async (route: string, userKey = '') => {
        markActiveCalls.push([route, userKey]);
      },
    };
    const adapter: any = {
      registerPage: () => {},
      registerAction: () => {},
      registerSSE: (p: string, h: any) => { sseRoutes.set(p, h); },
      registerAsset: () => {},
      applyMiddleware: () => {},
      applyServerHooks: async () => {},
      listen: async () => {},
    };
    const identity = (req: any) => (req.locals as any).user ?? null;
    await startKiln(
      adapter,
      { cache: { provider: 'filesystem' } } as any,
      pagesDir,
      { store: fakeStore, identity: identity as any } as any,
    );

    const handler = sseRoutes.get('/__kiln/fsr');
    expect(handler).toBeDefined();

    const sharedRes = makeRes();
    await handler!(
      makeReq({ path: '/__kiln/fsr', query: { route: '/shared', slots: '' }, locals: { user: 'tom' } }) as any,
      sharedRes,
    );

    const userRes = makeRes();
    await handler!(
      makeReq({ path: '/__kiln/fsr', query: { route: '/priv', slots: '' }, locals: { user: 'tom' } }) as any,
      userRes,
    );

    expect(markActiveCalls).toEqual([
      ['/shared', ''], // shared route: identity present but bake !== 'user' -> ''
      ['/priv', 'tom'], // bake='user' route: identity applies
    ]);
    await fs.rm(pagesDir, { recursive: true, force: true });
  });
});
