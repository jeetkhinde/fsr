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
    const hasReact = paths.some(p => p.includes('react'));
    expect(hasReact).toBe(false);
    await fs.rm(dir, { recursive: true });
  });
});
