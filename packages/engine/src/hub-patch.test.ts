import { describe, it, expect } from 'bun:test';
import { patchBakedFiles } from './hub.js';
import { KilnCache } from './cache.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('patchBakedFiles', () => {
  it('updates json field in baked file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-hub-'));
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    await cache.setJson('/contacts', { count: 5, name: 'Alice' });
    await patchBakedFiles(cache, '/contacts', 'count', 10);
    const result = await cache.getJson('/contacts') as any;
    expect(result.count).toBe(10);
    expect(result.name).toBe('Alice');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('leaves the baked HTML shell unchanged', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-hub-'));
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    const html = '<div><span s-live="count">5</span></div>';
    await cache.setHtml('/contacts', html);
    await patchBakedFiles(cache, '/contacts', 'count', '10');
    const result = await cache.getHtml('/contacts');
    expect(result).toBe(html);
    await fs.rm(tmpDir, { recursive: true });
  });
});
