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

function getRequestHost(headers: Headers, trustProxy: boolean): string | null {
  // x-forwarded-host is client-suppliable; only honor it when the deployment
  // explicitly says a trusted proxy sits in front and strips inbound copies.
  const host = (trustProxy ? headers.get('x-forwarded-host') : null) || headers.get('host');
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

export interface CsrfOptions {
  /** Honor x-forwarded-host for the host comparison. Default false. */
  trustProxy?: boolean;
}

export const csrf = (options: CsrfOptions = {}) => (app: Elysia) =>
  app.onBeforeHandle(({ request, set }) => {
    if (!needsCsrfCheck(request.method, request.headers)) {
      return;
    }

    const host = getRequestHost(request.headers, options.trustProxy === true);
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
