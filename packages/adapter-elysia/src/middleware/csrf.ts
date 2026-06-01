import { Elysia } from 'elysia';

const FORM_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

function needsCsrfCheck(method: string, headers: Headers): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return false;
  }
  const ct = headers.get('content-type') || '';
  return FORM_CONTENT_TYPES.some((allowed) =>
    ct.trim().toLowerCase().startsWith(allowed)
  );
}

function getRequestHost(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host') || headers.get('host');
  return host ? host.toLowerCase() : null;
}

function parseHostFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

export const csrf = () => (app: Elysia) =>
  app.onBeforeHandle(({ request, set }) => {
    if (!needsCsrfCheck(request.method, request.headers)) {
      return;
    }

    const host = getRequestHost(request.headers);
    if (!host) {
      set.status = 403;
      return 'CSRF: missing Host header';
    }

    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');

    const originHost = origin && origin !== 'null' ? parseHostFromUrl(origin) : null;
    const refererHost = referer ? parseHostFromUrl(referer) : null;

    const matchedHost = originHost || refererHost;

    if (!matchedHost) {
      set.status = 403;
      return 'CSRF: missing Origin and Referer on state-changing request';
    }

    if (matchedHost !== host) {
      set.status = 403;
      return 'CSRF: cross-origin form submission blocked';
    }
  });
