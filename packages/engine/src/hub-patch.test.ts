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

  it('patches s-live slot in baked html', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-hub-'));
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    const html = '<div><span s-live="count">5</span></div>';
    await cache.setHtml('/contacts', html);
    await patchBakedFiles(cache, '/contacts', 'count', '10');
    const result = await cache.getHtml('/contacts');
    expect(result).toContain('>10<');
    expect(result).not.toContain('>5<');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('is a no-op for HTML patch when no HTML is baked (only JSON exists)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-hub-'));
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    // Only JSON is present — no HTML file on disk
    await cache.setJson('/json-only', { status: 'open' });
    // Must not throw even though there is no HTML to patch
    await expect(patchBakedFiles(cache, '/json-only', 'status', 'closed')).resolves.toBeUndefined();
    // JSON was still updated
    const json = await cache.getJson('/json-only') as any;
    expect(json.status).toBe('closed');
    // HTML still absent
    expect(await cache.getHtml('/json-only')).toBeNull();
    await fs.rm(tmpDir, { recursive: true });
  });

  it('is a no-op for JSON patch when no JSON is baked (only HTML exists)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-hub-'));
    const cache = new KilnCache({ redis: null, cacheDir: tmpDir, ttlSecs: 0 });
    // Only HTML is present — no JSON file on disk
    const html = '<span s-live="status">open</span>';
    await cache.setHtml('/html-only', html);
    // Must not throw even though there is no JSON to patch
    await expect(patchBakedFiles(cache, '/html-only', 'status', 'closed')).resolves.toBeUndefined();
    // HTML was still updated
    const updatedHtml = await cache.getHtml('/html-only');
    expect(updatedHtml).toContain('>closed<');
    // JSON still absent
    expect(await cache.getJson('/html-only')).toBeNull();
    await fs.rm(tmpDir, { recursive: true });
  });
});

