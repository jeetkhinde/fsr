import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { encodeSeed, decodeSeed, assertSeedSafe } from './seed-codec.js';

describe('encodeSeed / decodeSeed', () => {
  it('round-trips plain JSON data', () => {
    const value = {
      title: 'Tasks',
      count: 3,
      done: false,
      tags: ['a', 'b'],
      nested: { deep: [1, 2, { x: null }] },
    };
    expect(decodeSeed<typeof value>(encodeSeed(value))).toEqual(value);
  });

  it('emits no raw "<" so payloads cannot terminate a script tag', () => {
    const value = { bio: 'hi</script><script>alert(1)</script>', tag: '<b>' };
    const encoded = encodeSeed(value);
    expect(encoded).not.toContain('<');
    expect(encoded).toContain('\\u003c');
    expect(decodeSeed<typeof value>(encoded)).toEqual(value);
  });

  it('encodes an unserializable top-level value as null instead of crashing', () => {
    expect(encodeSeed(undefined)).toBe('null');
    expect(encodeSeed(() => {})).toBe('null');
  });
});

describe('assertSeedSafe', () => {
  afterEach(() => {
    // restore any spies created inside tests
  });

  function collectWarnings(value: unknown): string[] {
    const spy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertSeedSafe(value, '/route');
      return spy.mock.calls.map((c) => String(c[0]));
    } finally {
      spy.mockRestore();
    }
  }

  it('is silent for plain JSON data', () => {
    expect(
      collectWarnings({ a: 1, b: 'x', c: [true, null, { d: 'y' }] }),
    ).toEqual([]);
  });

  it('warns for Date values with the seed path', () => {
    const warnings = collectWarnings({ createdAt: new Date() });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('"/route.createdAt"');
    expect(warnings[0]).toContain('Date');
  });

  it('warns for undefined, functions, Map/Set, bigint, and NaN', () => {
    const warnings = collectWarnings({
      missing: undefined,
      fn: () => {},
      lookup: new Map(),
      unique: new Set(),
      big: 1n,
      bad: NaN,
      list: [Infinity],
    });
    const joined = warnings.join('\n');
    expect(joined).toContain('/route.missing');
    expect(joined).toContain('/route.fn');
    expect(joined).toContain('/route.lookup');
    expect(joined).toContain('/route.unique');
    expect(joined).toContain('/route.big');
    expect(joined).toContain('/route.bad');
    expect(joined).toContain('/route.list[0]');
    expect(warnings.length).toBe(7);
  });

  it('does not throw or loop on cyclic values', () => {
    const value: any = { name: 'a' };
    value.self = value;
    expect(collectWarnings(value)).toEqual([]);
  });
});
