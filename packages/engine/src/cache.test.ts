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
});
