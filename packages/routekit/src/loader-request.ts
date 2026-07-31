// Synthetic KilnRequest/KilnResponse construction, extracted from boot.ts.
// These build the fake request objects used when nobody is actually asking:
// the watcher re-running a loader long after the original request ended, and
// startup prebakes that render purely for their cache side effect.
import { createCookies } from '@kiln/core';
import type { KilnRequest, KilnResponse } from '@kiln/core';

/**
 * A stripped request the watcher can safely re-run load() with long after the
 * original request ended. Only the route identity (path/params/query) is
 * kept — the first visitor's headers, cookies, and body must never leak into
 * a cache entry that is served to everyone.
 */
export function makeLoaderRequest(req: KilnRequest, includeLocals = false): KilnRequest {
  return {
    path: req.path,
    method: 'GET',
    params: { ...req.params },
    query: { ...req.query },
    headers: new Headers(),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    // Shared cache entries must never embed one visitor's identity, so locals
    // stay empty by default. bake='user' loaders opt in (includeLocals): the
    // snapshot being refreshed belongs to exactly this user, and the captured
    // identity is how the watcher re-runs load() as them. Captured at
    // registration — role changes propagate on the user's next real request.
    locals: includeLocals ? structuredClone(req.locals) : {},
    prebakeNext: () => {},
  };
}

export function makePrebakeRequest(
  concretePath: string,
  params: Record<string, string>,
): KilnRequest {
  return {
    path: concretePath,
    method: 'GET',
    params: { ...params },
    query: {},
    headers: new Headers(),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    locals: {},
    prebakeNext: () => {},
  };
}

/** Response sink for startup prebakes — the handler's side effect (writing
 * the cache) is the point; the rendered body has no recipient. */
export function makeNoopResponse(): KilnResponse {
  const headers = new Headers();
  return {
    status: 200,
    headers,
    cookies: createCookies(headers),
    html: () => {},
    json: () => {},
    redirect: () => {},
    sse: () => {},
  };
}
