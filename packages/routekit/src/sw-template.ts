export interface ServiceWorkerConfig {
  enabled: boolean;
  strategy: 'cache-first' | 'stale-while-revalidate' | 'network-first';
  precache?: string[];
  exclude?: string[];
  offlineFallback?: string;
}

export function generateServiceWorker(config: ServiceWorkerConfig): string {
  const VALID_STRATEGIES = ['cache-first', 'stale-while-revalidate', 'network-first'] as const;
  if (!VALID_STRATEGIES.includes(config.strategy)) {
    throw new Error(`Invalid service worker strategy: ${config.strategy}`);
  }

  const precache = JSON.stringify(config.precache ?? []);
  const exclude = JSON.stringify(config.exclude ?? []);
  const fallback = config.offlineFallback ? JSON.stringify(config.offlineFallback) : 'null';

  return `
const CACHE = 'kiln-sw-v1';
const PRECACHE = ${precache};
const EXCLUDE = ${exclude};
const OFFLINE = ${fallback};
const STRATEGY = '${config.strategy}';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (EXCLUDE.some(p => url.pathname.startsWith(p))) return;

  if (STRATEGY === 'cache-first') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => OFFLINE ? caches.match(OFFLINE) : Response.error())));
  } else if (STRATEGY === 'stale-while-revalidate') {
    e.respondWith(caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; }).catch(() => cached || Response.error());
        return cached || fresh;
      })
    ));
  } else {
    e.respondWith(fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || (OFFLINE ? caches.match(OFFLINE) : Response.error()))));
  }
});
`.trim();
}
