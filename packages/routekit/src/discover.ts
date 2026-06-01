import * as path from 'path';
import fg from 'fast-glob';
import type { RouteManifest, PageRoute, LayoutNode } from './manifest.js';

export interface RawDiscoveredFile {
  filePath: string;
  relativePath: string;
  dirRelativePath: string; // e.g. "posts" or ""
  fileName: string;
}

export function pathToPattern(relativePath: string): string {
  // 1. Remove extension
  let normalized = relativePath.replace(/\.[a-zA-Z0-9]+$/, '');

  // 2. Normalize backslashes (Windows) to forward slashes
  normalized = normalized.replace(/\\/g, '/');

  // 3. Remove route groups, e.g. (admin)/dashboard -> /dashboard
  normalized = normalized.replace(/\/\([^)]+\)/g, '/');
  normalized = normalized.replace(/^\([^)]+\)\/?/, '');

  // 4. Handle index segments: e.g. posts/index -> posts, index -> ""
  if (normalized.endsWith('/index')) {
    normalized = normalized.slice(0, -6);
  } else if (normalized === 'index') {
    normalized = '';
  }

  // 5. Replace dynamic segments [id] -> :id, [...path] -> *
  normalized = normalized.replace(/\[([^\]]+)\]/g, (_, name) => {
    if (name.startsWith('...')) {
      return '*';
    }
    const cleanName = name.split('=')[0];
    return `:${cleanName}`;
  });

  let pattern = '/' + normalized;
  pattern = pattern.replace(/\/+/g, '/');
  if (pattern.length > 1 && pattern.endsWith('/')) {
    pattern = pattern.slice(0, -1);
  }

  return pattern;
}

export async function walkDir(dir: string): Promise<RawDiscoveredFile[]> {
  let relPaths: string[];
  try {
    relPaths = await fg('**/*.{tsx,ts,jsx,js,html}', {
      cwd: dir,
      ignore: ['node_modules/**', '.git/**', 'dist/**'],
      onlyFiles: true,
    });
  } catch {
    return [];
  }

  return relPaths.map((relPath) => {
    const dirRel = path.dirname(relPath);
    return {
      filePath: path.join(dir, relPath),
      relativePath: relPath,
      dirRelativePath: dirRel === '.' ? '' : dirRel,
      fileName: path.basename(relPath),
    };
  });
}

function getLayoutsForPage(
  pageRelPath: string,
  availableLayouts: Map<string, string>
): string[] {
  const layouts: string[] = [];
  const dirParts = path.dirname(pageRelPath).split(path.sep).filter(Boolean);

  const rootLayout = availableLayouts.get('');
  if (rootLayout) {
    layouts.push(rootLayout);
  }

  let currentDir = '';
  for (const part of dirParts) {
    currentDir = currentDir ? path.join(currentDir, part) : part;
    const layout = availableLayouts.get(currentDir);
    if (layout) {
      layouts.push(layout);
    }
  }

  return layouts;
}

export async function discoverRoutes(pagesDir: string): Promise<RouteManifest> {
  const rawFiles = await walkDir(pagesDir);
  
  const pages: PageRoute[] = [];
  const layouts: LayoutNode[] = [];
  const errorPages: Record<string, string> = {};
  const loadingPages: Record<string, string> = {};
  const notFoundPages: Record<string, string> = {};

  const availableLayouts = new Map<string, string>();

  // First pass: identify layouts, errors, etc.
  for (const file of rawFiles) {
    const baseName = path.basename(file.fileName, path.extname(file.fileName));
    const dirRel = file.dirRelativePath;

    if (baseName === '_layout') {
      availableLayouts.set(dirRel, file.filePath);
      layouts.push({
        filePath: file.filePath,
        relativePath: file.relativePath,
        pattern: pathToPattern(dirRel),
      });
    } else if (baseName === '_error') {
      errorPages[dirRel] = file.filePath;
    } else if (baseName === '_loading') {
      loadingPages[dirRel] = file.filePath;
    } else if (baseName === '_not-found') {
      notFoundPages[dirRel] = file.filePath;
    }
  }

  // Second pass: build routable pages and connect layout chains
  for (const file of rawFiles) {
    const baseName = path.basename(file.fileName, path.extname(file.fileName));
    if (['_layout', '_error', '_loading', '_not-found'].includes(baseName)) {
      continue;
    }

    const pattern = pathToPattern(file.relativePath);
    const pageLayouts = getLayoutsForPage(file.relativePath, availableLayouts);

    pages.push({
      pattern,
      filePath: file.filePath,
      relativePath: file.relativePath,
      layouts: pageLayouts,
      liveFields: [], // Extracted at runtime or build time in Milestone 3.3
    });
  }

  // Sort pages so static routes have priority over dynamic/wildcard routes
  pages.sort((a, b) => {
    // Dynamic segments and wildcards should have lower priority (come later)
    const aScore = getRoutePriorityScore(a.pattern);
    const bScore = getRoutePriorityScore(b.pattern);
    if (aScore !== bScore) {
      return bScore - aScore; // higher score first
    }
    return a.pattern.localeCompare(b.pattern);
  });

  return {
    pages,
    layouts,
    errorPages,
    loadingPages,
    notFoundPages,
  };
}

function getRoutePriorityScore(pattern: string): number {
  let score = 100;
  if (pattern.includes('*')) {
    score -= 50; // wildcard has lowest priority
  }
  if (pattern.includes(':')) {
    score -= 20; // dynamic parameter has lower priority than static
  }
  return score;
}
