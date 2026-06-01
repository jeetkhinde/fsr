import { Elysia, sse, file } from 'elysia';
import type { ServerAdapter, KilnRequest, KilnResponse, MiddlewareConfig, SSEEvent } from '@kiln/core';
import { wrapRequest, ElysiaResponseImpl, handleElysiaResponse } from './context.js';
import { csrf, timeout, compression, layoutIntercept } from './middleware/index.js';
export class ElysiaAdapter implements ServerAdapter {
  public app: Elysia;

  constructor(options?: { elysia?: Elysia; bodyLimitBytes?: number }) {
    const limitBytes = options?.bodyLimitBytes ?? 2 * 1024 * 1024;
    this.app = options?.elysia ?? new Elysia({ serve: { maxRequestBodySize: limitBytes } });
  }

  registerPage(
    pattern: string,
    layouts: string[],
    handler: (req: KilnRequest, res: KilnResponse) => Promise<void>
  ): void {
    this.app.get(pattern, async (ctx) => {
      const req = wrapRequest(ctx);
      const res = new ElysiaResponseImpl(ctx);
      await handler(req, res);
      return handleElysiaResponse(res, ctx);
    });
  }

  registerAction(
    pattern: string,
    handler: (req: KilnRequest, res: KilnResponse) => Promise<void>
  ): void {
    this.app.post(pattern, async (ctx) => {
      const req = wrapRequest(ctx);
      const res = new ElysiaResponseImpl(ctx);
      await handler(req, res);
      return handleElysiaResponse(res, ctx);
    });
  }

  registerSSE(
    pattern: string,
    handler: (req: KilnRequest, res: KilnResponse) => Promise<void>
  ): void {
    this.app.get(pattern, async function* (ctx: any) {
      const req = wrapRequest(ctx);
      const res = new ElysiaResponseImpl(ctx);
      await handler(req, res);

      if (res.status && res.status !== 200) ctx.set.status = res.status;
      for (const [k, v] of Object.entries(res.headers)) ctx.set.headers[k] = v;

      if (res.bodyType === 'sse' && res.body) {
        for await (const event of res.body as AsyncIterable<SSEEvent>) {
          yield sse({
            data: event.data,
            ...(event.event && { event: event.event }),
            ...(event.id && { id: event.id }),
            ...(event.retry !== undefined && { retry: event.retry }),
          });
        }
      }
    });
  }

  registerAsset(urlPath: string, filePath: string): void {
    this.app.get(urlPath, () => file(filePath));
  }

  applyMiddleware(config: MiddlewareConfig): void {
    if (config.csrf !== false) {
      this.app.use(csrf());
    }

    if (config.timeoutMs !== undefined) {
      this.app.use(timeout(config.timeoutMs));
    } else {
      this.app.use(timeout());
    }

    if (config.compression !== false) {
      this.app.use(compression());
    }

    this.app.use(layoutIntercept());
  }

  async listen(port: number, callback?: (addr: string) => void): Promise<void> {
    this.app.listen(port, () => {
      const hostname = this.app.server?.hostname || 'localhost';
      const serverPort = this.app.server?.port || port;
      callback?.(`http://${hostname}:${serverPort}`);
    });

    const shutdown = async () => {
      await this.app.stop();
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}
