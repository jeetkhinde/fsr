import { LiveProp } from './live-prop.js';

// ── Request/Response abstractions (framework-agnostic) ──

export interface KilnRequest {
  path: string;
  method: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Headers;
  signal?: AbortSignal;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  isEnhanced: boolean; // silcrow-target header present
  layoutsPresent: string[]; // parsed from X-PS-Present
  raw?: any; // escape hatch for adapter-specific request object
  prebakeNext(path: string): void;
  /** Per-request scratch space populated by the app's `handle` hook (auth
   * user/session, request id, etc.) and read by load()/actions. SvelteKit's
   * `event.locals`. Always an object — the adapter initializes it to `{}`. */
  locals: Record<string, unknown>;
}

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface KilnResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | unknown | AsyncIterable<SSEEvent>;
  bodyType?: 'html' | 'json' | 'sse' | 'redirect' | 'binary';
  redirectUrl?: string;

  html(body: string): void;
  json(body: unknown): void;
  redirect(url: string, status?: number): void;
  sse(stream: AsyncIterable<SSEEvent>): void;
  /** Send raw binary data (images, files). Content-type must be set via headers. */
  binary?(data: Buffer | ArrayBuffer): void;
}

// ── App request hook ──

/**
 * The app's per-request hook (`handle` export in hooks.ts), run by the adapter
 * after it builds the KilnRequest and before the route's load()/action — for
 * every Kiln-registered route (pages, actions, SSE), including framework-internal
 * ones. This is the single place to do authentication: attach data by mutating
 * `req.locals` (e.g. `req.locals.user = ...`), and short-circuit the request by
 * writing to `res` (`res.redirect('/login')`, or `res.json()` + `res.status`).
 * If `res.bodyType` is set when it returns, the adapter sends that response and
 * skips the route handler. Return without touching `res` to continue.
 *
 * Adapter-agnostic by design: it receives the generic KilnRequest/KilnResponse,
 * never an Elysia context, so the contract holds across adapters.
 */
export type KilnHandle = (req: KilnRequest, res: KilnResponse) => void | Promise<void>;

// ── Middleware Configuration ──

export interface MiddlewareConfig {
  csrf?: boolean;
  timeoutMs?: number;
  bodyLimitBytes?: number;
  compression?: boolean;
  /** Log request/response lines. Off by default. */
  tracing?: boolean;
  /** Trust x-forwarded-host for CSRF host comparison. Only enable behind a
   * proxy that strips client-supplied forwarding headers. */
  trustProxy?: boolean;
}

// ── Server Adapter Interface ──

export interface ServerAdapter {
  /** Register a page route (GET) */
  registerPage(
    pattern: string,
    layouts: string[],
    handler: (req: KilnRequest, res: KilnResponse) => Promise<void>
  ): void;

  /** Register a POST action route */
  registerAction(pattern: string, handler: (req: KilnRequest, res: KilnResponse) => Promise<void>): void;

  /** Register an SSE endpoint */
  registerSSE(pattern: string, handler: (req: KilnRequest, res: KilnResponse) => Promise<void>): void;

  /** Register a static asset route */
  registerAsset(urlPath: string, filePath: string): void;

  /** Apply all middleware */
  applyMiddleware(config: MiddlewareConfig): void;

  /** Load and apply the project's server hooks file (hooks.ts at appRoot):
   * the per-request `handle` hook plus lifecycle `onError`/`onStart`/`onStop`,
   * when the adapter supports it. `handle` runs inside the request path (see
   * KilnHandle); the rest wire into the adapter's server lifecycle. */
  applyServerHooks?(appRoot: string): Promise<void>;

  /** Start the server. `host` binds a specific interface (default adapter-chosen). */
  listen(port: number, callback?: (addr: string) => void, host?: string): Promise<void>;
}

// ── Page & Route Metadata Definitions ──

export type LoadResult = Record<string, any | LiveProp<any>>;

export interface ActionHandler {
  (req: KilnRequest): Promise<any> | any;
}

export interface PageDefinition {
  promote_after?: number | false;
  revalidate?: number | false;
  debounce?: number;
  purge_after?: number;
  json_first?: boolean;
  /** @deprecated Use promote_after. */
  promoteAfter?: number;
  load?: (req: KilnRequest) => Promise<LoadResult> | LoadResult;
  actions?: Record<string, ActionHandler>;
  default: any; // React Component
}

export interface LayoutDefinition {
  promote_after?: number | false;
  revalidate?: number | false;
  debounce?: number;
  purge_after?: number;
  /** @deprecated Use promote_after. */
  promoteAfter?: number;
  load?: (req: KilnRequest) => Promise<LoadResult> | LoadResult;
  default: any; // React component with children prop
}

export interface LiveFieldMeta {
  name: string;
  revalidate?: number;
  debounce?: number;
  dependsOn?: string;
  deliveryTarget: 'dom' | 'dom-and-store' | 'store';
}
