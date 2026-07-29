export interface WebConfig {
  host: string;
  port: number;
  backendUrl: string;
  requestBodyLimitBytes: number;
  /** Per-request handler deadline (ms). Default 30000. */
  requestTimeoutMs?: number;
  /** Trust x-forwarded-host for CSRF host checks. Only enable behind a proxy
   * that strips client-supplied forwarding headers. Default false. */
  trustProxy?: boolean;
  /** Log request/response lines. Default false. */
  tracing?: boolean;
}

export interface BackendConfig {
  host: string;
  port: number;
}

export interface TriggerTableConfig {
  table: string;
  /** Dep key emitted on change; defaults to the table name. */
  depKey?: string;
  /** Column whose value scopes per-user invalidation (owner in the payload). */
  ownerColumn?: string;
  events?: ('insert' | 'update' | 'delete')[];
}

export interface FsrConfig {
  watcher: 'embedded' | 'external';
  pollIntervalMs: number;
  patchDebounceSecs: number;
  purgeAfterSeconds: number;
  maxSseConnections: number;
  connectionTtlSecs: number;
  keepaliveSecs: number;
  redisUrl?: string;
  artifactTtlSecs: number;
  purgeSweepSeconds: number;
  revalidateSeconds: number;
  /** Deploy fingerprint (e.g. git SHA). When set, baked snapshots record it
   * and a mismatch on read forces a re-bake — replaces the manual cache
   * flush across breaking deploys. */
  buildId?: string;
  postgresUrl?: string;
  /** Tables `kiln sync-triggers` installs/verifies `kiln_emit_event` triggers on. */
  triggerTables?: TriggerTableConfig[];
  /** Union tables observed via createKilnSql queries during a page's load()
   * into its live fields' depends_on. Default on; set false to opt out and
   * rely solely on each field's explicit dependsOn list. */
  autoDeps?: boolean;
  /** Only eagerly revalidate stale snapshots on routes active within this
   * many seconds (last_active_at). Dormant routes' stale snapshots are left
   * for lazy rebuild-on-read instead. Default 30 when unset (see initFsr). */
  activeWindowSecs?: number;
}

export interface ReactRuntimeConfig {
  ssr: boolean;
  nodeBin: string;
  concurrency: number;
}

export interface ClientRuntimeConfig {
  react: ReactRuntimeConfig;
  inlineRuntime: boolean;
}

export interface ImageConfig {
  enabled: boolean;
  cacheDir: string;
  domains: string[];
  maxWidth: number;
  maxHeight: number;
  quality: number;
  formats: string[];
  concurrency: number;
  staticDir: string;
}

export interface I18nConfig {
  defaultLocale: string;
  locales: string[];
  localesDir: string;
}

export type SwStrategy = 'network-first' | 'cache-first' | 'stale-while-revalidate';

export interface ServiceWorkerConfig {
  enabled: boolean;
  strategy: SwStrategy;
  precache: string[];
  exclude: string[];
  offlineFallback?: string;
}

/** Providers the runtime actually backs. 'memory' and 'sqlite' were
 * advertised here but never implemented — startKiln threw UnsupportedProvider
 * for both. The type no longer offers what does not exist; the runtime guard
 * stays, because a JS-authored config can still pass anything. */
export type CacheProvider = 'filesystem' | 'redis';

export interface CacheConfig {
  provider: CacheProvider;
  url?: string;
  path?: string;
  dir?: string;
  /** Per-app/deployment namespace for Redis keys and pub/sub channels. When
   * set, all keys/channels are prefixed `kiln:<namespace>:…` instead of
   * `kiln:…`, so multiple Kiln apps sharing one Redis logical DB don't
   * collide on shared route strings (e.g. two apps both caching `/`). Leave
   * unset for single-app deployments — keys stay `kiln:…` (unchanged).
   *
   * If the app also constructs its own `RedisCache` (e.g. to hand `redis` /
   * `watcher` into `startKiln()`, as `examples/address-book` does), pass this
   * SAME namespace string to that `RedisCache` constructor too — `startKiln()`
   * only threads it into the `KilnCache` it builds internally, not into an
   * app-supplied `RedisCache` instance. Mismatched namespaces between the two
   * would desync the watcher's pub/sub channel from the served cache keys. */
  namespace?: string;
}

