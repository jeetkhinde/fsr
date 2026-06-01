import { createRequire } from 'module';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { PILCROW_LIVE_CLIENT_SCRIPT } from './live-client-script.js';

const appRequire = createRequire(path.resolve(process.cwd(), 'package.json'));
const React = appRequire('react');
const ReactDOMServer = appRequire('react-dom/server');

import { discoverRoutes } from './discover.js';
import { composeLayoutChain } from './layout-chain.js';
import { extractPageOptions, extractLiveFields } from './page-options.js';
import type { PageRoute, LayoutNode } from './manifest.js';
import type {
  PilcrowRequest,
  PilcrowResponse,
  PilcrowConfig,
  ServerAdapter,
} from '@fsr/core';

const FSR_SCRIPT_TAG = '<script src="/_pilcrow/live.js" defer></script>';

/** Insert the FSR client script tag before </head>, or append if no </head>. */
export function injectFsrScriptTag(html: string): string {
  const headEnd = html.indexOf('</head>');
  if (headEnd !== -1) {
    return html.slice(0, headEnd) + FSR_SCRIPT_TAG + html.slice(headEnd);
  }
  return html + FSR_SCRIPT_TAG;
}

export function buildPageHandler(
  module: any,
  pageMeta: PageRoute,
  layouts: LayoutNode[],
  config: PilcrowConfig,
  hasFsr = false
) {
  return async (req: PilcrowRequest, res: PilcrowResponse) => {
    // 1. Execute page load if it exists
    let props: any = {};
    if (typeof module.load === 'function') {
      try {
        props = await module.load(req);
      } catch (err: any) {
        if (err.type === 'Redirect') {
          res.redirect(err.message, err.status);
          return;
        }
        throw err;
      }
    }

    // 2. Extract options and live fields for runtime FSR checks
    const options = extractPageOptions(module);
    const liveFields = extractLiveFields(props);
    pageMeta.liveFields = liveFields;
    pageMeta.promoteAfter = options.promoteAfter;

    // 3. Resolve layout components from the manifest
    const layoutConfigs = [];
    for (const layoutPath of pageMeta.layouts) {
      const layoutNode = layouts.find((l) => l.filePath === layoutPath);
      const layoutPattern = layoutNode ? layoutNode.pattern : '/';
      const absoluteLayoutPath = path.resolve(layoutPath);
      const layoutModule = await import(pathToFileURL(absoluteLayoutPath).href);
      layoutConfigs.push({
        pattern: layoutPattern,
        component: layoutModule.default,
      });
    }

    // 4. Render React tree
    const pageComponent = module.default;
    const reactTree = composeLayoutChain(React, pageComponent, layoutConfigs, pageMeta.pattern, props);
    const bodyHtml = ReactDOMServer.renderToString(reactTree);

    let finalHtml = bodyHtml.startsWith('<html') ? '<!DOCTYPE html>' + bodyHtml : bodyHtml;

    // 5. Inject FSR live client when FSR is active and this page has live fields
    if (hasFsr && liveFields.length > 0) {
      finalHtml = injectFsrScriptTag(finalHtml);
    }

    res.html(finalHtml);
  };
}

export function buildActionHandler(actions: Record<string, any>) {
  return async (req: PilcrowRequest, res: PilcrowResponse) => {
    let actionName = '';
    for (const key of Object.keys(req.query)) {
      if (key.startsWith('/')) {
        actionName = key.slice(1);
        break;
      }
    }

    if (!actionName || !actions[actionName]) {
      res.status = 404;
      res.json({ error: `Action "${actionName}" not found` });
      return;
    }

    try {
      const result = await actions[actionName](req);
      res.json(result || { success: true });
    } catch (err: any) {
      if (err.type === 'Redirect') {
        res.redirect(err.message, err.status);
        return;
      }
      res.status = err.status || 500;
      res.json({ error: err.message || 'Action failed' });
    }
  };
}

export async function startPilcrow(
  adapter: ServerAdapter,
  config: PilcrowConfig,
  pagesDir: string,
  fsr?: { store: any; watcher: any }
) {
  // 1. Discover routes
  const manifest = await discoverRoutes(pagesDir);

  // 2. Apply middleware
  adapter.applyMiddleware({
    csrf: true,
    timeoutMs: 30000,
    compression: true,
  });

  // 3. Register page routes
  for (const page of manifest.pages) {
    const absolutePagePath = path.resolve(page.filePath);
    const module = await import(pathToFileURL(absolutePagePath).href);
    adapter.registerPage(
      page.pattern,
      page.layouts,
      buildPageHandler(module, page, manifest.layouts, config, !!fsr)
    );
    if (module.actions) {
      adapter.registerAction(page.pattern, buildActionHandler(module.actions));
    }
  }

  // 4. Serve Silcrow browser runtime from @fsr/client (always)
  try {
    const silcrowPath = fileURLToPath(import.meta.resolve('@fsr/client/silcrow.js'));
    adapter.registerAsset('/_silcrow/silcrow.js', silcrowPath);
  } catch {
    // @fsr/client not installed — silcrow.js unavailable
  }

  // 5. Serve FSR live client script when FSR is active
  if (fsr) {
    adapter.registerPage('/_pilcrow/live.js', [], async (_req, res) => {
      res.headers['content-type'] = 'application/javascript; charset=utf-8';
      res.html(PILCROW_LIVE_CLIENT_SCRIPT);
    });
  }

  // 6. Register FSR SSE hubs
  if (fsr) {
    const { store, watcher } = fsr;
    adapter.registerSSE('/__pilcrow/fsr', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrHubStream } = await import('@fsr/engine' as any);
      const stream = fsrHubStream({
        route,
        slots,
        watcher,
        config: {
          maxConnections: config.fsr?.maxSseConnections ?? 1000,
          connectionTtlSecs: config.fsr?.connectionTtlSecs ?? 3600,
          keepaliveSecs: config.fsr?.keepaliveSecs ?? 30,
        },
      });
      res.sse(stream);
    });

    adapter.registerSSE('/__pilcrow/fsr/snapshot', async (req, res) => {
      const route = req.query.route || '';
      const slots = (req.query.slots || '').split(',').filter(Boolean);
      const { fsrSnapshotHandler } = await import('@fsr/engine' as any);
      const snapshot = await fsrSnapshotHandler(route, slots, store);
      res.json(snapshot);
    });
  } else {
    adapter.registerSSE('/__pilcrow/fsr', async (req, res) => {
      res.sse({
        async *[Symbol.asyncIterator]() {
          yield { event: 'ping', data: 'hello' };
        },
      });
    });
  }

  adapter.registerSSE('/__pilcrow/live/*', async (req, res) => {
    res.sse({
      async *[Symbol.asyncIterator]() {
        yield { event: 'ping', data: 'hello' };
      },
    });
  });

  return manifest;
}
