import type { KilnIdentity } from '@kiln/core';
import type { KilnRequest, KilnResponse } from '@kiln/core';
import { getSessionUser } from './lib/session.js';

// Paths reachable without a session (spec §4). Everything else — including
// promoted pages and /__kiln/fsr SSE — requires one. `handle` runs for every
// Kiln-registered route (pages/actions/SSE), so these must be listed.
//
// NOTE: the better-auth handler (/api/auth/*) is a raw route registered via
// `server.setup` in kiln.config.ts (ADR-020) with `adapter.registerRaw`, NOT a
// Kiln route, so `handle` never runs for it — it's public by construction, and
// listing it here is belt-and-braces rather than the actual mechanism. Login/
// logout are Kiln actions on the /login page, so they ARE gated by `handle`
// and depend on '/login' staying in this list.
const PUBLIC_PREFIXES = [
  '/api/auth/',
  '/login',
  '/invite/',
  '/_silcrow/',
  '/_kiln/',
  '/assets/',
  '/favicon.ico',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function wantsJson(req: KilnRequest): boolean {
  const accept = req.headers.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

/**
 * Per-request auth hook (SvelteKit's `handle`). Runs inside the Kiln request
 * path after the KilnRequest is built. On an authenticated request it stashes
 * the resolved user on `req.locals.user` — computed once here, then read by
 * load()/actions via requireUser (no second session lookup). On an anonymous
 * request to a gated path it short-circuits: 401 JSON for API clients, else a
 * redirect to /login.
 */
export async function handle(req: KilnRequest, res: KilnResponse): Promise<void> {
  if (isPublic(req.path)) return;

  const user = await getSessionUser(req.headers);
  if (user) {
    req.locals.user = user;
    return;
  }

  if (wantsJson(req)) {
    res.status = 401;
    res.json({ error: 'Unauthorized', status: 401 });
    return;
  }
  res.redirect('/login', 302);
}

/** Stable per-user cache key for bake='user' pages (ADR-017). User id, never
 * the session token — sessions rotate and multiply per device. Runs after
 * `handle`, so req.locals.user is already resolved. */
export const identity: KilnIdentity = (req) =>
  (req.locals.user as { id: string } | undefined)?.id ?? null;
