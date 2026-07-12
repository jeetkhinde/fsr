import type { Plugin } from 'vite';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';

export interface KilnVitePluginOptions {
  pagesDir: string;
  onRoutesChanged?: () => void | Promise<void>;
}

// `startsWith` on raw paths false-matches sibling directories that share a
// prefix (e.g. pagesDir "pages" would match a file in "pages-legacy/").
// path.relative crossing up ("..") is the reliable way to test containment.
function isInsideDir(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function kilnVitePlugin(options: KilnVitePluginOptions): Plugin {
  return {
    name: 'vite-plugin-kiln',
    configureServer(server) {
      const handleFileChange = async (filePath: string) => {
        if (isInsideDir(filePath, options.pagesDir)) {
          if (options.onRoutesChanged) {
            await options.onRoutesChanged();
          }
        }
      };

      server.watcher.on('add', handleFileChange);
      server.watcher.on('unlink', handleFileChange);
    },
    handleHotUpdate(ctx) {
      if (isInsideDir(ctx.file, options.pagesDir)) {
        // Return modules to hot-reload in the browser
        return ctx.modules;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Islands build pipeline (ADR-014 §6)
//
// For each app-root islands/<Name>.tsx the plugin defines a virtual module
// `virtual:kiln-island/<Name>` that SSR-hydrates the component:
//
//   import { hydrateRoot } from 'react-dom/client';
//   import { createElement } from 'react';
//   import Component from '<abs path>';
//   export function hydrate(el, props) { ... }
//
// The client bootstrap stays react-free: it just imports the chunk by URL
// (resolved by NAME through the manifest) and calls mod.hydrate(el, props).
// React/ReactDOM are code-split by Vite into shared chunks automatically.
// ---------------------------------------------------------------------------

export interface KilnIslandsPluginOptions {
  /** App root containing the islands/ directory. Default process.cwd(). */
  appRoot?: string;
}

export const ISLAND_VIRTUAL_PREFIX = 'virtual:kiln-island/';
const RESOLVED_PREFIX = '\0' + ISLAND_VIRTUAL_PREFIX;
const ISLAND_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

function findIslandFile(islandsDir: string, name: string): string | null {
  // Island names come from markers/manifest requests — never let them walk
  // out of the islands directory.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  for (const ext of ISLAND_EXTENSIONS) {
    const candidate = path.join(islandsDir, name + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function listIslands(islandsDir: string): string[] {
  if (!fs.existsSync(islandsDir)) return [];
  return fs
    .readdirSync(islandsDir)
    .filter((f) => ISLAND_EXTENSIONS.includes(path.extname(f)) && !f.includes('.test.'))
    .map((f) => path.basename(f, path.extname(f)))
    .sort();
}

export function kilnIslandsPlugin(options: KilnIslandsPluginOptions = {}): Plugin {
  const appRoot = options.appRoot ?? process.cwd();
  const islandsDir = path.join(appRoot, 'islands');
  let publicBase = '/';

  return {
    name: 'vite-plugin-kiln-islands',

    configResolved(config) {
      publicBase = config.base.endsWith('/') ? config.base : config.base + '/';
    },

    // Build: register one entry per island so each gets its own chunk. The
    // manifest is keyed off facadeModuleId in generateBundle, so entry
    // naming details don't matter — appending to whatever input shape the
    // app already uses is enough.
    config(config, { command }) {
      if (command !== 'build') return;
      const ids = listIslands(islandsDir).map((n) => ISLAND_VIRTUAL_PREFIX + n);
      if (ids.length === 0) return;
      config.build ??= {};
      config.build.rollupOptions ??= {};
      // Vite app builds default preserveEntrySignatures to false, which
      // STRIPS entry exports — the island wrapper's hydrate() would be
      // dropped, leaving a hollow react-only chunk the bootstrap can't use
      // ("island chunk has no hydrate() export" in production, dev unaffected
      // since it serves real modules). exports-only keeps entry exports.
      config.build.rollupOptions.preserveEntrySignatures = 'exports-only';
      const existing = config.build.rollupOptions.input;
      if (existing === undefined) {
        config.build.rollupOptions.input = ids;
      } else if (typeof existing === 'string') {
        config.build.rollupOptions.input = [existing, ...ids];
      } else if (Array.isArray(existing)) {
        config.build.rollupOptions.input = [...existing, ...ids];
      } else {
        config.build.rollupOptions.input = {
          ...existing,
          ...Object.fromEntries(ids.map((id) => [id.slice('virtual:'.length).replace(/[:/]/g, '_'), id])),
        };
      }
    },

    resolveId(id) {
      if (id.startsWith(ISLAND_VIRTUAL_PREFIX)) return '\0' + id;
      return null;
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const name = id.slice(RESOLVED_PREFIX.length);
      const file = findIslandFile(islandsDir, name);
      if (!file) {
        this.error(
          `[kiln] island "${name}" not found — expected ${path.join(islandsDir, name)}.tsx/.ts/.jsx/.js`,
        );
        return null;
      }
      return [
        `import { hydrateRoot } from 'react-dom/client';`,
        `import { createElement } from 'react';`,
        `import Component from ${JSON.stringify(file)};`,
        `export function hydrate(el, props) {`,
        `  return hydrateRoot(el, createElement(Component, props));`,
        `}`,
      ].join('\n');
    },

    generateBundle(_opts, bundle) {
      const islands: Record<string, string> = {};
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
        const facade = chunk.facadeModuleId ?? '';
        if (!facade.startsWith(RESOLVED_PREFIX)) continue;
        islands[facade.slice(RESOLVED_PREFIX.length)] = publicBase + chunk.fileName;
      }
      if (Object.keys(islands).length === 0) return;
      const version = createHash('sha1')
        .update(Object.keys(islands).sort().map((n) => `${n}:${islands[n]}`).join('|'))
        .digest('hex')
        .slice(0, 12);
      this.emitFile({
        type: 'asset',
        fileName: 'kiln-islands.json',
        source: JSON.stringify({ version, islands }, null, 2),
      });
    },

    // Dev: names resolve to the Vite dev server's URL for the virtual
    // module. Vite serves resolved "\0"-prefixed ids under /@id/__x00__<id>.
    // If a Vite major changes that convention, this middleware (not the
    // markers, not the bootstrap) is the only place to fix.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/kiln-islands.json')) return next();
        const names = listIslands(islandsDir);
        const islands = Object.fromEntries(
          names.map((n) => [n, `${publicBase}@id/__x00__${ISLAND_VIRTUAL_PREFIX}${n}`]),
        );
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        // `preamble` (dev only): @vitejs/plugin-react's transform asserts
        // the react-refresh preamble is installed before any transformed
        // component module runs. Baked pages aren't served by Vite, so the
        // islands bootstrap installs it from this URL before the first
        // island import. Production manifests carry no preamble field.
        res.end(
          JSON.stringify({
            version: 'dev',
            preamble: `${publicBase}@react-refresh`,
            islands,
          }),
        );
      });
    },
  };
}
