# Kiln Fragment Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Kiln's render/cache pipeline so each route segment (layout + page) bakes its own HTML fragment and JSON file independently, assembled at request time from a 3-tier cache (Redis → disk → SSR), with layout `load()` support and LiveProp invalidation patching baked files.

**Architecture:** Every `.tsx` page and `_layout.tsx` file is SSR'd in isolation — layouts render with an outlet token as children, pages render standalone. Baked fragments live at `.kiln/{route}/index.html` and `.kiln/{route}/index.json`. At request time: read fragments from Redis/disk, stitch (outer-to-inner token replacement), inject JSON seed, respond. On LiveProp change: re-run `load()`, patch JSON field, re-inject HTML slot — write both tiers without full re-render.

**Tech Stack:** Bun (file I/O, Redis client, fetch), Elysia (adapter, lifecycle hooks), React 19 (`renderToString`, `renderToReadableStream`), `@elysiajs/logger` (tracing), `valibot` (form validation), `@fluent/bundle` (i18n — Phase 11), `sharp` (images — Phase 11)

---

## File Map

### Create
| File | Responsibility |
|------|---------------|
| `packages/engine/src/fragment-store.ts` | Read/write HTML+JSON fragments to disk+Redis; path resolution |
| `packages/engine/src/assembler.ts` | Stitch layout chain + page fragments; inject JSON seed; outlet token replacement |
| `packages/engine/src/list-broadcast.ts` | `ListBroadcast<T>` — clone-safe SSE fan-out for keyed list row changes |
| `packages/engine/src/list-chunk-cache.ts` | `InMemoryListChunkCache` — pre-baked HTML per (list, key) pair |
| `packages/core/src/list.ts` | `KilnListRow` interface, `ListPatchEvent` type |
| `packages/routekit/src/typed-routes.ts` | Generate `routes.ts` from manifest with typed route builders |
| `packages/adapter-elysia/src/middleware/tracing.ts` | Wrap `@elysiajs/logger` |
| `packages/adapter-elysia/src/middleware/server-hooks.ts` | Discover `hooks.ts` at app root and wire Elysia lifecycle |

### Modify
| File | What changes |
|------|-------------|
| `packages/core/src/types.ts` | `KilnRequest.prebakeNext(path)`, `LayoutDefinition` type |
| `packages/core/src/index.ts` | Export `list.ts` |
| `packages/engine/src/cache.ts` | Replace `RedisCache` with `KilnCache` (3-tier: Redis → disk → null) |
| `packages/engine/src/baking.ts` | Add `bakeFragment()`, `bakeLayoutFragment()`, JSON baking |
| `packages/engine/src/hub.ts` | On LiveProp patch: update baked HTML slot + JSON field on disk+Redis |
| `packages/engine/src/index.ts` | Export new files |
| `packages/routekit/src/manifest.ts` | `LayoutNode.hasLoad: boolean`; `PageRoute.hasEntries: boolean` |
| `packages/routekit/src/discover.ts` | `ignoreGlobs` filtering; detect `entries()` export |
| `packages/routekit/src/boot.ts` | Full rewrite: 3-tier cache, parallel loaders, content negotiation, fragment baking |
| `packages/routekit/src/layout-chain.ts` | `composeLayoutChain` accepts `propsByPattern: Record<string, any>` |
| `packages/adapter-elysia/src/adapter.ts` | Graceful shutdown, ISR inspect endpoint |
| `packages/adapter-elysia/src/middleware/index.ts` | Export tracing, server-hooks |
| `packages/client/src/silcrow.js` | `initLiveElements()`, `list-patch` SSE handler, SSE reconnect |

---

## Phase 1 — Core Types

### Task 1: Add `prebakeNext` and `LayoutDefinition` to `packages/core/src/types.ts`

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/types.test.ts`:
```typescript
import { describe, it, expect } from 'bun:test';
import type { KilnRequest, LayoutDefinition } from './types.js';

