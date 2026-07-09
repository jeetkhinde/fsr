import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { KilnCache } from './cache.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('KilnCache', () => {
  let tmpDir: string;
  let cache: KilnCache;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-cache-test-'));
    cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 60 });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for unknown key (disk-only mode)', async () => {
    const result = await cache.getHtml('/contacts');
    expect(result).toBeNull();
  });

  it('round-trips HTML to disk', async () => {
    await cache.setHtml('/contacts', '<ul>list</ul>');
    const result = await cache.getHtml('/contacts');
    expect(result).toBe('<ul>list</ul>');
  });

  it('round-trips JSON to disk', async () => {
    await cache.setJson('/contacts', { contacts: [{ id: '1' }] });
    const result = await cache.getJson('/contacts');
    expect(result).toEqual({ contacts: [{ id: '1' }] });
  });

  it('delete removes both html and json', async () => {
    await cache.setHtml('/contacts', '<ul></ul>');
    await cache.setJson('/contacts', {});
    await cache.delete('/contacts');
    expect(await cache.getHtml('/contacts')).toBeNull();
    expect(await cache.getJson('/contacts')).toBeNull();
  });

  it('normalises dynamic route to safe disk path', () => {
    // /contacts/123 → contacts/123/index.html (no colon in filename)
    const htmlPath = cache.diskHtmlPath('/contacts/123');
    expect(htmlPath).toContain('contacts');
    expect(htmlPath).toContain('123');
    expect(htmlPath).toEndWith('index.html');
    expect(htmlPath).not.toContain(':');
  });

  describe('variant cache partitioning', () => {
    it('stores different HTML per variant without cross-contamination', async () => {
      await cache.setHtml('/profile', '<p>Alice</p>', false, 'alice');
      await cache.setHtml('/profile', '<p>Bob</p>', false, 'bob');
      expect(await cache.getHtml('/profile', 'alice')).toBe('<p>Alice</p>');
      expect(await cache.getHtml('/profile', 'bob')).toBe('<p>Bob</p>');
      expect(await cache.getHtml('/profile')).toBeNull();
    });

    it('stores different JSON per variant without cross-contamination', async () => {
      await cache.setJson('/profile', { name: 'Alice' }, 'alice');
      await cache.setJson('/profile', { name: 'Bob' }, 'bob');
      expect(await cache.getJson('/profile', 'alice')).toEqual({ name: 'Alice' });
      expect(await cache.getJson('/profile', 'bob')).toEqual({ name: 'Bob' });
      expect(await cache.getJson('/profile')).toBeNull();
    });

    it('delete with variant removes only that variant', async () => {
      await cache.setHtml('/profile', '<p>Alice</p>', false, 'alice');
      await cache.setHtml('/profile', '<p>Bob</p>', false, 'bob');
      await cache.delete('/profile', 'alice');
      expect(await cache.getHtml('/profile', 'alice')).toBeNull();
      expect(await cache.getHtml('/profile', 'bob')).toBe('<p>Bob</p>');
    });

    it('delete without variant removes all variants', async () => {
      await cache.setHtml('/profile', '<p>base</p>');
      await cache.setHtml('/profile', '<p>Alice</p>', false, 'alice');
      await cache.setHtml('/profile', '<p>Bob</p>', false, 'bob');
      await cache.delete('/profile');
      expect(await cache.getHtml('/profile')).toBeNull();
      expect(await cache.getHtml('/profile', 'alice')).toBeNull();
      expect(await cache.getHtml('/profile', 'bob')).toBeNull();
    });

    it('variant disk path is inside _v subdirectory', () => {
      const p = cache.diskHtmlPath('/profile', 'alice');
      expect(p).toContain('_v');
      expect(p).toContain('alice');
      expect(p).toEndWith('index.html');
    });

    it('sanitises variant strings for disk/redis safety', () => {
      const p = cache.diskHtmlPath('/x', 'user:42/evil/../path');
      expect(p).not.toContain(':');
      expect(p).not.toContain('/../');
    });
  });

  describe('layout-level cache (pattern-scoped, separate from page cache)', () => {
    it('round-trips layout HTML and JSON to disk, keyed by pattern', async () => {
      await cache.setLayoutHtml('/dashboard', '<nav>sidebar</nav>');
      await cache.setLayoutJson('/dashboard', { data: { sidebarBakedAt: 't1' } });
      expect(await cache.getLayoutHtml('/dashboard')).toBe('<nav>sidebar</nav>');
      expect(await cache.getLayoutJson('/dashboard')).toEqual({ data: { sidebarBakedAt: 't1' } });
    });

    it('returns null for a layout pattern that was never baked', async () => {
      expect(await cache.getLayoutHtml('/never-baked')).toBeNull();
      expect(await cache.getLayoutJson('/never-baked')).toBeNull();
    });

    it('keeps layout and page caches independent — same route string does not collide', async () => {
      // A page and a layout could share the same pattern string (e.g. a
      // page at "/dashboard" and a layout whose pattern is also
      // "/dashboard"). They must not read/write each other's cache entries.
      await cache.setHtml('/dashboard', '<page>page html</page>');
      await cache.setLayoutHtml('/dashboard', '<layout>layout html</layout>');
      expect(await cache.getHtml('/dashboard')).toBe('<page>page html</page>');
      expect(await cache.getLayoutHtml('/dashboard')).toBe('<layout>layout html</layout>');
    });

    it('deleteLayout only removes that one layout pattern, leaving page cache and sibling layout patterns untouched', async () => {
      await cache.setHtml('/dashboard/reports', '<page>page</page>');
      await cache.setJson('/dashboard/reports', { data: {} });
      await cache.setLayoutHtml('/dashboard', '<layout>dashboard chrome</layout>');
      await cache.setLayoutHtml('/dashboard/reports', '<layout>reports tabs</layout>');

      await cache.deleteLayout('/dashboard/reports');

      expect(await cache.getLayoutHtml('/dashboard/reports')).toBeNull();
      expect(await cache.getLayoutJson('/dashboard/reports')).toBeNull();
      // Sibling/ancestor layout untouched.
      expect(await cache.getLayoutHtml('/dashboard')).toBe('<layout>dashboard chrome</layout>');
      // Page-level cache for the same route string untouched.
      expect(await cache.getHtml('/dashboard/reports')).toBe('<page>page</page>');
      expect(await cache.getJson('/dashboard/reports')).toEqual({ data: {} });
    });

    it('normalises the root layout pattern "/" to a safe disk path', () => {
      const htmlPath = cache.diskLayoutHtmlPath('/');
      expect(htmlPath).toContain('layouts');
      expect(htmlPath).toContain('index');
      expect(htmlPath).toEndWith('shell.html');
    });
  });

  describe('Redis sharing for promoted HTML', () => {
    function createMockRedis() {
      const store = new Map<string, string>();
      const expireCalls: Array<{ key: string; secs: number }> = [];
      return {
        store,
        expireCalls,
        async get(key: string) {
          return store.has(key) ? store.get(key)! : null;
        },
        async set(key: string, value: string) {
          store.set(key, value);
        },
        async expire(key: string, secs: number) {
          expireCalls.push({ key, secs });
        },
        async send() {
          return null;
        },
      };
    }

    it('writes HTML to Redis by default (with TTL), matching JSON behavior', async () => {
      const redis = createMockRedis();
      const redisCache = new KilnCache({ redis: redis as any, cacheDir: tmpDir, ttlSecs: 60 });
      await redisCache.setHtml('/contacts', '<ul>list</ul>');
      expect(redis.store.get('kiln:html:/contacts')).toBe('<ul>list</ul>');
      expect(redis.expireCalls).toEqual([{ key: 'kiln:html:/contacts', secs: 60 }]);
    });

    it('skips TTL expiry (permanent pin) when pinInRedis is true', async () => {
      const redis = createMockRedis();
      const redisCache = new KilnCache({ redis: redis as any, cacheDir: tmpDir, ttlSecs: 60 });
      await redisCache.setHtml('/contacts', '<ul>list</ul>', true);
      expect(redis.store.get('kiln:html:/contacts')).toBe('<ul>list</ul>');
      expect(redis.expireCalls).toEqual([]);
    });

    it('reads back HTML from Redis (shared across instances) without relying on local disk', async () => {
      const redis = createMockRedis();
      const writer = new KilnCache({ redis: redis as any, cacheDir: tmpDir, ttlSecs: 60 });
      await writer.setHtml('/contacts', '<ul>from redis</ul>');

      // Simulate a second instance with its own empty disk cache dir.
      const otherTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-cache-test-other-'));
      const reader = new KilnCache({ redis: redis as any, cacheDir: otherTmpDir, ttlSecs: 60 });
      try {
        const result = await reader.getHtml('/contacts');
        expect(result).toBe('<ul>from redis</ul>');
      } finally {
        await fs.rm(otherTmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Redis error recovery', () => {
    // KilnCache is created once per route and lives for the process lifetime
    // (see buildPageHandler in routekit/boot.ts), so a transient Redis error
    // must not permanently disable Redis for that instance.
    function createFlakyRedis(failFirstNCalls: number) {
      const store = new Map<string, string>();
      let calls = 0;
      return {
        store,
        async get(key: string) {
          calls += 1;
          if (calls <= failFirstNCalls) throw new Error('ECONNRESET (simulated)');
          return store.has(key) ? store.get(key)! : null;
        },
        async set(key: string, value: string) {
          calls += 1;
          if (calls <= failFirstNCalls) throw new Error('ECONNRESET (simulated)');
          store.set(key, value);
        },
        async expire() {},
        async send() { return null; },
      };
    }

    it('keeps retrying Redis on later calls after a transient error, instead of falling back to disk forever', async () => {
      const redis = createFlakyRedis(1); // first call fails, rest succeed
      const redisCache = new KilnCache({ redis: redis as any, cacheDir: tmpDir, ttlSecs: 0 });

      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        // First write: the simulated Redis error is swallowed; disk still gets the write.
        await redisCache.setHtml('/contacts', '<ul>v1</ul>');
        expect(await redisCache.getHtml('/contacts')).toBe('<ul>v1</ul>'); // served from disk fallback

        // Second write: Redis has "recovered" — this call should reach Redis,
        // not skip it because a prior instance-level flag disabled it.
        await redisCache.setHtml('/contacts', '<ul>v2</ul>');
        expect(redis.store.get('kiln:html:/contacts')).toBe('<ul>v2</ul>');
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});