export interface KilnConfig {
  web: WebConfig;
  backend: BackendConfig;
  cache: CacheConfig;
  serviceWorker: ServiceWorkerConfig;
  i18n: I18nConfig;
  images: ImageConfig;
  client: ClientRuntimeConfig;
  fsr: FsrConfig;
  port?: number;
  pagesDir?: string;
}

export const DEFAULT_CONFIG: KilnConfig = {
  web: {
    host: '127.0.0.1',
    port: 3000,
    backendUrl: 'http://127.0.0.1:4000',
    requestBodyLimitBytes: 2 * 1024 * 1024, // 2 MiB
  },
  backend: {
    host: '127.0.0.1',
    port: 4000,
  },
  // 'filesystem' is the only cold tier (Redis fronts it when fsr.redisUrl /
  // cache.url is set). CacheProvider no longer types 'memory'/'sqlite'; a
  // JS-authored config can still name them and startKiln rejects them at boot.
  cache: {
    provider: 'filesystem',
  },
  serviceWorker: {
    enabled: false,
    strategy: 'network-first',
    precache: [],
    exclude: [],
  },
  i18n: {
    defaultLocale: 'en',
    locales: [],
    localesDir: 'locales',
  },
  images: {
    enabled: false,
    cacheDir: '.kiln-image-cache',
    domains: [],
    maxWidth: 3840,
    maxHeight: 2160,
    quality: 75,
    formats: ['webp', 'jpeg'],
    concurrency: 4,
    staticDir: 'public',
  },
  client: {
    react: {
      ssr: false,
      nodeBin: 'node',
      concurrency: 4,
    },
    inlineRuntime: false,
  },
  fsr: {
    watcher: 'embedded',
    pollIntervalMs: 500,
    patchDebounceSecs: 5,
    purgeAfterSeconds: 2_592_000,
    purgeSweepSeconds: 3_600,
    revalidateSeconds: 300,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    artifactTtlSecs: 0,
  },
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export function defineConfig(config: DeepPartial<KilnConfig>): KilnConfig {
  const merged = { ...DEFAULT_CONFIG };
  
  if (config.web) merged.web = { ...DEFAULT_CONFIG.web, ...config.web } as any;
  if (config.backend) merged.backend = { ...DEFAULT_CONFIG.backend, ...config.backend } as any;
  if (config.cache) merged.cache = { ...DEFAULT_CONFIG.cache, ...config.cache } as any;
  if (config.serviceWorker) merged.serviceWorker = { ...DEFAULT_CONFIG.serviceWorker, ...config.serviceWorker } as any;
  if (config.i18n) merged.i18n = { ...DEFAULT_CONFIG.i18n, ...config.i18n } as any;
  if (config.images) merged.images = { ...DEFAULT_CONFIG.images, ...config.images } as any;
  if (config.client) {
    merged.client = {
      ...DEFAULT_CONFIG.client,
      ...config.client,
      react: { ...DEFAULT_CONFIG.client.react, ...config.client.react } as any,
    } as any;
  }
  // Always produce a fresh object here, not just when config.fsr is passed:
  // the shallow `{ ...DEFAULT_CONFIG }` spread above aliases DEFAULT_CONFIG.fsr,
  // so anything that later writes to merged.fsr — loadConfigFromEnv's overrides,
  // or a caller mutating the returned config — would corrupt the shared
  // singleton for every future defineConfig() call in the process.
  merged.fsr = { ...DEFAULT_CONFIG.fsr, ...config.fsr } as any;
  if (config.port !== undefined) merged.port = config.port;
  if (config.pagesDir !== undefined) merged.pagesDir = config.pagesDir as any;

  validateConfig(merged);
  return merged;
}

const SUPPORTED_IMAGE_FORMATS = ['webp', 'jpeg', 'png', 'avif'];

/**
 * Validates merged values, not keys — TypeScript already rejects typo'd keys
 * in a TS-authored config, but nothing caught out-of-range VALUES, which
 * surfaced later as obscure runtime failures. A JS-authored config has no
 * type-level net at all, which is the case this mainly protects.
 *
 * Every message names the offending key and the received value, so the fix is
 * obvious from the error alone.
 */
function validateConfig(c: KilnConfig): void {
  const fail = (key: string, received: unknown, expected: string): never => {
    throw new Error(
      `[kiln] invalid config: ${key} = ${JSON.stringify(received)} — expected ${expected}`,
    );
  };
  const port = (key: string, v: unknown) => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
      fail(key, v, 'an integer between 1 and 65535');
    }
  };
  const nonNegative = (key: string, v: unknown) => {
    if (v === undefined || v === false) return;
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0) {
      fail(key, v, 'a non-negative number');
    }
  };

  port('port', c.port);
  port('web.port', c.web?.port);
  port('backend.port', c.backend?.port);

  const quality = c.images?.quality;
  if (quality !== undefined) {
    if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 1 || quality > 100) {
      fail('images.quality', quality, 'an integer between 1 and 100');
    }
  }
  const formats = c.images?.formats;
  if (formats !== undefined) {
    if (!Array.isArray(formats)) fail('images.formats', formats, 'an array of format names');
    for (const f of formats) {
      if (!SUPPORTED_IMAGE_FORMATS.includes(f)) {
        fail('images.formats', f, `one of ${SUPPORTED_IMAGE_FORMATS.join(', ')}`);
      }
    }
  }

  // Second-based FSR knobs. `revalidateSeconds` accepts false (never
  // revalidate), which nonNegative allows through deliberately.
  nonNegative('fsr.patchDebounceSecs', c.fsr?.patchDebounceSecs);
  nonNegative('fsr.revalidateSeconds', c.fsr?.revalidateSeconds);
  nonNegative('fsr.purgeAfterSeconds', c.fsr?.purgeAfterSeconds);
  nonNegative('fsr.purgeSweepSeconds', c.fsr?.purgeSweepSeconds);
  nonNegative('fsr.activeWindowSecs', c.fsr?.activeWindowSecs);
  nonNegative('fsr.connectionTtlSecs', c.fsr?.connectionTtlSecs);
  nonNegative('fsr.keepaliveSecs', c.fsr?.keepaliveSecs);
  nonNegative('fsr.maxSseConnections', c.fsr?.maxSseConnections);
}

