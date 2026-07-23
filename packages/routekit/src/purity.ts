import type { KilnRequest } from '@kiln/core';

/** Request fields whose values vary by caller identity or per-request input
 * that is NOT part of the route path. A load() that reads any of them
 * produces a personalized render whose output must never be cached under a
 * route-only key. `params` is deliberately absent: params derive from the
 * concrete path, which IS the cache key. */
const IDENTITY_FIELDS = new Set<PropertyKey>([
  'locals',
  'headers',
  'query',
  'raw',
  'formData',
  'json',
]);

export interface PurityTracker {
  proxied: KilnRequest;
  identityAccessed(): boolean;
}

export function createPurityTracker(req: KilnRequest): PurityTracker {
  let touched = false;
  const proxied = new Proxy(req, {
    get(target, prop, receiver) {
      if (IDENTITY_FIELDS.has(prop)) touched = true;
      const value = Reflect.get(target, prop, receiver);
      // Headers.get / formData / json must stay bound to the real object.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxied, identityAccessed: () => touched };
}
