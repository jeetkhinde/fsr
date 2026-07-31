import { createCookies } from '@kiln/core';
import type { KilnCookies, KilnRequest, KilnResponse, SSEEvent } from '@kiln/core';

export function wrapRequest(ctx: any): KilnRequest {
  const req = ctx.request as Request;
  const isEnhanced = req.headers.get('silcrow-target') !== null;
  const layoutsPresent = (req.headers.get('x-ps-present') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    path: ctx.path || new URL(req.url).pathname,
    method: req.method,
    params: ctx.params || {},
    query: ctx.query || {},
    headers: req.headers,
    signal: req.signal,
    formData: async () => {
      if (ctx.body instanceof FormData) {
        return ctx.body;
      }
      if (ctx.body && typeof ctx.body === 'object') {
        const fd = new FormData();
        Object.entries(ctx.body).forEach(([k, v]) => {
          if (Array.isArray(v)) {
            v.forEach((val) => fd.append(k, val instanceof Blob ? val : String(val)));
          } else {
            fd.append(k, v instanceof Blob ? v : String(v));
          }
        });
        return fd;
      }
      return req.formData();
    },
    json: async () => {
      if (ctx.body && typeof ctx.body === 'object') {
        return ctx.body;
      }
      return req.json();
    },
    isEnhanced,
    layoutsPresent,
    locals: {},
    raw: ctx,
    prebakeNext(path: string): void {
      ctx.set.headers['x-prebake-next'] = path;
    }
  };
}

export class ElysiaResponseImpl implements KilnResponse {
  public status = 200;
  // `headers` must be declared before `cookies` — createCookies binds to it.
  public headers = new Headers();
  public cookies: KilnCookies = createCookies(this.headers);
  public body?: any;
  public bodyType?: 'html' | 'json' | 'sse' | 'redirect' | 'binary';
  public redirectUrl?: string;

  constructor(private ctx: any) {}

  html(body: string): void {
    this.body = body;
    this.bodyType = 'html';
    this.ctx.set.headers['content-type'] = 'text/html; charset=utf-8';
  }

  json(body: unknown): void {
    this.body = body;
    this.bodyType = 'json';
    this.ctx.set.headers['content-type'] = 'application/json';
  }

  redirect(url: string, status = 303): void {
    this.status = status;
    this.redirectUrl = url;
    this.bodyType = 'redirect';
    this.ctx.set.status = status;
    this.ctx.set.headers['location'] = url;
  }

  sse(stream: AsyncIterable<SSEEvent>): void {
    this.body = stream;
    this.bodyType = 'sse';
  }

  binary(data: Buffer | ArrayBuffer): void {
    this.body = data instanceof Buffer ? data : Buffer.from(new Uint8Array(data));
    this.bodyType = 'binary';
  }
}

/** Copies a Headers onto Elysia's plain-record `ctx.set.headers`. Single-valued
 * names go across directly; set-cookie goes as a string[], which Elysia expands
 * into one header per entry (proved by multi-cookie.test.ts).
 *
 * ctx.set.headers stays a record on purpose: assigning a Headers instance to it
 * would make the record-style writes elsewhere in this file and in
 * middleware/compression.ts set plain JS properties instead of headers, and be
 * dropped with no type error and no runtime error. See spec §2.3. */
export function applyHeaders(headers: Headers, ctx: any): void {
  for (const [key, value] of headers) {
    if (key === 'set-cookie') continue;
    ctx.set.headers[key] = value;
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    ctx.set.headers['set-cookie'] = cookies;
  }
}

export function handleElysiaResponse(res: ElysiaResponseImpl, ctx: any) {
  if (res.status) {
    ctx.set.status = res.status;
  }
  applyHeaders(res.headers, ctx);

  if (res.bodyType === 'redirect') {
    return;
  }

  return res.body;
}
