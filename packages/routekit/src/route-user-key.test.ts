import { describe, expect, it } from 'bun:test';
import { createPatternMatcher } from './match-pattern.js';
import { resolveRouteUserKey } from './boot.js';

const bakeByPattern = new Map<string, any>([
  ['/projects/:id/activity', 'user'],
  ['/projects/:id/board', 'shared'],
  ['/settings', 'user'],
]);
const matcher = createPatternMatcher([...bakeByPattern.keys()]);
const req = { locals: { user: { id: 'u1' } } } as any;
const identity = (r: any) => (r.locals.user as { id: string } | undefined)?.id ?? null;

function resolve(route: string, opts: { identity?: any; req?: any } = {}) {
  return resolveRouteUserKey({
    route,
    matcher,
    bakeByPattern,
    identity: 'identity' in opts ? opts.identity : identity,
    req: opts.req ?? req,
  });
}

describe('resolveRouteUserKey', () => {
  // THE falsifier: on main's logic this returns '' because
  // bakeByPattern.get('/projects/42/activity') misses.
  it("returns the subscriber's uid for a dynamic bake='user' route", () => {
    expect(resolve('/projects/42/activity')).toBe('u1');
  });

  it("returns the uid for a static bake='user' route", () => {
    expect(resolve('/settings')).toBe('u1');
  });

  it("returns '' for a shared route even with an identity hook configured", () => {
    // Protects the guarantee at boot.ts:297-300 — a shared route must read the
    // shared row, or its patches never reach this subscriber.
    expect(resolve('/projects/42/board')).toBe('');
  });

  it("returns '' when no identity hook is configured", () => {
    expect(resolve('/projects/42/activity', { identity: undefined })).toBe('');
  });

  it("returns '' for an anonymous request", () => {
    expect(resolve('/projects/42/activity', { req: { locals: {} } })).toBe('');
  });

  it("returns '' and warns once for an unmatched route", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      expect(resolve('/no/such/route')).toBe('');
      expect(resolve('/no/such/route')).toBe('');
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((w) => w.includes('matches no registered route pattern'))).toHaveLength(1);
  });
});
