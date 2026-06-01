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
});
