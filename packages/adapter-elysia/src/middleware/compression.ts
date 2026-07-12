import { Elysia } from 'elysia';

// Below this, gzip's per-response overhead isn't worth the CPU cost.
const COMPRESSIBLE_MIN_BYTES = 1024;

/**
 * gzip text responses (HTML/JSON page & action bodies) when the client
 * advertises support. Deliberately narrow: only touches plain string
 * bodies, so binary responses (images, `registerAsset` files) and SSE
 * streams (which never produce a string `response` here) pass through
 * unchanged.
 */
export const compression = () => (app: Elysia) =>
  app.onAfterHandle({ as: 'global' }, ({ request, set, response }) => {
    if (typeof response !== 'string') return;
    if (Buffer.byteLength(response) < COMPRESSIBLE_MIN_BYTES) return;

    const acceptEncoding = request.headers.get('accept-encoding') ?? '';
    if (!acceptEncoding.includes('gzip')) return;

    const compressed = Bun.gzipSync(Buffer.from(response));
    set.headers['content-encoding'] = 'gzip';
    set.headers['vary'] = set.headers['vary']
      ? `${set.headers['vary']}, Accept-Encoding`
      : 'Accept-Encoding';
    return new Response(compressed, { headers: set.headers as HeadersInit });
  });
