import { describe, it, expect } from 'bun:test';
import { Live } from './live-prop.js';
import { cloneLiveListRows, getLiveListMeta } from './list.js';
import type { KilnListRow, ListPatchEvent } from './list.js';

describe('list types', () => {
  it('KilnListRow has key and live fields', () => {
    const row: KilnListRow = { __key: 'abc', __liveFields: ['name', 'count'] };
    expect(row.__key).toBe('abc');
    expect(row.__liveFields).toContain('name');
  });

  it('ListPatchEvent has list, key, and changed fields', () => {
    const event: ListPatchEvent = {
      list: 'contacts',
      key: '123',
      changes: { name: 'Alice', favorite: true },
    };
    expect(event.list).toBe('contacts');
    expect(event.changes.name).toBe('Alice');
  });
});

function makeList() {
  return Live.list<{ id: number }>({
    key: (row) => row.id,
    dependsOn: 'activity',
    initial: [{ id: 1 }],
    query: () => [{ id: 1 }],
  });
}

describe('cloneLiveListRows', () => {
  it('preserves the source meta when no extra meta is given', () => {
    const source = makeList();
    const clone = cloneLiveListRows(source, [{ id: 2 }]);

    expect([...clone]).toEqual([{ id: 2 }]);
    expect(getLiveListMeta(clone)?.dependsOn).toEqual(['activity']);
    expect(getLiveListMeta(clone)?.autoDeps).toBeUndefined();
  });

  it('carries autoDeps onto the clone', () => {
    const source = makeList();
    const clone = cloneLiveListRows(source, [{ id: 1 }], { autoDeps: ['activity', 'user'] });

    expect(getLiveListMeta(clone)?.autoDeps).toEqual(['activity', 'user']);
    expect(getLiveListMeta(clone)?.dependsOn).toEqual(['activity']);
  });

  it('does not mutate the source meta — capture is per-request, the meta is shared', () => {
    const source = makeList();
    cloneLiveListRows(source, [{ id: 1 }], { autoDeps: ['activity'] });

    expect(getLiveListMeta(source)?.autoDeps).toBeUndefined();
  });

  it('keeps keyOf and query callable on the clone', () => {
    const source = makeList();
    const clone = cloneLiveListRows(source, [{ id: 7 }], { autoDeps: ['activity'] });
    const meta = getLiveListMeta(clone)!;

    expect(meta.keyOf({ id: 7 })).toBe('7');
    expect(meta.query({})).toEqual([{ id: 1 }]);
  });
});
