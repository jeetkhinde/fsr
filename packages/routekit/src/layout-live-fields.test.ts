/**
 * A layout's scalar live fields must be registered under the PAGE's route.
 *
 * Before this, `lMod.load()` was called bare — no `withDepCapture` — and
 * `extractLiveFields` was only ever run over the page's own props, so a
 * `Live.value` returned by a layout got an `s-live` slot in the HTML (and the
 * browser client, which scans `[s-live]` document-wide, dutifully subscribed
 * to it) and then nothing on the server ever wrote a slot row or produced a
 * fresh value for it. These tests fail on that version: no upsert at all, so
 * both the registration and its auto-deps are absent.
 */
import { describe, it, expect } from 'bun:test';
import { buildPageHandler } from './boot.js';
import { extractLiveSlotNames } from './html-markers.js';
import { createCookies } from '@kiln/core';
import type { KilnRequest, KilnResponse } from '@kiln/core';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

function makeReq(overrides: Partial<KilnRequest> = {}): KilnRequest {
  return {
    path: '/dashboard',
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
    ...overrides,
  };
}

function makeRes(): any {
  const headers = new Headers();
  const res: any = { status: 200, headers, cookies: createCookies(headers), captured: null };
  res.html = (b: string) => {
    res.captured = { type: 'html', body: b };
  };
  res.json = (b: unknown) => {
    res.captured = { type: 'json', body: b };
  };
  res.redirect = () => {};
  res.sse = () => {};
  return res satisfies Partial<KilnResponse> as any;
}

type Upsert = { route: string; field: string; dependsOn: string[]; userKey: string };

function fakeStore(upserts: Upsert[]) {
  return {
    ensureRouteRow: async () => {},
    isTombstoned: async () => false,
    setBakedPaths: async () => {},
    touchRoute: async () => {},
    fetchSlotVersions: async () => ({}),
    upsertSlot: async (
      route: string,
      field: string,
      _value: unknown,
      _deps: unknown,
      dependsOn: string[],
      _debounce: unknown,
      _revalidate: unknown,
      userKey: string,
    ) => {
      upserts.push({ route, field, dependsOn, userKey });
    },
  } as any;
}

function fakeWatcher(loaders: { route: string; load: () => Promise<Record<string, unknown>> }[]) {
  return {
    hasRegisteredRoute: () => false,
    registerLoader: (input: any) => loaders.push(input),
    registerLiveList: async () => {},
  } as any;
}

/**
 * Layouts are loaded by `import(pathToFileURL(filePath))`, so the module has
 * to be a real file. It is written to a tmpdir, which node_modules resolution
 * can't reach from — hence the absolute specifiers baked into the source.
 */
async function writeLayout(dir: string, body: string): Promise<string> {
  const react = import.meta.resolve('react');
  const core = import.meta.resolve('@kiln/core');
  const sql = import.meta.resolve('@kiln/core/sql');
  const file = path.join(dir, 'layout.mjs');
  await fs.writeFile(
    file,
    `import { createElement } from ${JSON.stringify(react)};\n` +
      `import { Live } from ${JSON.stringify(core)};\n` +
      `import { collectDeps } from ${JSON.stringify(sql)};\n` +
      body,
    'utf8',
  );
  return file;
}

const PAGE_META = (layoutFile: string) => ({
  pattern: '/dashboard',
  layouts: [layoutFile],
  liveFields: [],
  hasEntries: false,
  filePath: '',
  relativePath: '',
});

