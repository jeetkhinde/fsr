import path from 'path';
import type { KilnRequest, KilnResponse, ImageConfig } from '@kiln/core';

export function buildImageHandler(config: ImageConfig) {
  return async (req: KilnRequest, res: KilnResponse) => {
    const src = req.query.src ?? '';
    const wRaw = parseInt(req.query.w ?? '0', 10);
    const qRaw = parseInt(req.query.q ?? '75', 10);
    const fmt = (req.query.f ?? 'webp') as 'webp' | 'jpeg' | 'png';

    // Malformed numeric params are a client error, not a sharp crash (500).
    if (!src || !config.formats.includes(fmt) || Number.isNaN(wRaw) || Number.isNaN(qRaw)) {
      res.status = 400;
      res.json({ error: 'invalid params' });
      return;
    }
    const w = Math.min(wRaw || config.maxWidth, config.maxWidth);
    const q = Math.max(1, Math.min(qRaw, 100));

    const cacheKey = `${src}_${w}_${q}_${fmt}`;
    const cachePath = `${config.cacheDir}/${Buffer.from(cacheKey).toString('base64url')}.${fmt}`;
    const cacheFile = Bun.file(cachePath);

    const mimeType = fmt === 'jpeg' ? 'image/jpeg' : `image/${fmt}`;

    if (await cacheFile.exists()) {
      res.headers['content-type'] = mimeType;
      res.headers['cache-control'] = 'public, max-age=31536000, immutable';
      const data = await cacheFile.arrayBuffer();
      if (typeof res.binary === 'function') {
        res.binary(data);
      } else {
        // Fallback: set body directly for adapters that support it
        (res as any).body = Buffer.from(data);
        (res as any).bodyType = 'binary';
      }
      return;
    }

    try {
      const sharp = (await import('sharp')).default;
      const staticDir = path.resolve(config.staticDir ?? 'public');
      const requested = path.resolve(staticDir, src.replace(/^\//, ''));
      if (!requested.startsWith(staticDir + path.sep) && requested !== staticDir) {
        res.status = 400; res.json({ error: 'invalid src' }); return;
      }
      const srcPath = requested;
      const srcFile = Bun.file(srcPath);
      if (!(await srcFile.exists())) {
        res.status = 404;
        res.json({ error: 'not found' });
        return;
      }
      const buf = Buffer.from(await srcFile.arrayBuffer());
      // Never upscale — serving a source-sized image beats inventing pixels.
      const pipeline = sharp(buf).resize(w > 0 ? { width: w, withoutEnlargement: true } : undefined);
      const out = await pipeline[fmt]({ quality: q }).toBuffer();

      // Write to disk cache (fire-and-forget)
      Bun.write(cachePath, out).catch(() => {});

      res.headers['content-type'] = mimeType;
      res.headers['cache-control'] = 'public, max-age=31536000, immutable';
      if (typeof res.binary === 'function') {
        res.binary(out);
      } else {
        (res as any).body = out;
        (res as any).bodyType = 'binary';
      }
    } catch (e: any) {
      res.status = 500;
      res.json({ error: e.message });
    }
  };
}
