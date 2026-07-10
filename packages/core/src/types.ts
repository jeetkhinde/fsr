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

  /** Load and apply the project's server hooks file (hooks.ts at appRoot:
   * onRequest/onError/onStart/onStop), when the adapter supports it. */
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
