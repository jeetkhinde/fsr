import type { Plugin } from 'vite';

export interface PilcrowVitePluginOptions {
  pagesDir: string;
  onRoutesChanged?: () => void | Promise<void>;
}

export function pilcrowVitePlugin(options: PilcrowVitePluginOptions): Plugin {
  return {
    name: 'vite-plugin-pilcrow',
    configureServer(server) {
      const handleFileChange = async (filePath: string) => {
        if (filePath.startsWith(options.pagesDir)) {
          if (options.onRoutesChanged) {
            await options.onRoutesChanged();
          }
        }
      };

      server.watcher.on('add', handleFileChange);
      server.watcher.on('unlink', handleFileChange);
    },
    handleHotUpdate(ctx) {
      if (ctx.file.startsWith(options.pagesDir)) {
        // Return modules to hot-reload in the browser
        return ctx.modules;
      }
    },
  };
}
