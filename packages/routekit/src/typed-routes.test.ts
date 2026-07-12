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
    // Keys are quoted (safe against segments that aren't valid bare
    // identifiers, e.g. a leading digit or non-alphanumeric characters).
    expect(code).toContain("'home': '/'");
    expect(code).toContain("'about': '/about'");
  });

  it('generates dynamic routes as typed functions', () => {
    const code = generateTypedRoutes(manifest);
    expect(code).toContain("'contactsId': (id: string)");
    expect(code).toContain("'contactsIdEdit': (id: string)");
  });
});
