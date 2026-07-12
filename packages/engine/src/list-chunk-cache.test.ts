import { describe, it, expect } from 'bun:test';
import { InMemoryListChunkCache } from './list-chunk-cache.js';

describe('InMemoryListChunkCache', () => {
  it('stores and retrieves row HTML by list + key', () => {
    const cache = new InMemoryListChunkCache();
    cache.set('contacts', 'row-1', '<li>Alice</li>');
    expect(cache.get('contacts', 'row-1')).toBe('<li>Alice</li>');
    expect(cache.get('contacts', 'row-2')).toBeNull();
  });

  it('delete removes a single row', () => {
    const cache = new InMemoryListChunkCache();
    cache.set('contacts', 'row-1', '<li>Alice</li>');
    cache.delete('contacts', 'row-1');
    expect(cache.get('contacts', 'row-1')).toBeNull();
  });

  it('deleteList removes only rows under that list', () => {
    const cache = new InMemoryListChunkCache();
    cache.set('contacts', 'row-1', '<li>Alice</li>');
    cache.set('other', 'row-1', '<li>Bob</li>');
    cache.deleteList('contacts');
    expect(cache.get('contacts', 'row-1')).toBeNull();
    expect(cache.get('other', 'row-1')).toBe('<li>Bob</li>');
  });

  it('evicts the least-recently-used entry once past maxEntries', () => {
    const cache = new InMemoryListChunkCache(2);
    cache.set('l', 'a', 'A');
    cache.set('l', 'b', 'B');
    cache.set('l', 'c', 'C'); // evicts 'a' (oldest, untouched)
    expect(cache.get('l', 'a')).toBeNull();
    expect(cache.get('l', 'b')).toBe('B');
    expect(cache.get('l', 'c')).toBe('C');
  });

  it('a read marks an entry as recently used, protecting it from eviction', () => {
    const cache = new InMemoryListChunkCache(2);
    cache.set('l', 'a', 'A');
    cache.set('l', 'b', 'B');
    cache.get('l', 'a'); // touch 'a' -> now more recent than 'b'
    cache.set('l', 'c', 'C'); // should evict 'b', not 'a'
    expect(cache.get('l', 'a')).toBe('A');
    expect(cache.get('l', 'b')).toBeNull();
    expect(cache.get('l', 'c')).toBe('C');
  });
});
