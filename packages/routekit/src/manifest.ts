import type { LiveFieldMeta } from '@kiln/core';

export interface PageRoute {
  pattern: string;
  filePath: string;
  relativePath: string;
  layouts: string[];
  promoteAfter?: number;
  liveFields: LiveFieldMeta[];
}

export interface LayoutNode {
  filePath: string;
  relativePath: string;
  pattern: string; // The URL prefix/pattern this layout applies to
}

export interface RouteManifest {
  pages: PageRoute[];
  layouts: LayoutNode[];
  errorPages: Record<string, string>; // Maps relative directory paths to error page filePaths
  loadingPages: Record<string, string>; // Maps relative directory paths to loading page filePaths
  notFoundPages: Record<string, string>; // Maps relative directory paths to 404 page filePaths
}
