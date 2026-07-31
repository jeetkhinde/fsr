// Pure cookie serialization. No dependency on KilnResponse or any adapter, so
// this stays unit-testable on its own and safe on the client-reachable barrel.

export interface CookieOptions {
  /** Defaults to '/'. Without it the browser scopes the cookie to the request's
   * directory, so a session cookie set from POST /login would be confined to
   * /login and invisible everywhere else — a silent failure. */
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
}

export interface KilnCookies {
  set(name: string, value: string, opts?: CookieOptions): void;
  delete(name: string, opts?: Pick<CookieOptions, 'path' | 'domain'>): void;
}

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' } as const;

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${SAME_SITE[opts.sameSite]}`);
  return parts.join('; ');
}

/** Binds a KilnCookies façade to a Headers instance. Every adapter builds its
 * response cookies this way, so serialization lives in exactly one place. */
export function createCookies(headers: Headers): KilnCookies {
  return {
    set(name, value, opts) {
      headers.append('set-cookie', serializeCookie(name, value, opts));
    },
    delete(name, opts) {
      headers.append('set-cookie', serializeCookie(name, '', { ...opts, maxAge: 0 }));
    },
  };
}
