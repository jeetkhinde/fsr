import type { RedisClient } from 'bun';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BAKED_RENDER_VERSION } from './baking.js';

export interface KilnCacheOptions {
  redis: RedisClient | null;
  cacheDir: string;
  ttlSecs: number;
}

function safeVariant(v: string): string {
  return v.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export class KilnCache {
  private redis: RedisClient | null;
  private readonly cacheDir: string;
  private readonly ttlSecs: number;

  constructor(opts: KilnCacheOptions) {
    this.redis = opts.redis;
    this.cacheDir = opts.cacheDir;
    this.ttlSecs = opts.ttlSecs;
  }

  diskHtmlPath(route: string, variant?: string): string {
    const safe = route === '/' ? 'index' : route.replace(/^\//, '').replace(/\//g, path.sep);
    if (variant) {
      return path.join(this.cacheDir, safe, '_v', safeVariant(variant), 'index.html');
    }
    return path.join(this.cacheDir, safe, 'index.html');
  }

  // ---------------------------------------------------------------------
  // Layout-level cache: keyed by the LAYOUT's own pattern (e.g. "/dashboard"),
  // not by the concrete route being served. A layout that only depends on
  // its own pattern's params (never req.query, never a descendant page's
  // params — see docs/layout-caching.md) bakes once and is shared by every
  // route underneath it, instead of being re-baked into every route's own
  // page-level cache entry. Invalidating a layout then only touches this one
  // entry, regardless of how many routes sit under it.
  // ---------------------------------------------------------------------

  // Layout entries embed markup conventions (marker attributes, outlet
  // wrapping) that page snapshots version via BAKED_RENDER_VERSION — but a
  // page's layoutSignature compares the layout cache against ITSELF, so it
  // can never detect that the cached layout was baked by an older Kiln.
  // Versioning the keys/paths makes every render-version bump miss cleanly
  // and re-bake layouts too. Older-version entries are simply orphaned
  // (small; disk under layouts/v<N>, Redis keys age out via server TTL
  // policy or manual cleanup).
  diskLayoutHtmlPath(pattern: string): string {
    const safe = pattern === '/' ? 'index' : pattern.replace(/^\//, '').replace(/\//g, path.sep);
    return path.join(this.cacheDir, 'layouts', `v${BAKED_RENDER_VERSION}`, safe, 'shell.html');
  }

  diskLayoutJsonPath(pattern: string): string {
    return this.diskLayoutHtmlPath(pattern).replace(/\.html$/, '.json');
  }

  private redisLayoutHtmlKey(pattern: string): string {
    return `kiln:layout:html:v${BAKED_RENDER_VERSION}:${pattern}`;
  }
  private redisLayoutJsonKey(pattern: string): string {
    return `kiln:layout:json:v${BAKED_RENDER_VERSION}:${pattern}`;
  }

  async getLayoutHtml(pattern: string): Promise<string | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisLayoutHtmlKey(pattern));
        if (v != null) return v;
      } catch (err) { this.warnRedisError('getLayoutHtml', pattern, err); }
    }
    const f = Bun.file(this.diskLayoutHtmlPath(pattern));
    return (await f.exists()) ? f.text() : null;
  }

  async setLayoutHtml(pattern: string, html: string): Promise<void> {
    await atomicWrite(this.diskLayoutHtmlPath(pattern), html);
    if (this.redis) {
      try {
        await this.redis.set(this.redisLayoutHtmlKey(pattern), html);
      } catch (err) { this.warnRedisError('setLayoutHtml', pattern, err); }
    }
  }

  async getLayoutJson(pattern: string): Promise<unknown | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisLayoutJsonKey(pattern));
        if (v != null) return JSON.parse(v);
      } catch (err) { this.warnRedisError('getLayoutJson', pattern, err); }
    }
    const f = Bun.file(this.diskLayoutJsonPath(pattern));
    if (!(await f.exists())) return null;
    try { return JSON.parse(await f.text()); } catch { return null; }
  }

  async setLayoutJson(pattern: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data);
    await atomicWrite(this.diskLayoutJsonPath(pattern), json);
    if (this.redis) {
      try {
        await this.redis.set(this.redisLayoutJsonKey(pattern), json);
      } catch (err) { this.warnRedisError('setLayoutJson', pattern, err); }
    }
  }

  /** Invalidate a single layout's cache — e.g. after a deploy that changes
   * its source. Every route under that layout picks up the change on its
   * next request; no per-route re-bake needed. */
  async deleteLayout(pattern: string): Promise<void> {
    await Promise.allSettled([
      fs.unlink(this.diskLayoutHtmlPath(pattern)).catch(() => {}),
      fs.unlink(this.diskLayoutJsonPath(pattern)).catch(() => {}),
    ]);
    if (this.redis) {
      try {
        await this.redis.send('DEL', [this.redisLayoutHtmlKey(pattern), this.redisLayoutJsonKey(pattern)]);
      } catch (err) { this.warnRedisError('deleteLayout', pattern, err); }
    }
  }

  diskJsonPath(route: string, variant?: string): string {
    return this.diskHtmlPath(route, variant).replace(/\.html$/, '.json');
  }

  private redisHtmlKey(route: string, variant?: string): string {
    return variant ? `kiln:html:${route}:v:${safeVariant(variant)}` : `kiln:html:${route}`;
  }

  private redisJsonKey(route: string, variant?: string): string {
    return variant ? `kiln:json:${route}:v:${safeVariant(variant)}` : `kiln:json:${route}`;
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
        await this.redis.set(this.redisHtmlKey(route, variant), html);
        // pinInRedis skips expire() so the entry never evicts; otherwise it
        // follows the same ttlSecs policy as JSON snapshots.
        if (!pinInRedis && this.ttlSecs > 0) {
          await this.redis.expire(this.redisHtmlKey(route, variant), this.ttlSecs);
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
        await this.redis.set(this.redisJsonKey(route, variant), json);
        if (this.ttlSecs > 0) await this.redis.expire(this.redisJsonKey(route, variant), this.ttlSecs);
      } catch (err) { this.warnRedisError('setJson', route, err); }
    }
  }

  async patchJsonField(route: string, field: string, value: unknown): Promise<void> {
    const existing = (await this.getJson(route)) as Record<string, unknown> | null;
    if (!existing) return;
    const target =
      existing.data && typeof existing.data === 'object' && !Array.isArray(existing.data)
        ? existing.data as Record<string, unknown>
        : existing;
    target[field] = value;
    if ('updatedAt' in existing) existing.updatedAt = new Date().toISOString();
    await this.setJson(route, existing);
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

  constructor(url: string) {
    this.client = new BunRedisClient(url);
  }

  withArtifactTtl(ttlSecs: number): this {
    this.artifactTtlSecs = ttlSecs;
    return this;
  }

  getClient(): BunRedisClient {
    return this.client;
  }

  private htmlKey(route: string): string {
    return `kiln:html:${route}`;
  }

  private slotKey(route: string): string {
    return `kiln:slot:${route}`;
  }

  private jsonKey(route: string): string {
    return `kiln:json:${route}`;
  }

  async getHtml(route: string): Promise<string | null> {
    return this.client.get(this.htmlKey(route));
  }

  async setHtml(route: string, html: string): Promise<void> {
    const key = this.htmlKey(route);
    if (this.artifactTtlSecs > 0) {
      await Promise.all([
        this.client.set(key, html),
        this.client.expire(key, this.artifactTtlSecs),
      ]);
    } else {
      await this.client.set(key, html);
    }
  }

  async patchSlot(route: string, slot: string, value: string): Promise<void> {
    const key = this.slotKey(route);
    if (this.artifactTtlSecs > 0) {
      await Promise.all([
        this.client.send('HSET', [key, slot, value]),
        this.client.expire(key, this.artifactTtlSecs),
      ]);
    } else {
      await this.client.send('HSET', [key, slot, value]);
    }
  }

  async getSlots(route: string): Promise<Record<string, string>> {
    const result = await this.client.send('HGETALL', [this.slotKey(route)]);
    return (result as Record<string, string>) || {};
  }

  async setJson(route: string, json: any): Promise<void> {
    const key = this.jsonKey(route);
    const value = typeof json === 'string' ? json : JSON.stringify(json);
    if (this.artifactTtlSecs > 0) {
      await Promise.all([
        this.client.set(key, value),
        this.client.expire(key, this.artifactTtlSecs),
      ]);
    } else {
      await this.client.set(key, value);
    }
  }

  async getJson(route: string): Promise<any | null> {
    const s = await this.client.get(this.jsonKey(route));
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  async publishInvalidate(payload: InvalidatePayload): Promise<void> {
    await this.client.publish('kiln:invalidate', JSON.stringify(payload));
  }

  async publishPatch(payload: PatchPayload): Promise<void> {
    await this.client.publish('kiln:patch', JSON.stringify(payload));
  }

  async deleteRouteKeys(route: string): Promise<void> {
    await this.client.send('DEL', [this.htmlKey(route), this.slotKey(route), this.jsonKey(route)]);
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }
}

// Re-export legacy types consumed by hub.ts/watcher.ts until they migrate
export interface InvalidatePayload { route: string; slots: string[]; deps: string[]; }
export interface PatchPayload { route: string; slot: string; value: any; }
