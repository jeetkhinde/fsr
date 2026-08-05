/**
 * Regression guard for the `kiln build` page glob.
 *
 * `kiln build` fed every `.ts`/`.tsx` under `pagesDir` to Vite as a browser
 * entry. Kiln has no page-level hydration, so nothing could load those chunks
 * — and any page importing server-only code failed the build. jags-list hit
 * it the first time it ran `kiln build`:
 *
 *   "AsyncLocalStorage" is not exported by "__vite-browser-external",
 *   imported by "../../packages/core/dist/sql.js"
 *
 * The fixture below reproduces exactly that shape: a page that imports a
 * server-only builtin, plus one island that must still build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { buildClientAssets, clientBuildConfig, listClientEntries } from './client-build.js';

// Fixtures live inside the repo, not os.tmpdir(): rollup resolves `react` and
// `react-dom/client` by walking up from the app root, and a detached temp dir
// has no node_modules above it.
const FIXTURE_PARENT = path.join(import.meta.dir, '..');

let appRoot = '';

beforeAll(() => {
  appRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, '.fixture-client-build-'));
  fs.mkdirSync(path.join(appRoot, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'islands'), { recursive: true });

  // A page that reaches server-only code, the way every real page does.
  fs.writeFileSync(
    path.join(appRoot, 'pages', 'index.tsx'),
    `import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export async function load() { return { scoped: scope !== null }; }
export default function Page({ scoped }: { scoped: boolean }) { return <p>{String(scoped)}</p>; }
`,
  );

  fs.writeFileSync(
    path.join(appRoot, 'islands', 'Widget.tsx'),
    `export default function Widget() { return <button type="button">hi</button>; }
`,
  );
});

afterAll(() => {
  if (appRoot) fs.rmSync(appRoot, { recursive: true, force: true });
});

describe('client build entries', () => {
  it('counts islands as the only client entries — never page modules', () => {
    expect(listClientEntries(appRoot)).toEqual(['Widget']);
  });

  it('hands Vite no explicit input, leaving entries to the islands plugin', () => {
    // If someone re-adds a page glob here, this is what changes first.
    expect(clientBuildConfig(appRoot).build?.rollupOptions?.input).toBeUndefined();
  });

  it('builds an app whose pages import server-only modules', async () => {
    const built = await buildClientAssets(appRoot);
    expect(built).toEqual(['Widget']);

    const manifestPath = path.join(appRoot, 'dist', 'client', 'kiln-islands.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(Object.keys(manifest.islands ?? manifest)).toContain('Widget');
  }, 60_000);

  it('skips the client build entirely for an app with no islands', async () => {
    const bare = fs.mkdtempSync(path.join(FIXTURE_PARENT, '.fixture-no-islands-'));
    fs.mkdirSync(path.join(bare, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'pages', 'index.tsx'), 'export default () => null;\n');
    try {
      expect(await buildClientAssets(bare)).toBeNull();
      expect(fs.existsSync(path.join(bare, 'dist'))).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
