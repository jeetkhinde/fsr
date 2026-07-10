import { describe, it, expect } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { kilnIslandsPlugin, listIslands, ISLAND_VIRTUAL_PREFIX } from './vite-plugin.js';

async function makeApp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-islands-'));
  await fs.mkdir(path.join(dir, 'islands'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'islands', 'Counter.tsx'),
    'export default function Counter() { return null; }',
  );
  await fs.writeFile(
    path.join(dir, 'islands', 'Chart.tsx'),
    'export default function Chart() { return null; }',
  );
  await fs.writeFile(path.join(dir, 'islands', 'Chart.test.tsx'), '// not an island');
  return dir;
}

function pluginFor(appRoot: string): any {
  return kilnIslandsPlugin({ appRoot });
}

const throwingCtx = {
  error(message: string): never {
    throw new Error(message);
  },
};

describe('kilnIslandsPlugin', () => {
  it('lists island basenames sorted, skipping test files', async () => {
    const appRoot = await makeApp();
    expect(listIslands(path.join(appRoot, 'islands'))).toEqual(['Chart', 'Counter']);
    await fs.rm(appRoot, { recursive: true, force: true });
  });

  it('resolves virtual island ids and emits a hydration wrapper module', async () => {
    const appRoot = await makeApp();
    const plugin = pluginFor(appRoot);

    const resolved = plugin.resolveId(ISLAND_VIRTUAL_PREFIX + 'Counter');
    expect(resolved).toBe('\0' + ISLAND_VIRTUAL_PREFIX + 'Counter');
    expect(plugin.resolveId('some-other-module')).toBeNull();

    const code = plugin.load.call(throwingCtx, resolved) as string;
    expect(code).toContain("import { hydrateRoot } from 'react-dom/client'");
    expect(code).toContain('Counter.tsx');
    expect(code).toContain('export function hydrate');
    await fs.rm(appRoot, { recursive: true, force: true });
  });

  it('errors on unknown island names', async () => {
    const appRoot = await makeApp();
    const plugin = pluginFor(appRoot);
    expect(() =>
      plugin.load.call(throwingCtx, '\0' + ISLAND_VIRTUAL_PREFIX + 'Nope'),
    ).toThrow('island "Nope" not found');
    await fs.rm(appRoot, { recursive: true, force: true });
  });

  it('rejects names that try to escape the islands directory', async () => {
    const appRoot = await makeApp();
    const plugin = pluginFor(appRoot);
    expect(() =>
      plugin.load.call(throwingCtx, '\0' + ISLAND_VIRTUAL_PREFIX + '../secrets'),
    ).toThrow('not found');
    await fs.rm(appRoot, { recursive: true, force: true });
  });
});
