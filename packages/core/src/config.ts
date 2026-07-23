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

export interface LiveConfig {
  patchDebounceSeconds: number;
  purgeAfterSeconds: number;
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
  /** @deprecated Use purgeSweepSeconds. */
  idleEvictSecs?: number;
  /** @deprecated Use purgeAfterSeconds. */
  idleThresholdSecs?: number;
  postgresUrl?: string;
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

export type CacheProvider = 'memory' | 'filesystem' | 'sqlite' | 'redis';

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
  live: LiveConfig;
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
  // 'filesystem' is the only fully-implemented cold tier (Redis fronts it
  // when fsr.redisUrl / cache.url is set); 'memory' and 'sqlite' are typed
  // but not implemented, and startKiln rejects them at boot.
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
  live: {
    patchDebounceSeconds: 5,
    purgeAfterSeconds: 2_592_000, // 30 days
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
  if (config.live) {
    console.warn('[kiln] config.live is deprecated; use config.fsr');
    merged.live = { ...DEFAULT_CONFIG.live, ...config.live } as any;
  }
  // Always produce a fresh object here (not just when config.fsr is passed):
  // the live→fsr bridging below mutates merged.fsr in place, and if this
  // stayed conditional, merged.fsr would still alias DEFAULT_CONFIG.fsr
  // (from the shallow `{ ...DEFAULT_CONFIG }` spread above) whenever only
  // config.live was set — corrupting the shared DEFAULT_CONFIG singleton
  // for every future defineConfig() call in the process.
  merged.fsr = { ...DEFAULT_CONFIG.fsr, ...config.fsr } as any;
  if (config.live && config.fsr?.patchDebounceSecs === undefined) {
    merged.fsr.patchDebounceSecs = merged.live.patchDebounceSeconds;
  }
  if (config.live && config.fsr?.purgeAfterSeconds === undefined) {
    merged.fsr.purgeAfterSeconds = merged.live.purgeAfterSeconds;
  }
  if (config.fsr?.idleEvictSecs !== undefined) {
    console.warn('[kiln] config.fsr.idleEvictSecs is deprecated; use purgeSweepSeconds');
    merged.fsr.purgeSweepSeconds = config.fsr.idleEvictSecs;
  }
  if (config.fsr?.idleThresholdSecs !== undefined) {
    console.warn('[kiln] config.fsr.idleThresholdSecs is deprecated; use purgeAfterSeconds');
    merged.fsr.purgeAfterSeconds = config.fsr.idleThresholdSecs;
  }
  if (config.port !== undefined) merged.port = config.port;
  if (config.pagesDir !== undefined) merged.pagesDir = config.pagesDir as any;

  return merged;
}

export function loadConfigFromEnv(baseConfig: KilnConfig): KilnConfig {
  // Copy the sub-objects that get mutated below — a shallow spread would
  // alias them, so env overrides would bleed into baseConfig (and, when the
  // caller didn't override web/backend, into the shared DEFAULT_CONFIG).
  const config = {
    ...baseConfig,
    web: { ...baseConfig.web },
    backend: { ...baseConfig.backend },
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
  
  return config;
}
