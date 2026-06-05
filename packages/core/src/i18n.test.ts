import { describe, expect, it } from 'bun:test';

describe('KilnI18n browser-visible dependencies', () => {
  it('uses pathe instead of the Node path builtin', async () => {
    const source = await Bun.file(new URL('./i18n.ts', import.meta.url)).text();
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();

    expect(source).toContain("from 'pathe'");
    expect(source).not.toMatch(/from ['"](?:node:)?path['"]/);
    expect(packageJson.dependencies.pathe).toBeDefined();
  });
});