export function loadConfigFromEnv(baseConfig: KilnConfig): KilnConfig {
  // Copy the sub-objects that get mutated below — a shallow spread would
  // alias them, so env overrides would bleed into baseConfig (and, when the
  // caller didn't override web/backend, into the shared DEFAULT_CONFIG).
  const config = {
    ...baseConfig,
    web: { ...baseConfig.web },
    backend: { ...baseConfig.backend },
    // fsr and cache are copied for the same reason as web/backend above: the
    // overrides below mutate them, and a shallow spread would alias the
    // caller's objects (and, when unset, the shared DEFAULT_CONFIG).
    fsr: { ...baseConfig.fsr },
    cache: { ...baseConfig.cache },
  };

  if (process.env.KILN_WEB_HOST) {
    config.web.host = process.env.KILN_WEB_HOST;
  }
  if (process.env.KILN_WEB_PORT) {
    const port = parseInt(process.env.KILN_WEB_PORT, 10);
    if (!isNaN(port)) {
      config.web.port = port;
    } else {
      console.warn(`[kiln] KILN_WEB_PORT="${process.env.KILN_WEB_PORT}" is not a valid number; ignoring`);
    }
  }
  if (process.env.KILN_BACKEND_URL) {
    config.web.backendUrl = process.env.KILN_BACKEND_URL;
  }
  if (process.env.KILN_BACKEND_HOST) {
    config.backend.host = process.env.KILN_BACKEND_HOST;
  }
  if (process.env.KILN_BACKEND_PORT) {
    const port = parseInt(process.env.KILN_BACKEND_PORT, 10);
    if (!isNaN(port)) {
      config.backend.port = port;
    } else {
      console.warn(`[kiln] KILN_BACKEND_PORT="${process.env.KILN_BACKEND_PORT}" is not a valid number; ignoring`);
    }
  }

  // Deployment-critical values that previously had no override at all. These
  // are the ones you cannot commit to a config file: connection strings differ
  // per environment, and fsr.buildId is meant to be the per-deploy git SHA
  // that self-invalidates older artifacts (ADR-018).
  if (process.env.KILN_FSR_POSTGRES_URL) {
    config.fsr.postgresUrl = process.env.KILN_FSR_POSTGRES_URL;
  }
  if (process.env.KILN_FSR_REDIS_URL) {
    config.fsr.redisUrl = process.env.KILN_FSR_REDIS_URL;
  }
  if (process.env.KILN_FSR_BUILD_ID) {
    config.fsr.buildId = process.env.KILN_FSR_BUILD_ID;
  }
  if (process.env.KILN_CACHE_URL) {
    config.cache.url = process.env.KILN_CACHE_URL;
  }

  return config;
}
