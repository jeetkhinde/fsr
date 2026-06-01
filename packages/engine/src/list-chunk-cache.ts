import type { ListChunkCache } from '@kiln/core';

export class InMemoryListChunkCache implements ListChunkCache {
  private store = new Map<string, string>();

  private key(list: string, rowKey: string): string { return `${list}:${rowKey}`; }

  get(list: string, key: string): string | null {
    return this.store.get(this.key(list, key)) ?? null;
  }

  set(list: string, key: string, html: string): void {
    this.store.set(this.key(list, key), html);
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
