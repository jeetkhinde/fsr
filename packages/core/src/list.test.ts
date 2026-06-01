import { describe, it, expect } from 'bun:test';
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
