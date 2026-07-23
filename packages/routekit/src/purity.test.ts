import { describe, expect, it } from 'bun:test';
import { createPurityTracker } from './purity.js';
import type { KilnRequest } from '@kiln/core';

function makeReq(): KilnRequest {
  return {
    path: '/projects/7',
    method: 'GET',
    params: { id: '7' },
    query: { tab: 'open' },
    headers: new Headers({ accept: 'text/html' }),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    prebakeNext: () => {},
    locals: { user: { id: 'u1' } },
  } as unknown as KilnRequest;
}

describe('createPurityTracker', () => {
  it('stays pure when load() only reads path/method/params', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.path;
    void t.proxied.method;
    void t.proxied.params.id;
    expect(t.identityAccessed()).toBe(false);
  });

  it('flips on locals access', () => {
    const t = createPurityTracker(makeReq());
    void (t.proxied.locals as any).user;
    expect(t.identityAccessed()).toBe(true);
  });

  it('flips on query access', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.query.tab;
    expect(t.identityAccessed()).toBe(true);
  });

  it('flips on headers access', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.headers.get('accept');
    expect(t.identityAccessed()).toBe(true);
  });

  it('flips on body access and keeps methods bound to the real request', async () => {
    const t = createPurityTracker(makeReq());
    await t.proxied.formData(); // must not throw "illegal invocation"
    expect(t.identityAccessed()).toBe(true);
  });
});
