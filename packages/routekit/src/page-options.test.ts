import { describe, expect, it } from 'bun:test';
import { extractPageOptions } from './page-options.js';

describe('extractPageOptions', () => {
  it('reads canonical snake_case lifecycle exports', () => {
    const opts = extractPageOptions({
      revalidate: false,
      debounce: 4,
      purge_after: 90,
    });
    expect(opts.revalidate).toBe(false);
    expect(opts.debounce).toBe(4);
    expect(opts.purgeAfter).toBe(90);
  });
});

describe('extractPageOptions bake parsing', () => {
  it('returns undefined bake (auto) when nothing is exported', () => {
    expect(extractPageOptions({}).bake).toBeUndefined();
  });

  it.each([['static'], ['shared'], [false]] as const)('accepts bake=%p', (v) => {
    expect(extractPageOptions({ bake: v }).bake).toBe(v as any);
  });

  it('throws StartupError on promote_after', () => {
    expect(() => extractPageOptions({ promote_after: 2 })).toThrow(/promote_after has been removed/);
    expect(() => extractPageOptions({ promote_after: false })).toThrow(/promote_after has been removed/);
  });

  it('throws StartupError on legacy promoteAfter', () => {
    expect(() => extractPageOptions({ promoteAfter: 2 })).toThrow(/promote_after has been removed/);
  });

  it('throws StartupError on an invalid bake value', () => {
    expect(() => extractPageOptions({ bake: 2 })).toThrow(/invalid bake/);
    expect(() => extractPageOptions({ bake: 'always' })).toThrow(/invalid bake/);
  });
});
