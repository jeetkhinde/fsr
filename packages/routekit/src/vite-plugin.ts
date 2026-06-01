import type { Plugin } from 'vite';

export interface KilnVitePluginOptions {
  pagesDir: string;
  onRoutesChanged?: () => void | Promise<void>;
}

export function kilnVitePlugin(options: KilnVitePluginOptions): Plugin {
  return {
    name: 'vite-plugin-kiln',
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
