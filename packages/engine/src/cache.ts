import type { RedisClient } from 'bun';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BAKED_RENDER_VERSION } from './baking.js';

export interface KilnCacheOptions {
  redis: RedisClient | null;
  cacheDir: string;
  ttlSecs: number;
  /** Optional per-app/deployment namespace. When set, all Redis keys and
   * pub/sub channels are prefixed `kiln:<namespace>:…` instead of `kiln:…`,
   * so multiple Kiln apps sharing one Redis logical DB don't collide on
   * shared route strings (e.g. two apps both caching `/`). Unset keeps the
   * historical `kiln:…` keys, so existing deployments are unaffected. */
  namespace?: string;
}

function safeVariant(v: string): string {
  return v.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

/** Path params as the router produces them (`req.params`). */
export type LayoutParams = Record<string, string | undefined>;

/**
 * Names of the dynamic segments a layout pattern owns, in order — `:id` →
 * `id`, catch-all `*` → `*`. Deliberately derived from the LAYOUT's pattern,
 * not the page's: a descendant page's extra params must not enter the layout's
 * cache key, or `/projects/:id` would bake separately for `/projects/7/board`
 * and `/projects/7/activity` and lose the sharing ADR-011 exists for.
 */
export function layoutParamNames(pattern: string): string[] {
  return pattern
    .split('/')
    .filter((seg) => seg.startsWith(':') || seg === '*')
    .map((seg) => (seg === '*' ? '*' : seg.slice(1)));
}

/**
 * Stable token identifying one concrete instance of a dynamic layout pattern,
 * or null for a static pattern (which has exactly one instance and keeps its
 * historical, suffix-free key).
 *
 * The raw joined value is sanitised for disk/Redis safety AND hashed: the
 * sanitiser maps distinct params onto the same string (`a/b` and `a_b`), so
 * without the hash two different projects could still share one cache entry —
 * the very bug this key exists to fix. Both the disk path and the Redis key
 * derive from this one token so the two key spaces can never disagree about
 * which instance an entry belongs to.
 */
export function layoutInstanceToken(pattern: string, params?: LayoutParams): string | null {
  const names = layoutParamNames(pattern);
  if (names.length === 0) return null;
  const raw = names.map((n) => `${n}=${params?.[n] ?? ''}`).join('&');
  return `${safeVariant(raw)}-${Bun.hash(raw).toString(36)}`;
}

/** Root prefix for every Redis key/channel. `kiln` when no namespace is set
 * (backward-compatible), else `kiln:<namespace>`. Shared by KilnCache,
 * RedisCache, and the SSE hub so a given namespace produces one consistent
 * key space. */
export function cacheKeyPrefix(namespace?: string): string {
  return namespace ? `kiln:${namespace}` : 'kiln';
}

export class KilnCache {
  private redis: RedisClient | null;
  private readonly cacheDir: string;
  private readonly ttlSecs: number;
  private readonly keyPrefix: string;

  constructor(opts: KilnCacheOptions) {
    this.redis = opts.redis;
    this.cacheDir = opts.cacheDir;
    this.ttlSecs = opts.ttlSecs;
    this.keyPrefix = cacheKeyPrefix(opts.namespace);
  }

  diskHtmlPath(route: string, variant?: string): string {
    const safe = route === '/' ? 'index' : route.replace(/^\//, '').replace(/\//g, path.sep);
    if (variant) {
      return path.join(this.cacheDir, safe, '_v', safeVariant(variant), 'index.html');
    }
    return path.join(this.cacheDir, safe, 'index.html');
  }

  // ---------------------------------------------------------------------
  // Layout-level cache: keyed by the LAYOUT's own pattern (e.g. "/dashboard")
  // plus the concrete values of the dynamic segments THAT pattern owns, not
  // by the concrete route being served. A layout that only depends on its own
  // pattern's params (never req.query, never a descendant page's params — see
  // ADR-011) bakes once per distinct value of those params and is shared by
  // every route underneath it, instead of being re-baked into every route's
  // own page-level cache entry. A static pattern owns no params, so it keeps
  // exactly one entry (and the same key it has always had); `/projects/:id`
  // gets one entry per concrete id, still shared across `/projects/7/board`
  // and `/projects/7/activity`.
  //
  // The params are in the key because ADR-011's rule explicitly licenses a
  // layout to read its own pattern's `req.params`. Keying on the pattern
  // string ALONE (as this did until 2026-07-28) contradicted that: the string
  // is identical for every concrete instance, so one entry was shared by all
  // of them and the first-baked project's chrome leaked into every other
  // project's page — bodies correct, layout wrong.
  // ---------------------------------------------------------------------

  // Layout entries embed markup conventions (marker attributes, outlet
  // wrapping) that page snapshots version via BAKED_RENDER_VERSION — but a
  // page's layoutSignature compares the layout cache against ITSELF, so it
  // can never detect that the cached layout was baked by an older Kiln.
  // Versioning the keys/paths makes every render-version bump miss cleanly
  // and re-bake layouts too. Older-version entries are simply orphaned
  // (small; disk under layouts/v<N>, Redis keys age out via server TTL
  // policy or manual cleanup).
  /** Directory holding every entry for one layout pattern. Nested layout
   * patterns cache in SUBDIRECTORIES of it (`/projects/:id` and
   * `/projects/:id/settings`), so this dir is never removed wholesale — see
   * deleteLayout. */
  private diskLayoutPatternDir(pattern: string): string {
    const safe = pattern === '/' ? 'index' : pattern.replace(/^\//, '').replace(/\//g, path.sep);
    return path.join(this.cacheDir, 'layouts', `v${BAKED_RENDER_VERSION}`, safe);
  }

  diskLayoutHtmlPath(pattern: string, params?: LayoutParams): string {
    const dir = this.diskLayoutPatternDir(pattern);
    const token = layoutInstanceToken(pattern, params);
    // `_i` mirrors the page cache's `_v` variant subdirectory: a fixed
    // segment that can never collide with a nested layout pattern's own
    // directory (route segments never start with an underscore).
    return token ? path.join(dir, '_i', token, 'shell.html') : path.join(dir, 'shell.html');
  }

  diskLayoutJsonPath(pattern: string, params?: LayoutParams): string {
    return this.diskLayoutHtmlPath(pattern, params).replace(/\.html$/, '.json');
  }

  /** Namespaced key for the cross-process SSE connection set. Exposed so the
   * hub tracks connections per namespace — two apps sharing one Redis must not
   * share a connection cap.
   *
   * A sorted set, not the counter this replaced: see createRedisAdmission. The
   * key name changed with the type, so the legacy `…:fsr:active-connections`
   * string is simply abandoned (a stale one can be deleted at leisure — it is
   * never read again, and reusing the name would only earn a WRONGTYPE). */
  fsrConnectionsKey(): string {
    return `${this.keyPrefix}:fsr:connections`;
  }

  private redisLayoutHtmlKey(pattern: string, params?: LayoutParams): string {
    const token = layoutInstanceToken(pattern, params);
    const base = `${this.keyPrefix}:layout:html:v${BAKED_RENDER_VERSION}:${pattern}`;
    return token ? `${base}|${token}` : base;
  }
  private redisLayoutJsonKey(pattern: string, params?: LayoutParams): string {
    const token = layoutInstanceToken(pattern, params);
    const base = `${this.keyPrefix}:layout:json:v${BAKED_RENDER_VERSION}:${pattern}`;
    return token ? `${base}|${token}` : base;
  }

  async getLayoutHtml(pattern: string, params?: LayoutParams): Promise<string | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisLayoutHtmlKey(pattern, params));
        if (v != null) return v;
      } catch (err) { this.warnRedisError('getLayoutHtml', pattern, err); }
    }
    const f = Bun.file(this.diskLayoutHtmlPath(pattern, params));
    return (await f.exists()) ? f.text() : null;
  }

  async setLayoutHtml(pattern: string, html: string, params?: LayoutParams): Promise<void> {
    await atomicWrite(this.diskLayoutHtmlPath(pattern, params), html);
    if (this.redis) {
      try {
        await this.redis.set(this.redisLayoutHtmlKey(pattern, params), html);
      } catch (err) { this.warnRedisError('setLayoutHtml', pattern, err); }
    }
  }

  async getLayoutJson(pattern: string, params?: LayoutParams): Promise<unknown | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisLayoutJsonKey(pattern, params));
        if (v != null) return JSON.parse(v);
      } catch (err) { this.warnRedisError('getLayoutJson', pattern, err); }
    }
    const f = Bun.file(this.diskLayoutJsonPath(pattern, params));
    if (!(await f.exists())) return null;
    try { return JSON.parse(await f.text()); } catch { return null; }
  }

  async setLayoutJson(pattern: string, data: unknown, params?: LayoutParams): Promise<void> {
    const json = JSON.stringify(data);
    await atomicWrite(this.diskLayoutJsonPath(pattern, params), json);
    if (this.redis) {
      try {
        await this.redis.set(this.redisLayoutJsonKey(pattern, params), json);
      } catch (err) { this.warnRedisError('setLayoutJson', pattern, err); }
    }
  }

  /** Invalidate a layout's cache — e.g. after a deploy that changes its
   * source. Every route under that layout picks up the change on its next
   * request; no per-route re-bake needed.
   *
   * With `params`, only that one concrete instance is dropped. Without them
   * (the deploy case), EVERY instance of a dynamic pattern goes: the source
   * changed, so no instance's artifact is still valid, and a caller who only
   * knows the pattern has no way to enumerate the ids. */
  async deleteLayout(pattern: string, params?: LayoutParams): Promise<void> {
    const isDynamic = layoutParamNames(pattern).length > 0;
    if (isDynamic && !params) {
      // Only the `_i` subtree — the pattern dir itself holds NESTED layout
      // patterns' directories, which an rm -r would wipe along with it.
      await fs.rm(path.join(this.diskLayoutPatternDir(pattern), '_i'), { recursive: true, force: true }).catch(() => {});
      // Also the suffix-free entry a pre-instance-key Kiln wrote for this
      // pattern: nothing reads it any more, but a deploy-time invalidation is
      // the natural moment to reclaim it.
      await Promise.allSettled([
        fs.unlink(path.join(this.diskLayoutPatternDir(pattern), 'shell.html')).catch(() => {}),
        fs.unlink(path.join(this.diskLayoutPatternDir(pattern), 'shell.json')).catch(() => {}),
      ]);
      if (this.redis) {
        try {
          await this.redis.send('DEL', [this.redisLayoutHtmlKey(pattern), this.redisLayoutJsonKey(pattern)]);
        } catch (err) { this.warnRedisError('deleteLayout', pattern, err); }
        await this.deleteRedisKeysMatching(
          [`${this.redisLayoutHtmlKey(pattern)}|*`, `${this.redisLayoutJsonKey(pattern)}|*`],
          pattern,
        );
      }
      return;
    }
    await Promise.allSettled([
      fs.unlink(this.diskLayoutHtmlPath(pattern, params)).catch(() => {}),
      fs.unlink(this.diskLayoutJsonPath(pattern, params)).catch(() => {}),
    ]);
    if (this.redis) {
      try {
        await this.redis.send('DEL', [
          this.redisLayoutHtmlKey(pattern, params),
          this.redisLayoutJsonKey(pattern, params),
        ]);
      } catch (err) { this.warnRedisError('deleteLayout', pattern, err); }
    }
  }

  /** SCAN + DEL for the glob patterns given. SCAN (never KEYS) so a large
   * keyspace doesn't block Redis; a cursor that never returns to 0 (a Redis
   * that keeps rehashing) is bounded by the iteration cap rather than looping
   * forever — leftovers are re-collected by the next call. */
  private async deleteRedisKeysMatching(globs: string[], logRoute: string): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    for (const glob of globs) {
      let cursor = '0';
      let iterations = 0;
      try {
        do {
          const reply = (await redis.send('SCAN', [cursor, 'MATCH', glob, 'COUNT', '100'])) as
            | [string, string[]]
            | null;
          if (!Array.isArray(reply)) break;
          cursor = String(reply[0]);
          const keys = reply[1] ?? [];
          if (keys.length > 0) await redis.send('DEL', keys);
        } while (cursor !== '0' && ++iterations < 1000);
      } catch (err) { this.warnRedisError('deleteLayout', logRoute, err); }
    }
  }

  diskJsonPath(route: string, variant?: string): string {
    return this.diskHtmlPath(route, variant).replace(/\.html$/, '.json');
  }

  private redisHtmlKey(route: string, variant?: string): string {
    return variant ? `${this.keyPrefix}:html:${route}:v:${safeVariant(variant)}` : `${this.keyPrefix}:html:${route}`;
  }

  private redisJsonKey(route: string, variant?: string): string {
    return variant ? `${this.keyPrefix}:json:${route}:v:${safeVariant(variant)}` : `${this.keyPrefix}:json:${route}`;
  }

  async getHtml(route: string, variant?: string): Promise<string | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisHtmlKey(route, variant));
        if (v != null) return v;
      } catch (err) { this.warnRedisError('getHtml', route, err); }
    }
    const f = Bun.file(this.diskHtmlPath(route, variant));
    return (await f.exists()) ? f.text() : null;
  }

  async setHtml(route: string, html: string, pinInRedis = false, variant?: string): Promise<void> {
    const diskPath = this.diskHtmlPath(route, variant);
    await atomicWrite(diskPath, html);
    if (this.redis) {
      try {
        const key = this.redisHtmlKey(route, variant);
        // pinInRedis skips the TTL so the entry never evicts; otherwise it
        // follows the same ttlSecs policy as JSON snapshots. SET...EX is a
        // single atomic command — a separate SET + expire() pair can leave
        // an immortal key if the process dies between the two calls.
        if (!pinInRedis && this.ttlSecs > 0) {
          await this.redis.send('SET', [key, html, 'EX', String(this.ttlSecs)]);
        } else {
          await this.redis.set(key, html);
        }
      } catch (err) { this.warnRedisError('setHtml', route, err); }
    }
  }

  async getJson(route: string, variant?: string): Promise<unknown | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisJsonKey(route, variant));
        if (v != null) return JSON.parse(v);
      } catch (err) { this.warnRedisError('getJson', route, err); }
    }
    const f = Bun.file(this.diskJsonPath(route, variant));
    if (!(await f.exists())) return null;
    try { return JSON.parse(await f.text()); } catch { return null; }
  }

  async setJson(route: string, data: unknown, variant?: string): Promise<void> {
    const json = JSON.stringify(data);
    await atomicWrite(this.diskJsonPath(route, variant), json);
    if (this.redis) {
      try {
        const key = this.redisJsonKey(route, variant);
        if (this.ttlSecs > 0) {
          await this.redis.send('SET', [key, json, 'EX', String(this.ttlSecs)]);
        } else {
          await this.redis.set(key, json);
        }
      } catch (err) { this.warnRedisError('setJson', route, err); }
    }
  }

  async patchJsonField(route: string, field: string, value: unknown, variant?: string): Promise<void> {
    const existing = (await this.getJson(route, variant)) as Record<string, unknown> | null;
    if (!existing) return;
    const target =
      existing.data && typeof existing.data === 'object' && !Array.isArray(existing.data)
        ? existing.data as Record<string, unknown>
        : existing;
    target[field] = value;
    // The cached-JSON fast path (Accept: application/json on a baked route)
    // serves `pageData`, not `data` — without also patching this sibling
    // object, a live patch would go stale there even though `data` (and the
    // HTML shell) stayed fresh.
    if (existing.pageData && typeof existing.pageData === 'object' && !Array.isArray(existing.pageData)) {
      (existing.pageData as Record<string, unknown>)[field] = value;
    }
    if ('updatedAt' in existing) existing.updatedAt = new Date().toISOString();
    await this.setJson(route, existing, variant);
  }

  async delete(route: string, variant?: string): Promise<void> {
    if (variant) {
      const htmlPath = this.diskHtmlPath(route, variant);
      const jsonPath = this.diskJsonPath(route, variant);
      await Promise.allSettled([
        fs.unlink(htmlPath).catch(() => {}),
        fs.unlink(jsonPath).catch(() => {}),
      ]);
      if (this.redis) {
        try {
          await this.redis.send('DEL', [this.redisHtmlKey(route, variant), this.redisJsonKey(route, variant)]);
        } catch (err) { this.warnRedisError('delete', route, err); }
      }
    } else {
      // Delete the base files and this route's variant subtree only. The
      // route directory itself must survive: nested routes cache inside
      // subdirectories of it (e.g. /foo/bar lives at foo/bar/index.html),
      // so an rm -r of the whole dir would wipe every descendant's cache.
      const htmlPath = this.diskHtmlPath(route);
      const variantDir = path.join(path.dirname(htmlPath), '_v');
      await Promise.allSettled([
        fs.unlink(htmlPath).catch(() => {}),
        fs.unlink(this.diskJsonPath(route)).catch(() => {}),
        fs.rm(variantDir, { recursive: true, force: true }).catch(() => {}),
      ]);
      if (this.redis) {
        try {
          await this.redis.send('DEL', [this.redisHtmlKey(route), this.redisJsonKey(route)]);
          // Variant Redis keys expire via ttlSecs (wired from
          // config.fsr.artifactTtlSecs in startKiln); no SCAN needed for v1.
        } catch (err) { this.warnRedisError('delete', route, err); }
      }
    }
  }

  async purgeRoute(route: string): Promise<void> {
    await this.delete(route);
  }

  getClient(): RedisClient | null { return this.redis; }

  /**
   * Log and fall through to disk on a Redis error, without permanently
   * discarding the client. `KilnCache` instances are long-lived (one per
   * route, for the life of the process — see buildPageHandler), so nulling
   * out `this.redis` on the first transient error used to disable Redis for
   * that route forever, until a restart. Bun's RedisClient already handles
   * its own reconnection, so simply retrying on the next call is preferable.
   */
  private warnRedisError(op: string, route: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[kiln] KilnCache.${op} Redis error for route "${route}", falling back to disk: ${message}`);
  }
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await Bun.write(tempPath, content);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Legacy RedisCache — kept for watcher.ts/hub.ts compatibility until migration
// ---------------------------------------------------------------------------
import { RedisClient as BunRedisClient } from 'bun';

export class RedisCache {
  private client: BunRedisClient;
  private artifactTtlSecs = 0;
  private readonly keyPrefix: string;

  constructor(url: string, namespace?: string) {
    this.keyPrefix = cacheKeyPrefix(namespace);
    try {
      this.client = new BunRedisClient(url);
    } catch (err) {
      throw new Error(`[kiln] RedisCache: failed to construct Redis client for "${url}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Pub/sub channel names — exposed so subscribers (e.g. FsrWatcher) resolve
   * the same namespaced channel this instance publishes to. */
  invalidateChannel(): string {
    return `${this.keyPrefix}:invalidate`;
  }
  patchChannel(): string {
    return `${this.keyPrefix}:patch`;
  }

  withArtifactTtl(ttlSecs: number): this {
    this.artifactTtlSecs = ttlSecs;
    return this;
  }

  getClient(): BunRedisClient {
    return this.client;
  }

  private htmlKey(route: string, variant?: string): string {
    return variant ? `${this.keyPrefix}:html:${route}:v:${safeVariant(variant)}` : `${this.keyPrefix}:html:${route}`;
  }

  private slotKey(route: string, variant?: string): string {
    return variant ? `${this.keyPrefix}:slot:${route}:v:${safeVariant(variant)}` : `${this.keyPrefix}:slot:${route}`;
  }

  private jsonKey(route: string, variant?: string): string {
    return variant
      ? `${this.keyPrefix}:json:${route}:v:${safeVariant(variant)}`
      : `${this.keyPrefix}:json:${route}`;
  }

  async getHtml(route: string): Promise<string | null> {
    return this.client.get(this.htmlKey(route));
  }

  async setHtml(route: string, html: string): Promise<void> {
    const key = this.htmlKey(route);
    if (this.artifactTtlSecs > 0) {
      // Single SET...EX command: atomic, so a crash mid-write can never
      // leave the key without a TTL (the old SET + separate EXPIRE could).
      await this.client.send('SET', [key, html, 'EX', String(this.artifactTtlSecs)]);
    } else {
      await this.client.set(key, html);
    }
  }

  async patchSlot(route: string, slot: string, value: string, variant?: string): Promise<void> {
    const key = this.slotKey(route, variant);
    if (this.artifactTtlSecs > 0) {
      // Redis has no single-command atomic "HSET + EXPIRE" (pre-7.4
      // HEXPIRE sets a per-field TTL, not what we want here), so run both
      // inside a Lua script — scripts execute atomically in Redis.
      await this.client.send('EVAL', [
        "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]); redis.call('EXPIRE', KEYS[1], ARGV[3]); return 1",
        '1',
        key,
        slot,
        value,
        String(this.artifactTtlSecs),
      ]);
    } else {
      await this.client.send('HSET', [key, slot, value]);
    }
  }

  // `variant` must be threaded through here for the same reason patchSlot
  // takes it: slotKey is now variant-scoped, so reading without the variant
  // would look at the shared hash and never see a per-user slot's value.
  async getSlots(route: string, variant?: string): Promise<Record<string, string>> {
    const result = await this.client.send('HGETALL', [this.slotKey(route, variant)]);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      if (result != null) {
        console.warn(`[kiln] RedisCache.getSlots: unexpected HGETALL shape for route "${route}", ignoring`);
      }
      return {};
    }
    return result as Record<string, string>;
  }

  async setJson(route: string, json: any, variant?: string): Promise<void> {
    const key = this.jsonKey(route, variant);
    const value = typeof json === 'string' ? json : JSON.stringify(json);
    if (this.artifactTtlSecs > 0) {
      await this.client.send('SET', [key, value, 'EX', String(this.artifactTtlSecs)]);
    } else {
      await this.client.set(key, value);
    }
  }

  async getJson(route: string, variant?: string): Promise<any | null> {
    const s = await this.client.get(this.jsonKey(route, variant));
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  async publishInvalidate(payload: InvalidatePayload): Promise<void> {
    await this.client.publish(this.invalidateChannel(), JSON.stringify(payload));
  }

  async publishPatch(payload: PatchPayload): Promise<void> {
    await this.client.publish(this.patchChannel(), JSON.stringify(payload));
  }

  // Eviction is per (route, user_key) — purgeInactiveRoutes now returns the
  // userKey precisely so the caller can name the variant whose keys to drop.
  // Without it a per-user artifact outlives its own eviction and is only
  // reclaimed by the artifact TTL (or never, when no TTL is configured).
  async deleteRouteKeys(route: string, variant?: string): Promise<void> {
    await this.client.send('DEL', [
      this.htmlKey(route, variant),
      this.slotKey(route, variant),
      this.jsonKey(route, variant),
    ]);
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }
}

// Re-export legacy types consumed by hub.ts/watcher.ts until they migrate
export interface InvalidatePayload { route: string; slots: string[]; deps: string[]; }
export interface PatchPayload { route: string; slot: string; value: any; userKey?: string; }
