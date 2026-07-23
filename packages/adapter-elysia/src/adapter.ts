import { Elysia, sse, file } from 'elysia';
import type { ServerAdapter, KilnRequest, KilnResponse, KilnHandle, MiddlewareConfig, SSEEvent } from '@kiln/core';
import { wrapRequest, ElysiaResponseImpl, handleElysiaResponse } from './context.js';
import { csrf, timeout, withTimeout, compression, tracing, loadHooks, serverHooks } from './middleware/index.js';
export class ElysiaAdapter implements ServerAdapter {
  public app: Elysia;
  // Enforced by wrapping each page/action handler in withTimeout (SSE
  // streams are exempt — they're long-lived by design). An app-level
  // derive() cannot cancel a running handler, so the deadline lives here.
  private timeoutMs = 30000;
  // The app's per-request handle hook (from hooks.ts), run after wrapRequest
  // and before every route's handler so it can populate req.locals and gate.
  private appHandle?: KilnHandle;

  /** Run the app handle hook (if set). Returns true when it wrote a response
   * (res.bodyType set) — i.e. it short-circuited and the route handler must be
   * skipped; the caller sends `res` via handleElysiaResponse. */
  private async runHandle(req: KilnRequest, res: ElysiaResponseImpl): Promise<boolean> {
    if (!this.appHandle) return false;
    await this.appHandle(req, res);
    return res.bodyType !== undefined;
  }

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
      if (await this.runHandle(req, res)) return handleElysiaResponse(res, ctx);
      await withTimeout(handler(req, res), this.timeoutMs);
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
      if (await this.runHandle(req, res)) return handleElysiaResponse(res, ctx);
      await withTimeout(handler(req, res), this.timeoutMs);
      return handleElysiaResponse(res, ctx);
    });
  }

  registerSSE(
    pattern: string,
    handler: (req: KilnRequest, res: KilnResponse) => Promise<void>
  ): void {
    const self = this;
    this.app.get(pattern, async function* (ctx: any) {
      const req = wrapRequest(ctx);
      const res = new ElysiaResponseImpl(ctx);
      // Gate the stream through the app handle hook. On short-circuit (e.g.
      // an unauthenticated EventSource → redirect), emit status/headers and
      // yield nothing rather than opening a stream. res.redirect/json already
      // set ctx.set.status + location; mirror status defensively.
      if (await self.runHandle(req, res)) {
        if (res.status) ctx.set.status = res.status;
        for (const [k, v] of Object.entries(res.headers)) ctx.set.headers[k] = v;
        return;
      }
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
      this.app.use(csrf({ trustProxy: config.trustProxy === true }));
    }

    if (config.timeoutMs !== undefined) {
      this.timeoutMs = config.timeoutMs;
    }
    this.app.use(timeout());

    if (config.compression !== false) {
      this.app.use(compression());
    }

    if (config.tracing === true) {
      this.app.use(tracing());
    }
  }

  /** Load hooks.ts from the app root (if present): store its per-request
   * `handle` hook (invoked by registerPage/registerAction/registerSSE) and
   * wire onError/onStart/onStop into the Elysia lifecycle. Must be called
   * before routes are registered so `handle` covers them. */
  async applyServerHooks(appRoot: string): Promise<{ identity?: import('@kiln/core').KilnIdentity }> {
    const hooks = await loadHooks(appRoot);
    this.appHandle = hooks.handle;
    this.app.use(serverHooks(hooks));
    // Returned so startKiln can thread hooks the FRAMEWORK consumes (identity
    // for bake='user' cache keys) into its handlers — unlike `handle`, which
    // the adapter itself invokes per request.
    return { identity: hooks.identity };
  }

  async listen(port: number, callback?: (addr: string) => void, host?: string): Promise<void> {
    const listenOpts = host ? { port, hostname: host } : port;
    this.app.listen(listenOpts as any, () => {
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
