import type { KilnListRow } from '@kiln/core';
import type { ListPatch } from '@kiln/live';

type Subscriber = (event: ListPatch) => void;

export class ListBroadcast<T extends KilnListRow> {
  private subscribers = new Set<Subscriber>();

  constructor(
    private readonly route: string,
    private readonly listName: string,
  ) {}

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  sendRow(row: T): void {
    const changes: Record<string, any> = {};
    for (const field of row.__liveFields) {
      changes[field] = row[field];
    }
    const event: ListPatch = {
      kind: 'list',
      op: 'fields',
      route: this.route,
      list: this.listName,
      key: row.__key,
      changes,
    };
    for (const sub of this.subscribers) {
      try { sub(event); } catch { /* subscriber errors must not break broadcast */ }
    }
  }

  get listKey(): string { return this.listName; }
}
