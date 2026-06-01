import type { KilnRequest, KilnResponse, SSEEvent } from '@kiln/core';

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
    raw: ctx,
    prebakeNext(path: string): void {
      ctx.set.headers['x-prebake-next'] = path;
    },
  };
}

export class ElysiaResponseImpl implements KilnResponse {
  public status = 200;
  public headers: Record<string, string> = {};
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
    this.body = data instanceof Buffer ? data : Buffer.from(data);
    this.bodyType = 'binary';
  }
}

export function handleElysiaResponse(res: ElysiaResponseImpl, ctx: any) {
  if (res.status) {
    ctx.set.status = res.status;
  }
  for (const [key, value] of Object.entries(res.headers)) {
    ctx.set.headers[key] = value;
  }

  if (res.bodyType === 'redirect') {
    return;
  }

  return res.body;
}
