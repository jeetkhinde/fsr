// Types shared between the page handler (page-render.ts) and app wiring
// (boot.ts). Extracted so neither module has to import the other for a type,
// which would make the decomposition circular.

export interface CacheOptions {
  redis: any | null;
  cacheDir: string;
  ttlSecs: number;
  /** See CacheConfig.namespace — prefixes Redis keys/channels `kiln:<ns>:…`. */
  namespace?: string;
}

/** Files a page falls back to when its handler throws (nearest _error.tsx /
 * _not-found.tsx up the directory tree, resolved at boot). */
export interface PageErrorFiles {
  errorFile?: string;
  notFoundFile?: string;
}
