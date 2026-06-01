import type { PilcrowRequest, PilcrowResponse, SSEEvent } from '@fsr/core';

export function wrapRequest(ctx: any): PilcrowRequest {
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
  };
}

export class ElysiaResponseImpl implements PilcrowResponse {
  public status = 200;
  public headers: Record<string, string> = {};
  public body?: any;
  public bodyType?: 'html' | 'json' | 'sse' | 'redirect';
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
}

export function sseToReadableStream(stream: AsyncIterable<SSEEvent>): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of stream) {
          let payload = '';
          if (chunk.event) payload += `event: ${chunk.event}\n`;
          if (chunk.id) payload += `id: ${chunk.id}\n`;
          if (chunk.retry !== undefined) payload += `retry: ${chunk.retry}\n`;
          
          const lines = chunk.data.split('\n');
          for (const line of lines) {
            payload += `data: ${line}\n`;
          }
          payload += '\n';
          
          controller.enqueue(encoder.encode(payload));
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });
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
  
  if (res.bodyType === 'sse') {
    ctx.set.headers['content-type'] = 'text/event-stream';
    ctx.set.headers['cache-control'] = 'no-cache';
    ctx.set.headers['connection'] = 'keep-alive';
    return new Response(sseToReadableStream(res.body), {
      status: res.status,
      headers: ctx.set.headers,
    });
  }
  
  return res.body;
}
