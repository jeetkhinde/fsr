import type { RedisClient } from 'bun';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface KilnCacheOptions {
  redis: RedisClient | null;
  cacheDir: string;
  ttlSecs: number;
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

  diskHtmlPath(route: string): string {
    const safe = route === '/' ? 'index' : route.replace(/^\//, '').replace(/\//g, path.sep);
    return path.join(this.cacheDir, safe, 'index.html');
  }

  diskJsonPath(route: string): string {
    return this.diskHtmlPath(route).replace(/\.html$/, '.json');
  }

  private redisHtmlKey(route: string): string { return `kiln:html:${route}`; }
  private redisJsonKey(route: string): string { return `kiln:json:${route}`; }

  async getHtml(route: string): Promise<string | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisHtmlKey(route));
        if (v != null) return v;
      } catch { this.redis = null; }
    }
    const f = Bun.file(this.diskHtmlPath(route));
    return (await f.exists()) ? f.text() : null;
  }

  async setHtml(route: string, html: string): Promise<void> {
    const diskPath = this.diskHtmlPath(route);
    await Bun.write(diskPath, html);
    if (this.redis) {
      try {
        await this.redis.set(this.redisHtmlKey(route), html);
        if (this.ttlSecs > 0) await this.redis.expire(this.redisHtmlKey(route), this.ttlSecs);
      } catch { this.redis = null; }
    }
  }

  async getJson(route: string): Promise<unknown | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.redisJsonKey(route));
        if (v != null) return JSON.parse(v);
      } catch { this.redis = null; }
    }
    const f = Bun.file(this.diskJsonPath(route));
    if (!(await f.exists())) return null;
    try { return JSON.parse(await f.text()); } catch { return null; }
  }

  async setJson(route: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data);
    await Bun.write(this.diskJsonPath(route), json);
    if (this.redis) {
      try {
        await this.redis.set(this.redisJsonKey(route), json);
        if (this.ttlSecs > 0) await this.redis.expire(this.redisJsonKey(route), this.ttlSecs);
      } catch { this.redis = null; }
    }
  }

  async patchJsonField(route: string, field: string, value: unknown): Promise<void> {
    const existing = (await this.getJson(route)) as Record<string, unknown> | null;
    if (!existing) return;
    existing[field] = value;
    await this.setJson(route, existing);
  }

  async delete(route: string): Promise<void> {
    const htmlPath = this.diskHtmlPath(route);
    const jsonPath = this.diskJsonPath(route);
    await Promise.allSettled([
      fs.unlink(htmlPath).catch(() => {}),
      fs.unlink(jsonPath).catch(() => {}),
    ]);
    if (this.redis) {
      try {
        await this.redis.send('DEL', [this.redisHtmlKey(route), this.redisJsonKey(route)]);
      } catch { this.redis = null; }
    }
  }

  getClient(): RedisClient | null { return this.redis; }
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
