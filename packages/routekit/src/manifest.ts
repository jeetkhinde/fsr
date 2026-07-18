import type { LiveFieldMeta } from '@kiln/core';

export interface PageRoute {
  pattern: string;
  filePath: string;
  relativePath: string;
  layouts: string[];
  bake?: 'static' | 'shared' | false;
  pinInRedis?: boolean;
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