describe('types', () => {
  it('KilnRequest has prebakeNext', () => {
    const req = {
      path: '/',
      method: 'GET',
      params: {},
      query: {},
      headers: new Headers(),
      formData: async () => new FormData(),
      json: async () => ({}),
      isEnhanced: false,
      layoutsPresent: [],
      prebakeNext: (_path: string) => {},
    } satisfies KilnRequest;
    expect(req.prebakeNext).toBeDefined();
  });

  it('LayoutDefinition extends PageDefinition with children', () => {
    const layout: LayoutDefinition = {
      default: () => null,
    };
    expect(layout.default).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test src/types.test.ts
```
Expected: type error on `prebakeNext` not existing on `KilnRequest`

- [ ] **Step 3: Add `prebakeNext` and `LayoutDefinition` to `types.ts`**

```typescript
// In KilnRequest interface, add after `raw?`:
prebakeNext(path: string): void;

// Add LayoutDefinition after PageDefinition:
export interface LayoutDefinition {
  load?: (req: KilnRequest) => Promise<LoadResult> | LoadResult;
  default: any; // React component with children prop
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/core && bun test src/types.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts
git commit -m "feat(core): add prebakeNext to KilnRequest, add LayoutDefinition"
```

---

### Task 2: Create `packages/core/src/list.ts` — list types

**Files:**
- Create: `packages/core/src/list.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/list.test.ts`:
```typescript
import { describe, it, expect } from 'bun:test';
import type { KilnListRow, ListPatchEvent } from './list.js';

describe('list types', () => {
  it('KilnListRow has key and live fields', () => {
    const row: KilnListRow = { __key: 'abc', __liveFields: ['name', 'count'] };
    expect(row.__key).toBe('abc');
    expect(row.__liveFields).toContain('name');
  });

  it('ListPatchEvent has list, key, and changed fields', () => {
    const event: ListPatchEvent = {
      list: 'contacts',
      key: '123',
      changes: { name: 'Alice', favorite: true },
    };
    expect(event.list).toBe('contacts');
    expect(event.changes.name).toBe('Alice');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test src/list.test.ts
```
Expected: module not found

- [ ] **Step 3: Create `packages/core/src/list.ts`**

```typescript
export interface KilnListRow {
  __key: string;
  __liveFields: string[];
  [field: string]: any;
}

export interface ListPatchEvent {
  list: string;
  key: string;
  changes: Record<string, any>;
}

export interface ListChunkCache {
  get(list: string, key: string): string | null;
  set(list: string, key: string, html: string): void;
  delete(list: string, key: string): void;
  deleteList(list: string): void;
}
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

```typescript
// Add to existing exports:
export * from './list.js';
```

- [ ] **Step 5: Run test**

```bash
cd packages/core && bun test src/list.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/list.ts packages/core/src/list.test.ts packages/core/src/index.ts
git commit -m "feat(core): add KilnListRow and ListPatchEvent types"
```

---

## Phase 2 — KilnCache (3-tier)

### Task 3: Rewrite `packages/engine/src/cache.ts` as `KilnCache`

**Files:**
- Modify: `packages/engine/src/cache.ts`

The new `KilnCache` tries Redis, falls back to disk, falls back to null. Redis failure at runtime silently disables Redis for subsequent calls (no throw, no latency).

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/cache.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/engine && bun test src/cache.test.ts
```
Expected: `KilnCache` not exported

- [ ] **Step 3: Rewrite `packages/engine/src/cache.ts`**

```typescript
import type { RedisClient } from 'bun';
import * as path from 'path';

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
    // disk write is always async / non-blocking
    Bun.write(diskPath, html).catch(() => {});
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
    Bun.write(this.diskJsonPath(route), json).catch(() => {});
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
      Bun.file(htmlPath).exists().then(e => e ? Bun.write(htmlPath, '') : undefined),
      Bun.file(jsonPath).exists().then(e => e ? Bun.write(jsonPath, '') : undefined),
    ]);
    if (this.redis) {
      try {
        await this.redis.send('DEL', [this.redisHtmlKey(route), this.redisJsonKey(route)]);
      } catch { this.redis = null; }
    }
  }

  /** Expose for legacy compatibility */
  getClient(): RedisClient | null { return this.redis; }
}

// Re-export legacy types consumed by hub.ts/watcher.ts until they migrate
export interface InvalidatePayload { route: string; slots: string[]; deps: string[]; }
export interface PatchPayload { route: string; slot: string; value: any; }
```

- [ ] **Step 4: Run test**

```bash
cd packages/engine && bun test src/cache.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/cache.ts packages/engine/src/cache.test.ts
git commit -m "feat(engine): replace RedisCache with KilnCache (3-tier: Redis → disk → null)"
```

---

## Phase 3 — Fragment Baking

### Task 4: Add `bakeFragment` and `bakeLayoutFragment` to `packages/engine/src/baking.ts`

**Files:**
- Modify: `packages/engine/src/baking.ts`

The outlet token is a unique string that React renders verbatim as a text node. At assembly time we replace it with the child fragment's HTML.

- [ ] **Step 1: Write the failing test**

Add to `packages/engine/src/baking.test.ts` (create if absent):
```typescript
import { describe, it, expect } from 'bun:test';
import { bakeFragment, bakeLayoutFragment, OUTLET_TOKEN } from './baking.js';
import { createElement } from 'react';

function Page({ name }: { name: string }) {
  return createElement('div', null, `Hello ${name}`);
}

function Layout({ title, children }: { title: string; children?: any }) {
  return createElement('main', null,
    createElement('h1', null, title),
    children,
  );
}

describe('bakeFragment', () => {
  it('renders page component to HTML string', async () => {
    const html = await bakeFragment(Page, { name: 'World' });
    expect(html).toContain('Hello World');
    expect(html).toContain('<div>');
  });
});

describe('bakeLayoutFragment', () => {
  it('renders layout with outlet token as children', async () => {
    const html = await bakeLayoutFragment(Layout, { title: 'My App' });
    expect(html).toContain('My App');
    expect(html).toContain(OUTLET_TOKEN);
    expect(html).not.toContain('<div>Hello');
  });

  it('outlet token survives round-trip replacement', () => {
    const layoutHtml = `<main><h1>App</h1>${OUTLET_TOKEN}</main>`;
    const pageHtml = '<ul>list</ul>';
    const result = layoutHtml.replace(OUTLET_TOKEN, pageHtml);
    expect(result).toBe('<main><h1>App</h1><ul>list</ul></main>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/engine && bun test src/baking.test.ts
```

- [ ] **Step 3: Add to `packages/engine/src/baking.ts`**

Append to the existing file (keep `injectFsrSlots`, `findSLiveSlots`, `escapeHtml`):

```typescript
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

export const OUTLET_TOKEN = '​__KILN_OUTLET_7f3a9c4b__​';

/**
 * SSR a page/fragment component in isolation (no layout wrapping).
 */
export async function bakeFragment(
  Component: (props: any) => any,
  props: Record<string, any>
): Promise<string> {
  return renderToString(createElement(Component, props));
}

/**
 * SSR a layout component with OUTLET_TOKEN as children.
 * The token appears verbatim in the output — replace it at assembly time.
 */
export async function bakeLayoutFragment(
  LayoutComponent: (props: any) => any,
  props: Record<string, any>
): Promise<string> {
  return renderToString(createElement(LayoutComponent, props, OUTLET_TOKEN));
}

/**
 * Bake both HTML fragment and JSON for a route segment in one pass.
 * Returns both for the caller to persist.
 */
export async function bakeSegment(
  Component: (props: any) => any,
  props: Record<string, any>,
  isLayout: boolean
): Promise<{ html: string; json: string }> {
  const html = isLayout
    ? await bakeLayoutFragment(Component, props)
    : await bakeFragment(Component, props);
  return { html, json: JSON.stringify(props) };
}
```

- [ ] **Step 4: Run test**

```bash
cd packages/engine && bun test src/baking.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/baking.ts packages/engine/src/baking.test.ts
git commit -m "feat(engine): add bakeFragment/bakeLayoutFragment with outlet token isolation"
```

---

## Phase 4 — Fragment Assembler

### Task 5: Create `packages/engine/src/assembler.ts`

**Files:**
- Create: `packages/engine/src/assembler.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/assembler.test.ts`:
```typescript
import { describe, it, expect } from 'bun:test';
import { assembleFragments, injectJsonSeed, injectKilnScript } from './assembler.js';
import { OUTLET_TOKEN } from './baking.js';

const rootLayout = `<html><body><nav>Nav</nav>${OUTLET_TOKEN}</body></html>`;
const appLayout = `<div class="app">${OUTLET_TOKEN}</div>`;
const pageHtml = `<ul><li>Contact 1</li></ul>`;

describe('assembleFragments', () => {
  it('assembles single layout + page', () => {
    const result = assembleFragments([rootLayout], pageHtml);
    expect(result).toBe('<html><body><nav>Nav</nav><ul><li>Contact 1</li></ul></body></html>');
  });

  it('assembles two layouts + page (outer→inner)', () => {
    const result = assembleFragments([rootLayout, appLayout], pageHtml);
    expect(result).toContain('<div class="app">');
    expect(result).toContain('<ul><li>Contact 1</li></ul>');
    expect(result).not.toContain(OUTLET_TOKEN);
  });

  it('returns page html with no layouts', () => {
    const result = assembleFragments([], pageHtml);
    expect(result).toBe(pageHtml);
  });
});

describe('injectJsonSeed', () => {
  it('injects window.__kiln_seed before </body>', () => {
    const html = '<html><body><p>hi</p></body></html>';
    const seed = { '/contacts': { contacts: [] } };
    const result = injectJsonSeed(html, seed);
    expect(result).toContain('window.__kiln_seed');
    expect(result).toContain('"/contacts"');
    expect(result.indexOf('</body>')).toBeGreaterThan(result.indexOf('__kiln_seed'));
  });
});

describe('injectKilnScript', () => {
  it('injects client script before </head>', () => {
    const html = '<html><head><title>T</title></head><body></body></html>';
    const result = injectKilnScript(html, '/_kiln/client.js');
    expect(result).toContain('<script src="/_kiln/client.js"');
    expect(result.indexOf('</head>')).toBeGreaterThan(result.indexOf('<script'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/engine && bun test src/assembler.test.ts
```

- [ ] **Step 3: Create `packages/engine/src/assembler.ts`**

```typescript
import { OUTLET_TOKEN } from './baking.js';

/**
 * Stitch layout chain + page fragment into complete HTML.
 * layoutHtmls[0] is outermost. Each contains OUTLET_TOKEN where child goes.
 * Sequential outer→inner replacement: each replace consumes the outermost token
 * and exposes the next layout's token.
 */
export function assembleFragments(layoutHtmls: string[], pageHtml: string): string {
  if (layoutHtmls.length === 0) return pageHtml;
  let result = layoutHtmls[0];
  for (let i = 1; i < layoutHtmls.length; i++) {
    result = result.replace(OUTLET_TOKEN, layoutHtmls[i]);
  }
  return result.replace(OUTLET_TOKEN, pageHtml);
}

/**
 * Inject <script>window.__kiln_seed = {...}</script> before </body>.
 * The seed provides load() results for each route segment so React can
 * hydrate without re-fetching.
 */
export function injectJsonSeed(html: string, seed: Record<string, unknown>): string {
  const tag = `<script>window.__kiln_seed=${JSON.stringify(seed)}</script>`;
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + tag;
  return html.slice(0, idx) + tag + html.slice(idx);
}

/**
 * Inject <script src="..."> before </head> (or start of body if no head).
 */
export function injectKilnScript(html: string, src: string): string {
  const tag = `<script src="${src}" defer></script>`;
  const idx = html.indexOf('</head>');
  if (idx === -1) return tag + html;
  return html.slice(0, idx) + tag + html.slice(idx);
}

/**
 * Inject <link rel="stylesheet"> before </head>.
 */
export function injectStylesheet(html: string, href: string): string {
  const tag = `<link rel="stylesheet" href="${href}">`;
  const idx = html.indexOf('</head>');
  if (idx === -1) return tag + html;
  return html.slice(0, idx) + tag + html.slice(idx);
}
```

- [ ] **Step 4: Export from engine index**

```typescript
// packages/engine/src/index.ts — add:
export * from './assembler.js';
export * from './baking.js';
```

- [ ] **Step 5: Run test**

```bash
cd packages/engine && bun test src/assembler.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/assembler.ts packages/engine/src/assembler.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): add fragment assembler with outlet token stitching and JSON seed injection"
```

---

## Phase 5 — Manifest + Discover Updates

### Task 6: Update manifest types and `discover.ts` for layout `load()`, `entries()`, and `ignoreGlobs`

**Files:**
- Modify: `packages/routekit/src/manifest.ts`
- Modify: `packages/routekit/src/discover.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/routekit/src/discover.test.ts` (create if absent):
```typescript
import { describe, it, expect } from 'bun:test';
import { pathToPattern, discoverRoutes } from './discover.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('ignoreGlobs', () => {
  it('excludes matching paths from discovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-discover-'));
    await fs.writeFile(path.join(dir, 'index.tsx'), '');
    await fs.mkdir(path.join(dir, 'react'), { recursive: true });
    await fs.writeFile(path.join(dir, 'react', 'Button.tsx'), '');
    const manifest = await discoverRoutes(dir, { ignoreGlobs: ['react/**'] });
    const paths = manifest.pages.map(p => p.relativePath);
    expect(paths).not.toContain(expect.stringContaining('react'));
    await fs.rm(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/routekit && bun test src/discover.test.ts
```

- [ ] **Step 3: Update `packages/routekit/src/manifest.ts`**

```typescript
import type { LiveFieldMeta } from '@kiln/core';

export interface PageRoute {
  pattern: string;
  filePath: string;
  relativePath: string;
  layouts: string[];
  promoteAfter?: number;
  liveFields: LiveFieldMeta[];
  hasEntries: boolean;    // exports entries(): Promise<Record<string,string>[]>
}

export interface LayoutNode {
  filePath: string;
  relativePath: string;
  pattern: string;
  hasLoad: boolean;       // exports load(req): Promise<LoadResult>
}

export interface RouteManifest {
  pages: PageRoute[];
  layouts: LayoutNode[];
  errorPages: Record<string, string>;
  loadingPages: Record<string, string>;
  notFoundPages: Record<string, string>;
}
```

- [ ] **Step 4: Update `packages/routekit/src/discover.ts`**

Add `DiscoverOptions` parameter and glob filtering. In `walkDir`:
```typescript
import { Glob } from 'bun';
import * as path from 'path';
import type { RouteManifest, PageRoute, LayoutNode } from './manifest.js';

export interface DiscoverOptions {
  ignoreGlobs?: string[];
}

export async function walkDir(
  dir: string,
  opts: DiscoverOptions = {}
): Promise<RawDiscoveredFile[]> {
  const ignorePatterns = (opts.ignoreGlobs ?? []).map(p => new Glob(p));
  const glob = new Glob('**/*.{tsx,ts,jsx,js}');
  const results: RawDiscoveredFile[] = [];

  try {
    for await (const relPath of glob.scan({ cwd: dir, onlyFiles: true })) {
      if (relPath.startsWith('node_modules/') || relPath.startsWith('.git/') || relPath.startsWith('dist/')) continue;
      if (ignorePatterns.some(p => p.match(relPath))) continue;
      const dirRel = path.dirname(relPath);
      results.push({
        filePath: path.join(dir, relPath),
        relativePath: relPath,
        dirRelativePath: dirRel === '.' ? '' : dirRel,
        fileName: path.basename(relPath),
      });
    }
  } catch {
    return [];
  }
  return results;
}
```

In `discoverRoutes` signature:
```typescript
export async function discoverRoutes(
  pagesDir: string,
  opts: DiscoverOptions = {}
): Promise<RouteManifest> {
  const rawFiles = await walkDir(pagesDir, opts);
  // ... rest unchanged except:
  // For layouts: detect hasLoad by peeking at file content
  // For pages: detect hasEntries
```

Detect `hasLoad` and `hasEntries` by reading file content:
```typescript
// After finding a _layout file:
const layoutContent = await Bun.file(file.filePath).text();
const hasLoad = /export\s+(async\s+)?function\s+load\b/.test(layoutContent)
             || /export\s+const\s+load\b/.test(layoutContent);
layouts.push({ filePath: file.filePath, relativePath: file.relativePath, pattern: pathToPattern(dirRel), hasLoad });

// After finding a page file:
const pageContent = await Bun.file(file.filePath).text();
const hasEntries = /export\s+(async\s+)?function\s+entries\b/.test(pageContent)
                || /export\s+const\s+entries\b/.test(pageContent);
pages.push({ ..., hasEntries, liveFields: [] });
```

- [ ] **Step 5: Run test**

```bash
cd packages/routekit && bun test src/discover.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/routekit/src/manifest.ts packages/routekit/src/discover.ts packages/routekit/src/discover.test.ts
git commit -m "feat(routekit): add ignoreGlobs filtering, layout hasLoad, page hasEntries detection"
```

---

## Phase 6 — Boot Pipeline Rewrite

### Task 7: Rewrite `packages/routekit/src/boot.ts` — 3-tier cache + parallel loaders + content negotiation + fragment baking

**Files:**
- Modify: `packages/routekit/src/boot.ts`
- Modify: `packages/routekit/src/layout-chain.ts`

This is the largest change. Replace the current single-tree SSR with the fragment model.

- [ ] **Step 1: Write the failing integration test**

Create `packages/routekit/src/boot.test.ts`:
```typescript
import { describe, it, expect } from 'bun:test';
import { buildPageHandler } from './boot.js';
import type { KilnRequest, KilnResponse } from '@kiln/core';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

function makeReq(overrides: Partial<KilnRequest> = {}): KilnRequest {
  return {
    path: '/contacts',
    method: 'GET',
    params: {},
    query: {},
    headers: new Headers({ accept: 'text/html' }),
    formData: async () => new FormData(),
    json: async () => ({}),
    isEnhanced: false,
    layoutsPresent: [],
    prebakeNext: () => {},
    ...overrides,
  };
}

function makeRes(): KilnRequest & { captured: any } {
  const res: any = { status: 200, headers: {}, captured: null };
  res.html = (b: string) => { res.captured = { type: 'html', body: b }; };
  res.json = (b: unknown) => { res.captured = { type: 'json', body: b }; };
  res.redirect = (url: string) => { res.captured = { type: 'redirect', url }; };
  res.sse = () => {};
  return res;
}

describe('buildPageHandler', () => {
  it('returns JSON when Accept: application/json', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const pageModule = {
      load: async () => ({ contacts: [{ id: '1', name: 'Alice' }] }),
      default: ({ contacts }: any) => null,
    };
    const handler = buildPageHandler(pageModule, { pattern: '/contacts', layouts: [], liveFields: [], hasEntries: false }, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null });
    const req = makeReq({ headers: new Headers({ accept: 'application/json' }) });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.type).toBe('json');
    expect(res.captured.body).toEqual({ contacts: [{ id: '1', name: 'Alice' }] });
    await fs.rm(tmpDir, { recursive: true });
  });

  it('returns HTML when Accept: text/html with no layouts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
    const pageModule = {
      load: async () => ({ title: 'Hello' }),
      default: ({ title }: any) => { const { createElement } = require('react'); return createElement('h1', null, title); },
    };
    const handler = buildPageHandler(pageModule, { pattern: '/about', layouts: [], liveFields: [], hasEntries: false }, [], { cacheDir: tmpDir, ttlSecs: 0, redis: null });
    const req = makeReq({ path: '/about' });
    const res = makeRes();
    await handler(req as any, res as any);
    expect(res.captured.type).toBe('html');
    expect(res.captured.body).toContain('Hello');
    await fs.rm(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/routekit && bun test src/boot.test.ts
```

- [ ] **Step 3: Update `layout-chain.ts` to accept `propsByPattern`**

Replace the current `composeLayoutChain` signature to accept per-segment props:

```typescript
import type { ComponentType } from 'react';

export interface LayoutComponentConfig {
  pattern: string;
  component: ComponentType<any>;
  props: Record<string, any>;   // ← own props from layout's load()
}

/**
 * Compose layout chain for hydration. Each layout gets its own props.
 * Page component gets pageProps.
 */
export function composeLayoutChain(
  react: any,
  PageComponent: any,
  layouts: LayoutComponentConfig[],
  pagePattern: string,
  pageProps: any
): any {
  let currentElement = react.createElement(PageComponent, pageProps);
  currentElement = react.createElement(
    'div',
    { 'data-ps-layout': pagePattern, style: { display: 'contents' } },
    currentElement
  );

  for (let i = layouts.length - 1; i >= 0; i--) {
    const { pattern, component: LayoutComponent, props: layoutProps } = layouts[i];
    const childPattern = i === layouts.length - 1 ? pagePattern : layouts[i + 1].pattern;
    const slotElement = react.createElement(
      'div',
      { 'data-ps-slot': childPattern, style: { display: 'contents' } },
      currentElement
    );
    const layoutElement = react.createElement(LayoutComponent, layoutProps, slotElement);
    currentElement = i > 0
      ? react.createElement('div', { 'data-ps-layout': pattern, style: { display: 'contents' } }, layoutElement)
      : layoutElement;
  }
  return currentElement;
}
```

- [ ] **Step 4: Rewrite `packages/routekit/src/boot.ts`**

```typescript
import { createRequire } from 'module';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
import { discoverRoutes, type DiscoverOptions } from './discover.js';
import { composeLayoutChain } from './layout-chain.js';
import { extractPageOptions, extractLiveFields } from './page-options.js';
import { bakeSegment, OUTLET_TOKEN } from '@kiln/engine';
import { assembleFragments, injectJsonSeed, injectKilnScript } from '@kiln/engine';
import { KilnCache } from '@kiln/engine';
import type { PageRoute, LayoutNode } from './manifest.js';
import type { KilnRequest, KilnResponse, KilnConfig, ServerAdapter } from '@kiln/core';

const appRequire = createRequire(path.resolve(process.cwd(), 'package.json'));
const React = appRequire('react');
const ReactDOMServer = appRequire('react-dom/server');

export interface CacheOptions {
  redis: any | null;
  cacheDir: string;
  ttlSecs: number;
}

/** Route key used for cache and JSON seed. Normalises layout paths. */
function routeKey(pattern: string): string { return pattern || '/'; }

/**
 * Determine if this request should return JSON (layout-aware navigation or explicit Accept).
 * Returns true when the client either asks for JSON or already has all layouts rendered.
 */
function wantsJson(req: KilnRequest, layoutPatterns: string[]): boolean {
  const acceptsJson = req.headers.get('accept')?.includes('application/json') ?? false;
  if (acceptsJson) return true;
  if (!req.isEnhanced || layoutPatterns.length === 0) return false;
  return layoutPatterns.every(p => req.layoutsPresent.includes(p));
}

export function buildPageHandler(
  pageModule: any,
  pageMeta: PageRoute,
  layoutNodes: LayoutNode[],
  cacheOpts: CacheOptions,
  kilnConfig?: KilnConfig
) {
  const cache = new KilnCache(cacheOpts);

  return async (req: KilnRequest, res: KilnResponse) => {
    // Wire prebakeNext — fire-and-forget fetch to warm cache
    (req as any).prebakeNext = (p: string) => {
      fetch(`http://localhost:${kilnConfig?.web?.port ?? 3000}${p}`).catch(() => {});
    };

    const layoutPatterns = layoutNodes
      .filter(l => pageMeta.layouts.includes(l.filePath))
      .map(l => l.pattern);

    // ── JSON path (enhanced navigation or explicit Accept) ──────────────
    if (wantsJson(req, layoutPatterns)) {
      const cached = await cache.getJson(routeKey(pageMeta.pattern));
      if (cached) { res.json(cached); return; }

      let props: any = {};
      if (typeof pageModule.load === 'function') {
        props = await pageModule.load(req);
      }
      // Bake JSON async (non-blocking)
      cache.setJson(routeKey(pageMeta.pattern), props).catch(() => {});
      res.json(props);
      return;
    }

    // ── HTML path ───────────────────────────────────────────────────────
    const cachedHtml = await cache.getHtml(routeKey(pageMeta.pattern));
    if (cachedHtml) {
      // Assemble from per-fragment cache (layout fragments + this page fragment)
      // If full assembled page is in cache, return directly
      // (Assembled cache key uses a prefix to distinguish from fragments)
      res.html(cachedHtml);
      return;
    }

    // Load all segments in parallel
    const relevantLayouts = layoutNodes.filter(l => pageMeta.layouts.includes(l.filePath));

    const layoutLoads = relevantLayouts.map(async (layoutNode) => {
      const absPath = path.resolve(layoutNode.filePath);
      const mod = await import(pathToFileURL(absPath).href);
      const layoutProps = typeof mod.load === 'function' ? await mod.load(req) : {};
      return { node: layoutNode, mod, props: layoutProps };
    });

    const pageLoadP = (async () => {
      let props: any = {};
      if (typeof pageModule.load === 'function') {
        props = await pageModule.load(req);
      }
      return props;
    })();

    const [layoutResults, pageProps] = await Promise.all([
      Promise.all(layoutLoads),
      pageLoadP,
    ]);

    const options = extractPageOptions(pageModule);
    const liveFields = extractLiveFields(pageProps);
    pageMeta.liveFields = liveFields;
    pageMeta.promoteAfter = options.promoteAfter;

    // ── Fragment assembly ───────────────────────────────────────────────
    // Each segment is SSR'd independently then stitched
    const layoutHtmls = await Promise.all(
      layoutResults.map(({ mod, props }) =>
        bakeSegment(mod.default, props, true).then(r => r.html)
      )
    );
    const pageHtml = (await bakeSegment(pageModule.default, pageProps, false)).html;

    let assembled = assembleFragments(layoutHtmls, pageHtml);

    // Build JSON seed for client hydration
    const seed: Record<string, unknown> = {};
    for (const { node, props } of layoutResults) {
      seed[routeKey(node.pattern)] = props;
    }
    seed[routeKey(pageMeta.pattern)] = pageProps;

    assembled = injectJsonSeed(assembled, seed);
    assembled = injectKilnScript(assembled, '/_kiln/client.js');

    if (!assembled.startsWith('<!DOCTYPE')) {
      assembled = '<!DOCTYPE html>' + assembled;
    }

    // Bake assembled page + per-segment fragments async
    const promoteAfter = options.promoteAfter;
    if (promoteAfter !== undefined) {
      // Write assembled page HTML (for full-page cache hit)
      cache.setHtml(routeKey(pageMeta.pattern), assembled).catch(() => {});
      cache.setJson(routeKey(pageMeta.pattern), pageProps).catch(() => {});
      // Write layout fragments independently so they can be reused
      for (let i = 0; i < layoutResults.length; i++) {
        const { node, props } = layoutResults[i];
        cache.setHtml(routeKey(node.pattern), layoutHtmls[i]).catch(() => {});
        cache.setJson(routeKey(node.pattern), props).catch(() => {});
      }
    }

    res.html(assembled);
  };
}

export function buildActionHandler(actions: Record<string, any>) {
  return async (req: KilnRequest, res: KilnResponse) => {
    let actionName = '';
    for (const key of Object.keys(req.query)) {
      if (key.startsWith('/')) { actionName = key.slice(1); break; }
    }
    if (!actionName || !actions[actionName]) {
      res.status = 404; res.json({ error: `Action "${actionName}" not found` }); return;
    }
    try {
      const result = await actions[actionName](req);
      res.json(result || { success: true });
    } catch (err: any) {
      if (err.type === 'Redirect') { res.redirect(err.message, err.status); return; }
      res.status = err.status || 500;
      res.json({ error: err.message || 'Action failed' });
    }
  };
}

export async function startKiln(
  adapter: ServerAdapter,
  config: KilnConfig,
  pagesDir: string,
  options: {
    fsr?: { store: any; watcher: any };
    ignoreGlobs?: string[];
  } = {}
) {
  const manifest = await discoverRoutes(pagesDir, { ignoreGlobs: options.ignoreGlobs ?? [] });

  const cacheOpts: CacheOptions = {
    redis: null, // wired externally by engine if configured
    cacheDir: config.fsr ? '.kiln' : '.kiln',
    ttlSecs: config.fsr?.artifactTtlSecs ?? 86400,
  };

  adapter.applyMiddleware({ csrf: true, timeoutMs: 30000, compression: true });

  for (const page of manifest.pages) {
    const absPath = path.resolve(page.filePath);
    const mod = await import(pathToFileURL(absPath).href);

    adapter.registerPage(
      page.pattern,
      page.layouts,
      buildPageHandler(mod, page, manifest.layouts, cacheOpts, config)
    );
    if (mod.actions) {
      adapter.registerAction(page.pattern, buildActionHandler(mod.actions));
    }
  }

  // entries() pre-bake at startup for dynamic routes with promoteAfter === 0
  for (const page of manifest.pages) {
    if (!page.hasEntries || page.promoteAfter !== 0) continue;
    const absPath = path.resolve(page.filePath);
    const mod = await import(pathToFileURL(absPath).href);
    if (typeof mod.entries !== 'function') continue;
    const paramSets: Record<string, string>[] = await mod.entries();
    // Warm each variant via fire-and-forget fetch after server starts
    // (registered as a startup task on the adapter)
    (adapter as any).__entriesPrebake?.push({ pattern: page.pattern, paramSets });
  }

  // Runtime assets
  try {
    const { fileURLToPath } = await import('url');
    const silcrowPath = fileURLToPath(import.meta.resolve('@kiln/client/silcrow.js'));
    adapter.registerAsset('/_kiln/client.js', silcrowPath);
  } catch { /* @kiln/client not installed */ }

  if (options.fsr) {
    adapter.registerPage('/_kiln/live.js', [], async (_req, res) => {
      res.headers['content-type'] = 'application/javascript; charset=utf-8';
      res.html(KILN_LIVE_CLIENT_SCRIPT);
    });
    adapter.registerSSE('/__kiln/fsr', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrHubStream } = await import('@kiln/engine' as any);
      res.sse(fsrHubStream({ route, slots, watcher: options.fsr!.watcher, config: {
        maxConnections: config.fsr?.maxSseConnections ?? 1000,
        connectionTtlSecs: config.fsr?.connectionTtlSecs ?? 3600,
        keepaliveSecs: config.fsr?.keepaliveSecs ?? 30,
      }}));
    });
  }

  // ISR inspect endpoint
  adapter.registerPage('/__kiln/inspect', [], async (_req, res) => {
    const cache = new KilnCache(cacheOpts);
    res.json({ cacheDir: cacheOpts.cacheDir, redis: cache.getClient() !== null });
  });

  return manifest;
}
```

- [ ] **Step 5: Run test**

```bash
cd packages/routekit && bun test src/boot.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/routekit/src/boot.ts packages/routekit/src/layout-chain.ts packages/routekit/src/boot.test.ts
git commit -m "feat(routekit): rewrite boot pipeline — 3-tier cache, parallel loaders, fragment assembly, content negotiation"
```

---

## Phase 7 — LiveProp File Invalidation

### Task 8: Update `packages/engine/src/hub.ts` to patch baked files on LiveProp change

**Files:**
- Modify: `packages/engine/src/hub.ts`

When watcher fires a `SlotPatch`, hub currently emits an SSE event. Now it also:
1. Patches the JSON file: update the field in `.kiln/{route}/index.json`
2. Patches the HTML file: `injectFsrSlots()` on the stored fragment

- [ ] **Step 1: Write the failing test**

Add to `packages/engine/src/hub.test.ts`:
```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/engine && bun test src/hub.test.ts
```

- [ ] **Step 3: Add `patchBakedFiles` to `hub.ts`**

Add at the top of `hub.ts`:
```typescript
import { KilnCache } from './cache.js';
import { injectFsrSlots, findSLiveSlots } from './baking.js';

/**
 * After a LiveProp patch fires, update both JSON and HTML baked files
 * so the next cache hit serves fresh data without a DB round-trip.
 */
export async function patchBakedFiles(
  cache: KilnCache,
  route: string,
  slot: string,
  value: unknown
): Promise<void> {
  await Promise.allSettled([
    // Patch JSON: update the field
    cache.patchJsonField(route, slot, value),
    // Patch HTML: re-inject the s-live slot
    cache.getHtml(route).then(html => {
      if (!html) return;
      const patched = injectFsrSlots(html, [[slot, value]]);
      return cache.setHtml(route, patched);
    }),
  ]);
}
```

In `fsrHubStream`, after emitting the SSE patch event, call `patchBakedFiles` if a cache is available. The cache is injected via `FsrHubStreamOptions`:

```typescript
export interface FsrHubStreamOptions {
  route: string;
  slots: string[];
  watcher: FsrWatcher;
  config?: FsrHubConfig;
  cache?: KilnCache;   // ← add this
}
```

In the patch handler inside `fsrHubStream`:
```typescript
// Existing: emit SSE event
yield { event: 'live', data: JSON.stringify({ slot: patch.slot, value: patch.value }) };
// New: update baked files async
if (options.cache) {
  patchBakedFiles(options.cache, route, patch.slot, patch.value).catch(() => {});
}
```

- [ ] **Step 4: Run test**

```bash
cd packages/engine && bun test src/hub.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/hub.ts packages/engine/src/hub.test.ts
git commit -m "feat(engine): LiveProp patches baked HTML slot and JSON field on change"
```

---

## Phase 8 — Vec\<T\> List System

### Task 9: Create `packages/engine/src/list-broadcast.ts` and `list-chunk-cache.ts`

**Files:**
- Create: `packages/engine/src/list-broadcast.ts`
- Create: `packages/engine/src/list-chunk-cache.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/list-broadcast.test.ts`:
```typescript
import { describe, it, expect } from 'bun:test';
import { ListBroadcast } from './list-broadcast.js';
import type { KilnListRow, ListPatchEvent } from '@kiln/core';

interface Contact extends KilnListRow {
  name: string;
  online: boolean;
}

describe('ListBroadcast', () => {
  it('fans out row changes to all subscribers', async () => {
    const bc = new ListBroadcast<Contact>('contacts');
    const received: ListPatchEvent[] = [];
    const unsub = bc.subscribe(e => received.push(e));

    bc.sendRow({ __key: '123', __liveFields: ['name', 'online'], name: 'Alice', online: true });

    await new Promise(r => setTimeout(r, 0)); // flush microtasks
    expect(received).toHaveLength(1);
    expect(received[0].key).toBe('123');
    expect(received[0].changes.name).toBe('Alice');
    expect(received[0].changes.online).toBe(true);
    unsub();
  });

  it('only includes __liveFields in changes', async () => {
    const bc = new ListBroadcast<Contact>('contacts');
    const received: ListPatchEvent[] = [];
    const unsub = bc.subscribe(e => received.push(e));

    bc.sendRow({ __key: '123', __liveFields: ['online'], name: 'Alice', online: false });

    await new Promise(r => setTimeout(r, 0));
    expect(received[0].changes).toHaveProperty('online');
    expect(received[0].changes).not.toHaveProperty('name');
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/engine && bun test src/list-broadcast.test.ts
```

- [ ] **Step 3: Create `packages/engine/src/list-broadcast.ts`**

```typescript
import type { KilnListRow, ListPatchEvent } from '@kiln/core';

type Subscriber = (event: ListPatchEvent) => void;

export class ListBroadcast<T extends KilnListRow> {
  private subscribers = new Set<Subscriber>();

  constructor(private readonly listName: string) {}

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  sendRow(row: T): void {
    const changes: Record<string, any> = {};
    for (const field of row.__liveFields) {
      changes[field] = row[field];
    }
    const event: ListPatchEvent = { list: this.listName, key: row.__key, changes };
    for (const sub of this.subscribers) {
      try { sub(event); } catch { /* subscriber errors must not break broadcast */ }
    }
  }

  get listKey(): string { return this.listName; }
}
```

- [ ] **Step 4: Create `packages/engine/src/list-chunk-cache.ts`**

```typescript
import type { ListChunkCache } from '@kiln/core';

export class InMemoryListChunkCache implements ListChunkCache {
  private store = new Map<string, string>();

  private key(list: string, rowKey: string): string { return `${list}:${rowKey}`; }

  get(list: string, key: string): string | null {
    return this.store.get(this.key(list, key)) ?? null;
  }

  set(list: string, key: string, html: string): void {
    this.store.set(this.key(list, key), html);
  }

  delete(list: string, key: string): void {
    this.store.delete(this.key(list, key));
  }

  deleteList(list: string): void {
    const prefix = `${list}:`;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }
}
```

- [ ] **Step 5: Export from engine index**

```typescript
// Add to packages/engine/src/index.ts:
export * from './list-broadcast.js';
export * from './list-chunk-cache.js';
```

- [ ] **Step 6: Run tests**

```bash
cd packages/engine && bun test src/list-broadcast.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/list-broadcast.ts packages/engine/src/list-broadcast.test.ts packages/engine/src/list-chunk-cache.ts packages/engine/src/index.ts
git commit -m "feat(engine): add ListBroadcast and InMemoryListChunkCache for Vec<T> list system"
```

---

## Phase 9 — KilnClient SSE Anchor

### Task 10: Add `initLiveElements` and `list-patch` handler to `packages/client/src/silcrow.js`

**Files:**
- Modify: `packages/client/src/silcrow.js`

This adds browser-side SSE lifecycle management: scan DOM for `[data-kiln-live]` elements, open EventSource, dispatch live field patches and list-patch events, reconnect on disconnect.

- [ ] **Step 1: Append to `packages/client/src/silcrow.js`**

Find the section after `initLiveElements` is referenced and add/replace with:

```javascript
// ── KilnClient SSE anchor ─────────────────────────────────────────────────
// Manages one EventSource per [data-kiln-live] element.
// Reconnects with exponential backoff. Dispatches:
//   event: live   → patches [data-kiln-live-field] text nodes
//   event: list-patch → patches [data-kiln-list] rows by key

var RECONNECT_BASE_MS = 1000;
var RECONNECT_MAX_MS = 30000;

function openLiveConnection(el) {
  var route = el.getAttribute('data-kiln-live');
  var slots = [];
  el.querySelectorAll('[data-kiln-live-field]').forEach(function(n) {
    var k = n.getAttribute('data-kiln-live-field');
    if (k && !slots.includes(k)) slots.push(k);
  });
  if (!route) return;

  var url = '/__kiln/fsr?route=' + encodeURIComponent(route) + '&slots=' + encodeURIComponent(slots.join(','));
  var delay = RECONNECT_BASE_MS;
  var es;
  var closed = false;

  function connect() {
    if (closed) return;
    es = new EventSource(url);

    es.addEventListener('live', function(e) {
      try {
        var data = JSON.parse(e.data);
        var slot = data.slot;
        var value = data.value;
        el.querySelectorAll('[data-kiln-live-field="' + CSS.escape(slot) + '"]').forEach(function(n) {
          n.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
        });
        delay = RECONNECT_BASE_MS; // reset on success
      } catch(err) { warn('live patch parse error: ' + err.message); }
    });

    es.addEventListener('list-patch', function(e) {
      try {
        var data = JSON.parse(e.data);
        var listName = data.list;
        var key = data.key;
        var changes = data.changes;
        var listEl = document.querySelector('[data-kiln-list="' + CSS.escape(listName) + '"]');
        if (!listEl) return;
        var rowEl = listEl.querySelector('[data-kiln-key="' + CSS.escape(key) + '"]');
        if (!rowEl) return;
        Object.keys(changes).forEach(function(field) {
          rowEl.querySelectorAll('[data-kiln-live-field="' + CSS.escape(field) + '"]').forEach(function(n) {
            n.textContent = String(changes[field]);
          });
        });
      } catch(err) { warn('list-patch error: ' + err.message); }
    });

    es.addEventListener('error', function() {
      es.close();
      if (closed) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    });
  }

  connect();

  return function destroy() {
    closed = true;
    if (es) es.close();
  };
}

function initLiveElements() {
  document.querySelectorAll('[data-kiln-live]').forEach(function(el) {
    if (el.__kilnLiveDestroy) return; // already managed
    el.__kilnLiveDestroy = openLiveConnection(el);
  });
}

// Run on DOM ready and after Silcrow fragment swaps
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLiveElements);
} else {
  initLiveElements();
}
document.addEventListener('silcrow:patched', initLiveElements);
```

- [ ] **Step 2: Rebuild client bundle**

```bash
cd packages/client && bun run build.ts
```
Expected: `dist/silcrow.js` and `dist/silcrow.min.js` updated

- [ ] **Step 3: Verify bundle contains initLiveElements**

```bash
grep -c 'initLiveElements' packages/client/dist/silcrow.js
```
Expected: output ≥ 1

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/silcrow.js packages/client/dist/silcrow.js packages/client/dist/silcrow.min.js
git commit -m "feat(client): add initLiveElements SSE anchor, list-patch handler, reconnect backoff"
```

---

## Phase 10 — Adapter: Graceful Shutdown + Tracing + Server Hooks

### Task 11: Graceful shutdown and `@elysiajs/logger` in `packages/adapter-elysia`

**Files:**
- Modify: `packages/adapter-elysia/src/adapter.ts`
- Create: `packages/adapter-elysia/src/middleware/tracing.ts`
- Create: `packages/adapter-elysia/src/middleware/server-hooks.ts`
- Modify: `packages/adapter-elysia/src/middleware/index.ts`

- [ ] **Step 1: Install logger**

```bash
cd packages/adapter-elysia && bun add @elysiajs/logger
```

- [ ] **Step 2: Create `packages/adapter-elysia/src/middleware/tracing.ts`**

```typescript
import { Elysia } from 'elysia';

export const tracing = () => (app: Elysia) =>
  app.use(
    new Elysia({ name: 'kiln-tracing' })
      .onRequest(({ request }) => {
        console.log(`→ ${request.method} ${new URL(request.url).pathname}`);
      })
      .onAfterResponse(({ request, set }) => {
        console.log(`← ${request.method} ${new URL(request.url).pathname} ${set.status ?? 200}`);
      })
  );
```

(Swap for `@elysiajs/logger` when logging format needs are defined:)
```typescript
// Alternative with @elysiajs/logger:
// import logger from '@elysiajs/logger';
// export const tracing = () => (app: Elysia) => app.use(logger());
```

- [ ] **Step 3: Create `packages/adapter-elysia/src/middleware/server-hooks.ts`**

```typescript
import { Elysia } from 'elysia';
import { pathToFileURL } from 'url';
import * as path from 'path';

export interface KilnHooks {
  onRequest?: (ctx: any) => void | Promise<void>;
  onError?: (ctx: any) => void | Promise<void>;
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

export async function loadHooks(appRoot: string): Promise<KilnHooks> {
  const hooksPath = path.join(appRoot, 'hooks.ts');
  const hooksFile = Bun.file(hooksPath);
  if (!(await hooksFile.exists())) return {};
  try {
    return await import(pathToFileURL(hooksPath).href);
  } catch {
    return {};
  }
}

export const serverHooks = (hooks: KilnHooks) => (app: Elysia) => {
  if (hooks.onRequest) app.onRequest(hooks.onRequest);
  if (hooks.onError) app.onError(hooks.onError);
  return app;
};
```

- [ ] **Step 4: Add graceful shutdown to `adapter.ts`**

In `ElysiaAdapter.listen()`:
```typescript
async listen(port: number, callback?: (addr: string) => void): Promise<void> {
  this.app.listen(port, () => {
    const hostname = this.app.server?.hostname || 'localhost';
    const serverPort = this.app.server?.port || port;
    callback?.(`http://${hostname}:${serverPort}`);
  });

  // Graceful shutdown — drain in-flight requests before exit
  const shutdown = async () => {
    await this.app.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
```

- [ ] **Step 5: Export from middleware index**

```typescript
// packages/adapter-elysia/src/middleware/index.ts — add:
export * from './tracing.js';
export * from './server-hooks.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-elysia/src/adapter.ts packages/adapter-elysia/src/middleware/tracing.ts packages/adapter-elysia/src/middleware/server-hooks.ts packages/adapter-elysia/src/middleware/index.ts
git commit -m "feat(adapter-elysia): graceful shutdown, request tracing, server-hooks discovery"
```

---

## Phase 11 — Routekit: Typed Routes Codegen

### Task 12: Create `packages/routekit/src/typed-routes.ts`

**Files:**
- Create: `packages/routekit/src/typed-routes.ts`

Generates a `routes.ts` file with type-safe route builders. Static routes return `string` literals. Dynamic routes return functions.

- [ ] **Step 1: Write the failing test**

Create `packages/routekit/src/typed-routes.test.ts`:
```typescript
import { describe, it, expect } from 'bun:test';
import { generateTypedRoutes } from './typed-routes.js';
import type { RouteManifest } from './manifest.js';

const manifest: RouteManifest = {
  pages: [
    { pattern: '/', filePath: '', relativePath: '', layouts: [], liveFields: [], hasEntries: false },
    { pattern: '/about', filePath: '', relativePath: '', layouts: [], liveFields: [], hasEntries: false },
    { pattern: '/contacts/:id', filePath: '', relativePath: '', layouts: [], liveFields: [], hasEntries: false },
    { pattern: '/contacts/:id/edit', filePath: '', relativePath: '', layouts: [], liveFields: [], hasEntries: false },
  ],
  layouts: [],
  errorPages: {},
  loadingPages: {},
  notFoundPages: {},
};

describe('generateTypedRoutes', () => {
  it('generates static routes as string constants', () => {
    const code = generateTypedRoutes(manifest);
    expect(code).toContain("home: '/'");
    expect(code).toContain("about: '/about'");
  });

  it('generates dynamic routes as typed functions', () => {
    const code = generateTypedRoutes(manifest);
    expect(code).toContain('contactsId: (id: string)');
    expect(code).toContain('contactsIdEdit: (id: string)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/routekit && bun test src/typed-routes.test.ts
```

- [ ] **Step 3: Create `packages/routekit/src/typed-routes.ts`**

```typescript
import type { RouteManifest } from './manifest.js';

function patternToName(pattern: string): string {
  if (pattern === '/') return 'home';
  return pattern
    .replace(/^\//, '')
    .replace(/\/:([^/]+)/g, (_, p) => p.charAt(0).toUpperCase() + p.slice(1))
    .replace(/\//g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
}

function extractParams(pattern: string): string[] {
  return [...pattern.matchAll(/:([^/]+)/g)].map(m => m[1]);
}

export function generateTypedRoutes(manifest: RouteManifest): string {
  const lines: string[] = [
    '// Auto-generated by Kiln. Do not edit.',
    'export const routes = {',
  ];

  for (const page of manifest.pages) {
    const name = patternToName(page.pattern);
    const params = extractParams(page.pattern);
    if (params.length === 0) {
      lines.push(`  ${name}: '${page.pattern}',`);
    } else {
      const args = params.map(p => `${p}: string`).join(', ');
      const body = params.reduce(
        (pat, p) => pat.replace(`:${p}`, `\${${p}}`),
        page.pattern
      );
      lines.push(`  ${name}: (${args}) => \`${body}\`,`);
    }
  }

  lines.push('} as const;');
  lines.push('');
  lines.push('export type Routes = typeof routes;');
  return lines.join('\n');
}

export async function writeTypedRoutes(manifest: RouteManifest, outPath: string): Promise<void> {
  await Bun.write(outPath, generateTypedRoutes(manifest));
}
```

- [ ] **Step 4: Run test**

```bash
cd packages/routekit && bun test src/typed-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/routekit/src/typed-routes.ts packages/routekit/src/typed-routes.test.ts
git commit -m "feat(routekit): add typed route codegen (static constants + typed fn for dynamic routes)"
```

---

## Phase 12 — Ecosystem (drop-in libs)

### Task 13: Wire `@fluent/bundle` for i18n

**Files:**
- Create: `packages/core/src/i18n.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Install**

```bash
cd packages/core && bun add @fluent/bundle @fluent/langneg
```

- [ ] **Step 2: Create `packages/core/src/i18n.ts`**

```typescript
import { FluentBundle, FluentResource } from '@fluent/bundle';
import { negotiateLanguages } from '@fluent/langneg';
import type { KilnRequest } from './types.js';
import * as path from 'path';

export class KilnI18n {
  private bundles = new Map<string, FluentBundle>();
  private defaultLocale: string;
  private locales: string[];

  constructor(private config: { defaultLocale: string; locales: string[]; localesDir: string }) {
    this.defaultLocale = config.defaultLocale;
    this.locales = config.locales;
  }

  async load(): Promise<void> {
    for (const locale of this.locales) {
      const dir = path.join(this.config.localesDir, locale);
      const glob = new Bun.Glob('*.ftl');
      const bundle = new FluentBundle(locale);
      try {
        for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
          const content = await Bun.file(path.join(dir, file)).text();
          bundle.addResource(new FluentResource(content));
        }
      } catch { /* missing locale dir — warn only */ }
      this.bundles.set(locale, bundle);
    }
  }

  locale(req: KilnRequest): string {
    const accept = req.headers.get('accept-language') ?? this.defaultLocale;
    const [best] = negotiateLanguages([accept], this.locales, { defaultLocale: this.defaultLocale });
    return best ?? this.defaultLocale;
  }

  t(locale: string, id: string, args?: Record<string, string | number>): string {
    const bundle = this.bundles.get(locale) ?? this.bundles.get(this.defaultLocale);
    if (!bundle) return id;
    const msg = bundle.getMessage(id);
    if (!msg?.value) return id;
    const errors: Error[] = [];
    return bundle.formatPattern(msg.value, args, errors);
  }
}
```

- [ ] **Step 3: Export from core index**

```typescript
export * from './i18n.js';
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/i18n.ts packages/core/src/index.ts
git commit -m "feat(core): add KilnI18n with @fluent/bundle — load .ftl files, locale negotiation, t()"
```

---

### Task 14: Image optimization with `sharp` — `/_image` endpoint

**Files:**
- Create: `packages/routekit/src/image-handler.ts`

- [ ] **Step 1: Install**

```bash
cd packages/routekit && bun add sharp
```

- [ ] **Step 2: Create `packages/routekit/src/image-handler.ts`**

```typescript
import type { KilnRequest, KilnResponse } from '@kiln/core';
import type { ImageConfig } from '@kiln/core';

export function buildImageHandler(config: ImageConfig) {
  return async (req: KilnRequest, res: KilnResponse) => {
    const src = req.query.src ?? '';
    const w = Math.min(parseInt(req.query.w ?? '0', 10) || config.maxWidth, config.maxWidth);
    const q = Math.min(parseInt(req.query.q ?? '75', 10), 100);
    const fmt = (req.query.f ?? 'webp') as 'webp' | 'jpeg' | 'png';

    if (!src || !config.formats.includes(fmt)) {
      res.status = 400; res.json({ error: 'invalid params' }); return;
    }

    const cacheKey = `${src}_${w}_${q}_${fmt}`;
    const cachePath = `${config.cacheDir}/${Buffer.from(cacheKey).toString('base64url')}.${fmt}`;
    const cacheFile = Bun.file(cachePath);

    if (await cacheFile.exists()) {
      res.headers['content-type'] = `image/${fmt}`;
      res.headers['cache-control'] = 'public, max-age=31536000, immutable';
      res.html(await cacheFile.text()); // raw bytes via html for now
      return;
    }

    try {
      const sharp = (await import('sharp')).default;
      const srcFile = Bun.file(src.startsWith('/') ? `.${src}` : src);
      if (!(await srcFile.exists())) { res.status = 404; res.json({ error: 'not found' }); return; }
      const buf = Buffer.from(await srcFile.arrayBuffer());
      const out = await sharp(buf).resize(w > 0 ? { width: w } : undefined)[fmt]({ quality: q }).toBuffer();
      await Bun.write(cachePath, out);
      res.headers['content-type'] = `image/${fmt}`;
      res.headers['cache-control'] = 'public, max-age=31536000, immutable';
      res.html(out.toString('binary'));
    } catch (e: any) {
      res.status = 500; res.json({ error: e.message });
    }
  };
}
```

- [ ] **Step 3: Register in `startKiln`**

In `boot.ts`, after middleware setup:
```typescript
if (config.images?.enabled) {
  const { buildImageHandler } = await import('./image-handler.js');
  adapter.registerPage('/_image', [], buildImageHandler(config.images));
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/routekit/src/image-handler.ts packages/routekit/src/boot.ts
git commit -m "feat(routekit): add /_image endpoint with sharp — resize, quality, format, disk cache"
```

---

### Task 15: Service Worker — custom template, no workbox

**Files:**
- Create: `packages/routekit/src/sw-template.ts`

- [ ] **Step 1: Create `packages/routekit/src/sw-template.ts`**

```typescript
import type { ServiceWorkerConfig } from '@kiln/core';

export function generateServiceWorker(config: ServiceWorkerConfig): string {
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
        const fresh = fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; });
        return cached || fresh;
      })
    ));
  } else { // network-first
    e.respondWith(fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || (OFFLINE ? caches.match(OFFLINE) : Response.error()))));
  }
});
`.trim();
}
```

- [ ] **Step 2: Register `/sw.js` in `startKiln`**

```typescript
if (config.serviceWorker?.enabled) {
  const { generateServiceWorker } = await import('./sw-template.js');
  const swContent = generateServiceWorker(config.serviceWorker);
  adapter.registerPage('/sw.js', [], async (_req, res) => {
    res.headers['content-type'] = 'application/javascript; charset=utf-8';
    res.headers['cache-control'] = 'no-cache';
    res.html(swContent);
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/routekit/src/sw-template.ts packages/routekit/src/boot.ts
git commit -m "feat(routekit): add service worker template — network-first/cache-first/SWR, no workbox"
```

---

## Self-Review

**Spec coverage:**
- [x] Fragment baking (each segment independently — Tasks 4, 5, 6)
- [x] Layout `load()` — Task 6 (discover `hasLoad`), Task 7 (parallel loaders in boot)
- [x] 3-tier cache (Redis → disk → SSR) — Task 3 (`KilnCache`), Task 7 (boot pipeline)
- [x] Assembly at request time — Task 5 (`assembler.ts`), Task 7 (boot uses it)
- [x] Content negotiation (JSON vs HTML) — Task 7 (`wantsJson()`)
- [x] Layout-aware JSON shortcut — Task 7 (`wantsJson()` checks `layoutsPresent`)
- [x] LiveProp patches baked files — Task 8 (`patchBakedFiles`)
- [x] `ignore-directories` — Task 6 (`DiscoverOptions.ignoreGlobs`)
- [x] `entries()` for dynamic SSG — Task 6 (detect), Task 7 (startup prebake)
- [x] `prebakeNext` on `KilnRequest` — Task 1 (type), Task 7 (implementation)
- [x] `Vec<T>` list system — Task 9 (`ListBroadcast`, `InMemoryListChunkCache`)
- [x] KilnClient SSE anchor — Task 10 (`initLiveElements`, `list-patch`)
- [x] Typed routes — Task 12
- [x] Graceful shutdown — Task 11
- [x] Server hooks — Task 11
- [x] Request tracing — Task 11
- [x] i18n — Task 13
- [x] Image optimization — Task 14
- [x] Service worker — Task 15

**Known gaps left for follow-up:**
- Eden Treaty wiring for typed API client (add after Elysia routes are typed)
- `valibot` form validator helper (drop-in, no scaffolding needed)
- `isr-inspect` endpoint richer output (extend Task 7's `/__kiln/inspect`)
- React SSR streaming (`renderToReadableStream` + stream tee for concurrent bake)
- `kiln-export` static HTML export CLI command
