import { getSessionUser } from './lib/session.js';

// Paths reachable without a session (spec §4). Everything else — including
// promoted pages and /__kiln/fsr SSE — requires one. Elysia onRequest
// intercepts every route regardless of registration order (verified), so
// /api/auth/* and the login/logout form routes MUST be listed here.
const PUBLIC_PREFIXES = [
  '/api/auth/',
  '/auth/login',
  '/auth/logout',
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

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export async function onRequest(ctx: any): Promise<Response | void> {
  const url = new URL(ctx.request.url);
  if (isPublic(url.pathname)) return;

  const user = await getSessionUser(ctx.request.headers);
  if (user) return;

  if (wantsJson(ctx.request)) {
    return new Response(JSON.stringify({ error: 'Unauthorized', status: 401 }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 302, headers: { location: '/login' } });
}
