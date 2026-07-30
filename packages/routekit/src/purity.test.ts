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

// ADR-011 enforcement. A layout is cached per route PATTERN plus the concrete
// values of the dynamic segments THAT PATTERN OWNS. So a layout's load() may
// read its own params — they are in the key — but reading a DESCENDANT page's
// param, or req.path, produces output that varies by something absent from the
// key, and one instance's chrome would be served for all of them.
//
// The base tracker deliberately does not treat `params` as an identity field
// ("params derive from the concrete path, which IS the cache key"), which is
// true for a PAGE and for a layout's own params, and false for a descendant's.
// Layout mode closes exactly that gap.
describe('createPurityTracker — layout mode (ADR-011)', () => {
  const ownsId = { layoutPattern: '/projects/:id', layoutParamNames: ['id'] };
  const ownsNothing = { layoutPattern: '/contacts', layoutParamNames: [] };

  it('allows a layout to read a param its own pattern owns', () => {
    const t = createPurityTracker(makeReq(), ownsId);
    void t.proxied.params.id;
    expect(t.identityAccessed()).toBe(false);
    expect(t.scopeViolation()).toBeNull();
  });

  it('flags a layout reading a param it does NOT own', () => {
    // '/contacts' owns no params, but the concrete request is /contacts/7 so
    // req.params.id is populated — this is the ContactsLayout shape.
    const t = createPurityTracker(makeReq(), ownsNothing);
    void t.proxied.params.id;
    expect(t.identityAccessed()).toBe(true);
    expect(t.scopeViolation()).toMatch(/params\.id/);
  });

  it('flags a layout reading req.path', () => {
    const t = createPurityTracker(makeReq(), ownsNothing);
    void t.proxied.path;
    expect(t.identityAccessed()).toBe(true);
    expect(t.scopeViolation()).toMatch(/req\.path/);
  });

  it('flags spreading req.params, which reads descendant params wholesale', () => {
    const t = createPurityTracker(makeReq(), ownsNothing);
    void { ...t.proxied.params };
    expect(t.identityAccessed()).toBe(true);
    expect(t.scopeViolation()).toMatch(/params/);
  });

  it('does not flag spreading req.params when the layout owns every key present', () => {
    const t = createPurityTracker(makeReq(), ownsId);
    void { ...t.proxied.params };
    expect(t.identityAccessed()).toBe(false);
  });

  it('leaves page mode (no options) unchanged — params and path stay pure', () => {
    const t = createPurityTracker(makeReq());
    void t.proxied.params.id;
    void t.proxied.path;
    expect(t.identityAccessed()).toBe(false);
    expect(t.scopeViolation()).toBeNull();
  });

  it('still flags ordinary identity fields in layout mode', () => {
    const t = createPurityTracker(makeReq(), ownsId);
    void t.proxied.query.tab;
    expect(t.identityAccessed()).toBe(true);
    // query is impurity, not an ADR-011 scope violation — keep them distinct
    // so the warning can name the right problem.
    expect(t.scopeViolation()).toBeNull();
  });
});
