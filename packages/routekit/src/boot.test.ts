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
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = { status: 200, headers: {}, captured: null };
  res.html = (b: string) => { res.captured = { type: 'html', body: b }; };
  res.json = (b: unknown) => { res.captured = { type: 'json', body: b }; };
  res.redirect = (url: string) => { res.captured = { type: 'redirect', url }; };
  res.sse = () => {};
  return res;
}

describe('buildPageHandler', () => {
  it('returns JSON when Accept: application/json', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const pageModule = {
      load: async () => ({ contacts: [{ id: '1', name: 'Alice' }] }),
      default: ({ contacts }: any) => null,
    };
    const handler = buildPageHandler(pageModule, { pattern: '/contacts', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' }, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null });
    const req = makeReq({ headers: new Headers({ accept: 'application/json' }) });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.type).toBe('json');
    expect(res.captured.body).toEqual({ contacts: [{ id: '1', name: 'Alice' }] });
    await fs.rm(tmpDir, { recursive: true });
  });

  it('returns HTML when Accept: text/html with no layouts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const pageModule = {
      load: async () => ({ title: 'Hello' }),
      default: ({ title }: any) => createElement('h1', null, title),
    };
    const handler = buildPageHandler(pageModule, { pattern: '/about', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' }, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null });
    const req = makeReq({ path: '/about' });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.type).toBe('html');
    expect(res.captured.body).toContain('Hello');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('applies generated markers for Live.list output', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const { createElement } = await import('react');
    const { Live } = await import('@kiln/core');
    const pageModule = {
      load: async () => ({
        todos: Live.list<{ id: number; title: string; completed: boolean; status: string }>({
          key: (todo: { id: number }) => todo.id,
          dependsOn: 'another_table.col',
          initial: [
            { id: 1, title: 'Ship', completed: false, status: 'in_progress' },
          ],
          query: () => [],
        }),
      }),
      default: ({ todos }: any) => createElement(
        'ul',
        null,
        todos.map((todo: any) => createElement(
          'li',
          { key: todo.id },
          createElement('span', null, todo.title),
          createElement('span', null, todo.status),
        )),
      ),
    };
    const handler = buildPageHandler(pageModule, { pattern: '/todos', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' }, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null });
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
    };
    const watcher = {
      hasRegisteredRoute: () => false,
      registerLiveList: async (target: any, snapshot: any) => registrations.push({ target, snapshot }),
    };
    const pageModule = {
      load: async () => ({
        todos: Live.list<{ id: number; title: string }>({
          key: (todo) => todo.id,
          dependsOn: 'todo_events',
          query: ({ sql }) => {
            expect(sql).toBe('shared-sql');
            return [{ id: 1, title: 'From query' }];
          },
        }),
      }),
      default: ({ todos }: any) => createElement(
        'ul',
        null,
        todos.map((todo: any) => createElement('li', { key: todo.id }, createElement('span', null, todo.title))),
      ),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/todos', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      undefined,
      store as any,
      watcher as any,
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
      setBakedPaths: async () => {},
    };
    const makeWatcher = () => {
      let registered = false;
      return {
        hasRegisteredRoute: () => registered,
        registerLiveList: async () => { registered = true; },
      };
    };
    const pageModule = {
      promoteAfter: 0,
      load: async () => ({
        todos: Live.list<{ id: number; title: string }>({
          key: (todo) => todo.id,
          dependsOn: 'todo_events',
          query: () => [{ id: 1, title }],
        }),
      }),
      default: ({ todos }: any) => createElement('ul', null, todos.map((todo: any) => createElement('li', { key: todo.id }, todo.title))),
    };
    const meta = { pattern: '/restart', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' };
    const first = buildPageHandler(pageModule, meta, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null }, undefined, store as any, makeWatcher() as any);
    const firstRes = makeRes();
    await first(makeReq({ path: '/restart' }) as any, firstRes);
    expect(firstRes.captured.body).toContain('First process');

    title = 'Second process';
    const restarted = buildPageHandler(pageModule, meta, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null }, undefined, store as any, makeWatcher() as any);
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
          query: () => [],
        }),
      }),
      default: ({ todos }: any) => createElement('ul', null, todos),
    };
    const handler = buildPageHandler(
      pageModule,
      { pattern: '/external', layouts: [], liveFields: [], hasEntries: false, filePath: '', relativePath: '' },
      [],
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
      { fsr: { watcher: 'external' } } as any,
      { executeLiveListQuery: async () => [] } as any,
      {} as any,
    );

    await expect(handler(makeReq({ path: '/external' }) as any, makeRes())).rejects.toThrow(
      'Live.list requires config.fsr.watcher = "embedded"',
    );
    await fs.rm(tmpDir, { recursive: true });
  });
});