describe('layout scalar live fields', () => {
  it('registers a layout live field under the page route, with the tables its own load() queried', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-layout-live-'));
    const layoutFile = await writeLayout(
      tmpDir,
      `export const load = async () => {\n` +
        `  collectDeps()?.add('notifications');\n` +
        `  return { unread: Live.value(3) };\n` +
        `};\n` +
        `export default ({ unread, children }) =>\n` +
        `  createElement('div', null, createElement('span', null, String(unread)), children);\n`,
    );
    const { createElement } = await import('react');
    const upserts: Upsert[] = [];
    const pageModule = {
      load: async () => ({ body: 'page' }),
      default: ({ body }: any) => createElement('p', null, body),
    };

    const handler = buildPageHandler(
      pageModule,
      PAGE_META(layoutFile) as any,
      [{ filePath: layoutFile, pattern: '/dashboard' } as any],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      fakeStore(upserts),
      fakeWatcher([]),
    );

    await handler(makeReq() as any, makeRes());

    expect(upserts).toEqual([
      { route: '/dashboard', field: 'unread', dependsOn: ['notifications'], userKey: '' },
    ]);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('keeps page and layout auto-deps separate', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-layout-live-'));
    const layoutFile = await writeLayout(
      tmpDir,
      `export const load = async () => {\n` +
        `  collectDeps()?.add('notifications');\n` +
        `  return { unread: Live.value(3) };\n` +
        `};\n` +
        `export default ({ unread, children }) =>\n` +
        `  createElement('div', null, createElement('span', null, String(unread)), children);\n`,
    );
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const { collectDeps } = await import('@kiln/core/sql');
    const upserts: Upsert[] = [];
    const pageModule = {
      load: async () => {
        collectDeps()?.add('tasks');
        return { openTasks: Live.value(7) };
      },
      default: ({ openTasks }: any) => createElement('p', null, String(openTasks)),
    };

    const handler = buildPageHandler(
      pageModule,
      PAGE_META(layoutFile) as any,
      [{ filePath: layoutFile, pattern: '/dashboard' } as any],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      fakeStore(upserts),
      fakeWatcher([]),
    );

    await handler(makeReq() as any, makeRes());

    const byField = Object.fromEntries(upserts.map((u) => [u.field, u.dependsOn]));
    // The whole point of capturing per segment: neither list may contain the
    // other's table, or a write to one would revalidate the wrong field.
    expect(byField.unread).toEqual(['notifications']);
    expect(byField.openTasks).toEqual(['tasks']);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("re-runs the layout's load() in the watcher loader so the field can actually change", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-layout-live-'));
    const layoutFile = await writeLayout(
      tmpDir,
      `let n = 0;\n` +
        `export const load = async () => ({ unread: Live.value(++n) });\n` +
        `export default ({ unread, children }) =>\n` +
        `  createElement('div', null, createElement('span', null, String(unread)), children);\n`,
    );
    const { createElement } = await import('react');
    const loaders: { route: string; load: () => Promise<Record<string, unknown>> }[] = [];
    const pageModule = {
      load: async () => ({ body: 'page' }),
      default: ({ body }: any) => createElement('p', null, body),
    };

    const handler = buildPageHandler(
      pageModule,
      PAGE_META(layoutFile) as any,
      [{ filePath: layoutFile, pattern: '/dashboard' } as any],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      fakeStore([]),
      fakeWatcher(loaders),
    );

    await handler(makeReq() as any, makeRes());

    expect(loaders).toHaveLength(1);
    const refreshed = await loaders[0].load();
    // Second call to the layout's load() → 2. A page-only loader would have
    // returned { body: 'page' } and no `unread` at all.
    expect(refreshed.unread).toBeDefined();
    expect(String((refreshed.unread as any)?.value ?? refreshed.unread)).toBe('2');
    expect(refreshed.body).toBe('page');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('wraps the outermost layout in a subscription container for its dom slots', async () => {
    // silcrow opens one connection per [data-kiln-live] element and only sees
    // slots inside that element. A layout's s-live span is outside the page
    // wrapper, so without a container on the layout nothing subscribes to it.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-layout-live-'));
    const layoutFile = await writeLayout(
      tmpDir,
      `export const load = async () => ({ unread: Live.value(3) });\n` +
        `export default ({ unread, children }) =>\n` +
        `  createElement('div', null, createElement('span', { 's-live': 'unread' }, String(unread)), children);\n`,
    );
    const { createElement } = await import('react');
    const pageModule = {
      load: async () => ({ body: 'page' }),
      default: ({ body }: any) => createElement('p', null, body),
    };

    const handler = buildPageHandler(
      pageModule,
      PAGE_META(layoutFile) as any,
      [{ filePath: layoutFile, pattern: '/dashboard' } as any],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      fakeStore([]),
      fakeWatcher([]),
    );

    const res = makeRes();
    await handler(makeReq() as any, res);

    const body: string = res.captured.body;
    expect(body).toContain('data-kiln-layout="/dashboard" data-kiln-live="/dashboard"');
    // The container must enclose the layout's slot, not sit beside it.
    expect(body.indexOf('data-kiln-live="/dashboard"')).toBeLessThan(
      body.indexOf('s-live="unread"'),
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it('adds no layout container when only the page has live fields', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-layout-live-'));
    const layoutFile = await writeLayout(
      tmpDir,
      `export const load = async () => ({ heading: 'Chrome' });\n` +
        `export default ({ children }) => createElement('div', null, children);\n`,
    );
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const pageModule = {
      load: async () => ({ hits: Live.value(4) }),
      default: ({ hits }: any) => createElement('p', { 's-live': 'hits' }, String(hits)),
    };

    const handler = buildPageHandler(
      pageModule,
      PAGE_META(layoutFile) as any,
      [{ filePath: layoutFile, pattern: '/dashboard' } as any],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      fakeStore([]),
      fakeWatcher([]),
    );

    const res = makeRes();
    await handler(makeReq() as any, res);

    // One container (the page wrapper), not two.
    expect(res.captured.body.match(/data-kiln-live="/g)).toHaveLength(1);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('subscribes a store-target layout field, which has no DOM slot to be found by', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-layout-live-'));
    const layoutFile = await writeLayout(
      tmpDir,
      `export const load = async () => ({ unread: Live.value(3, [], { target: 'store' }) });\n` +
        `export default ({ children }) => createElement('div', null, children);\n`,
    );
    const { createElement } = await import('react');
    const pageModule = {
      load: async () => ({ body: 'page' }),
      default: ({ body }: any) => createElement('p', null, body),
    };

    const handler = buildPageHandler(
      pageModule,
      PAGE_META(layoutFile) as any,
      [{ filePath: layoutFile, pattern: '/dashboard' } as any],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      fakeStore([]),
      fakeWatcher([]),
    );

    const res = makeRes();
    await handler(makeReq() as any, res);

    expect(res.captured.body).toContain('data-kiln-live-store="unread"');
    await fs.rm(tmpDir, { recursive: true });
  });
});

describe('extractLiveSlotNames', () => {
  it('returns each distinct slot once, in source order', () => {
    const html = '<span s-live="a">1</span><b s-live="b">2</b><i s-live="a">3</i>';
    expect(extractLiveSlotNames(html)).toEqual(['a', 'b']);
  });

  it('is empty for markup with no slots, and for nothing at all', () => {
    expect(extractLiveSlotNames('<p>hi</p>')).toEqual([]);
    expect(extractLiveSlotNames(null)).toEqual([]);
  });

  it('does not match a longer attribute that merely ends in s-live', () => {
    expect(extractLiveSlotNames('<span data-not-s-live="a">1</span>')).toEqual([]);
  });
});
