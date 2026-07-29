import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { KilnCache, RedisCache, cacheKeyPrefix } from './cache.js';
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

  it('delete of a parent route keeps descendant route caches intact', async () => {
    await cache.setHtml('/contacts', '<ul>parent</ul>');
    await cache.setHtml('/contacts/archive', '<ul>child</ul>');
    await cache.setHtml('/contacts', '<p>variant</p>', false, 'admin');

    await cache.delete('/contacts');

    expect(await cache.getHtml('/contacts')).toBeNull();
    expect(await cache.getHtml('/contacts', 'admin')).toBeNull();
    // Nested route caches live inside the parent's directory — they must
    // survive a parent-route invalidation.
    expect(await cache.getHtml('/contacts/archive')).toBe('<ul>child</ul>');
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
      // Assert on the traversal token itself, not just '/../' — safeVariant
      // strips dots entirely, so a '..' surviving anywhere in the variant
      // segment is the real invariant to guard (a regex that kept dots would
      // pass '/../' but still leave '..').
      expect(p).not.toContain('..');
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

    it('keys a dynamic layout pattern per concrete param, not per pattern', async () => {
      // The bug: "/projects/:id" resolved to ONE cache entry shared by every
      // project, so the first-baked project's chrome leaked into all others.
      await cache.setLayoutHtml('/projects/:id', '<h1>PROBE-ALPHA</h1>', { id: '1' });
      await cache.setLayoutJson('/projects/:id', { data: { name: 'PROBE-ALPHA' } }, { id: '1' });

      // A different project must be a cache MISS, not alpha's entry.
      expect(await cache.getLayoutHtml('/projects/:id', { id: '2' })).toBeNull();
      expect(await cache.getLayoutJson('/projects/:id', { id: '2' })).toBeNull();

      await cache.setLayoutHtml('/projects/:id', '<h1>PROBE-BETA</h1>', { id: '2' });
      expect(await cache.getLayoutHtml('/projects/:id', { id: '1' })).toBe('<h1>PROBE-ALPHA</h1>');
      expect(await cache.getLayoutHtml('/projects/:id', { id: '2' })).toBe('<h1>PROBE-BETA</h1>');
    });

    it('ignores params a layout pattern does not own, so one bake is shared by its child routes', async () => {
      // "/projects/7/board" and "/projects/7/activity" both carry the page's
      // own params; only `id` belongs to the layout, so both must hit the
      // same entry — that sharing is the whole point of ADR-011.
      await cache.setLayoutHtml('/projects/:id', '<h1>SEVEN</h1>', { id: '7', taskId: '99' });
      expect(await cache.getLayoutHtml('/projects/:id', { id: '7' })).toBe('<h1>SEVEN</h1>');
      expect(await cache.getLayoutHtml('/projects/:id', { id: '7', taskId: '123' })).toBe('<h1>SEVEN</h1>');
    });

    it('does not collide two param values that sanitise to the same disk-safe string', async () => {
      await cache.setLayoutHtml('/x/:slug', '<a/>', { slug: 'a/b' });
      await cache.setLayoutHtml('/x/:slug', '<b/>', { slug: 'a_b' });
      expect(await cache.getLayoutHtml('/x/:slug', { slug: 'a/b' })).toBe('<a/>');
      expect(await cache.getLayoutHtml('/x/:slug', { slug: 'a_b' })).toBe('<b/>');
    });

    it('keeps a param value from escaping the cache directory', () => {
      const p = cache.diskLayoutHtmlPath('/x/:slug', { slug: '../../../etc/passwd' });
      expect(p).not.toContain('..');
      expect(p.startsWith(tmpDir)).toBe(true);
    });

    it('deleteLayout without params drops every instance of a dynamic pattern', async () => {
      // The deploy case: the layout's source changed, so no instance's
      // artifact is valid — and the caller only knows the pattern.
      await cache.setLayoutHtml('/projects/:id', '<h1>A</h1>', { id: '1' });
      await cache.setLayoutHtml('/projects/:id', '<h1>B</h1>', { id: '2' });
      // A nested layout pattern caches in a SUBDIRECTORY of the same dir and
      // must survive (an rm -r of the pattern dir would take it out).
      await cache.setLayoutHtml('/projects/:id/settings', '<nav>settings</nav>', { id: '1' });

      await cache.deleteLayout('/projects/:id');

      expect(await cache.getLayoutHtml('/projects/:id', { id: '1' })).toBeNull();
      expect(await cache.getLayoutHtml('/projects/:id', { id: '2' })).toBeNull();
      expect(await cache.getLayoutHtml('/projects/:id/settings', { id: '1' })).toBe('<nav>settings</nav>');
    });

    it('deleteLayout with params drops only that instance', async () => {
      await cache.setLayoutHtml('/projects/:id', '<h1>A</h1>', { id: '1' });
      await cache.setLayoutHtml('/projects/:id', '<h1>B</h1>', { id: '2' });

      await cache.deleteLayout('/projects/:id', { id: '1' });

      expect(await cache.getLayoutHtml('/projects/:id', { id: '1' })).toBeNull();
      expect(await cache.getLayoutHtml('/projects/:id', { id: '2' })).toBe('<h1>B</h1>');
    });

    it('leaves a static pattern on its historical suffix-free path', () => {
      // Static layouts own no params, so their key must not change — existing
      // deployments' entries stay readable across this fix.
      const p = cache.diskLayoutHtmlPath('/dashboard', { id: '7' });
      expect(p).toBe(cache.diskLayoutHtmlPath('/dashboard'));
      expect(p).not.toContain('_i');
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
        // Emulates the subset of raw commands KilnCache issues via .send()
        // for atomic writes (SET key val EX secs) — the counterpart to the
        // separate .set()/.expire() calls above, recorded the same way so
        // existing assertions on `store`/`expireCalls` still hold regardless
        // of which path a given method takes.
        async send(command: string, args: string[]) {
          if (command === 'SET') {
            const [key, value, mode, secsStr] = args;
            store.set(key, value);
            if (mode === 'EX' && secsStr !== undefined) {
              expireCalls.push({ key, secs: Number(secsStr) });
            }
          }
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

    it('prefixes every Redis key with the namespace so two apps do not collide on the same route', async () => {
      const redis = createMockRedis();
      const nsCache = new KilnCache({ redis: redis as any, cacheDir: tmpDir, ttlSecs: 60, namespace: 'jags-list' });
      await nsCache.setHtml('/', '<p>app A home</p>');
      await nsCache.setJson('/', { data: {} });
      await nsCache.setLayoutHtml('/', '<nav>A</nav>');
      // Namespaced keys, and the un-namespaced key another app would use is absent.
      expect(redis.store.get('kiln:jags-list:html:/')).toBe('<p>app A home</p>');
      expect(redis.store.has('kiln:html:/')).toBe(false);
      expect([...redis.store.keys()].every((k) => k.startsWith('kiln:jags-list:'))).toBe(true);
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

describe('cache namespacing', () => {
  it('cacheKeyPrefix is bare "kiln" without a namespace and "kiln:<ns>" with one', () => {
    expect(cacheKeyPrefix()).toBe('kiln');
    expect(cacheKeyPrefix(undefined)).toBe('kiln');
    expect(cacheKeyPrefix('jags-list')).toBe('kiln:jags-list');
  });

  it('KilnCache.fsrConnectionsKey is namespaced so apps do not share a connection cap', () => {
    const plain = new KilnCache({ redis: null, cacheDir: '/tmp/x', ttlSecs: 0 });
    const ns = new KilnCache({ redis: null, cacheDir: '/tmp/x', ttlSecs: 0, namespace: 'jags-list' });
    expect(plain.fsrConnectionsKey()).toBe('kiln:fsr:connections');
    expect(ns.fsrConnectionsKey()).toBe('kiln:jags-list:fsr:connections');
  });

  it('RedisCache pub/sub channels are namespaced so publisher and subscriber match per app', () => {
    // Constructing does not connect (BunRedisClient connects lazily); the
    // channel getters never touch the socket.
    const plain = new RedisCache('redis://localhost:6379');
    const ns = new RedisCache('redis://localhost:6379', 'jags-list');
    expect(plain.invalidateChannel()).toBe('kiln:invalidate');
    expect(plain.patchChannel()).toBe('kiln:patch');
    expect(ns.invalidateChannel()).toBe('kiln:jags-list:invalidate');
    expect(ns.patchChannel()).toBe('kiln:jags-list:patch');
  });
});
