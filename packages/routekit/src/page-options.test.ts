import { describe, expect, it, spyOn } from 'bun:test';
import { extractPageOptions } from './page-options.js';

describe('extractPageOptions', () => {
  it('reads canonical snake_case lifecycle exports', () => {
    expect(extractPageOptions({
      promote_after: false,
      revalidate: false,
      debounce: 4,
      purge_after: 90,
    })).toEqual({
      promoteAfter: false,
      revalidate: false,
      debounce: 4,
      purgeAfter: 90,
    });
  });

  it('keeps promoteAfter as a deprecated alias', () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractPageOptions({ promoteAfter: 3 }).promoteAfter).toBe(3);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
