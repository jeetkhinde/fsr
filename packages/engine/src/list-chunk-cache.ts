import type { ListChunkCache } from '@kiln/core';

const DEFAULT_MAX_ENTRIES = 5_000;

/**
 * LRU-bounded: a Map preserves insertion order, so re-inserting a key on
 * every read/write keeps it "most recently used" at the end, and eviction
 * just deletes from the front. Row HTML is cheap to regenerate on a miss,
 * so bounding this trades a rare re-render for a hard memory ceiling.
 */
export class InMemoryListChunkCache implements ListChunkCache {
  private store = new Map<string, string>();

  constructor(private maxEntries = DEFAULT_MAX_ENTRIES) {}

  private key(list: string, rowKey: string): string { return `${list}:${rowKey}`; }

  private touch(key: string, html: string): void {
    this.store.delete(key);
    this.store.set(key, html);
  }

  get(list: string, key: string): string | null {
    const k = this.key(list, key);
    const html = this.store.get(k);
    if (html === undefined) return null;
    this.touch(k, html);
    return html;
  }

  set(list: string, key: string, html: string): void {
    const k = this.key(list, key);
    this.touch(k, html);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  delete(list: string, key: string): void {
    this.store.delete(this.key(list, key));
  }

  deleteList(list: string): void {
    const prefix = `${list}:`;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }
}
