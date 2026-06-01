import { describe, it, expect } from 'bun:test';
import { ListBroadcast } from './list-broadcast.js';
import type { KilnListRow, ListPatchEvent } from '@kiln/core';

interface Contact extends KilnListRow {
  name: string;
  online: boolean;
}

describe('ListBroadcast', () => {
  it('fans out row changes to all subscribers', async () => {
    const bc = new ListBroadcast<Contact>('contacts');
    const received: ListPatchEvent[] = [];
    const unsub = bc.subscribe(e => received.push(e));

    bc.sendRow({ __key: '123', __liveFields: ['name', 'online'], name: 'Alice', online: true });

    await new Promise(r => setTimeout(r, 0)); // flush microtasks
    expect(received).toHaveLength(1);
    expect(received[0].key).toBe('123');
    expect(received[0].changes.name).toBe('Alice');
    expect(received[0].changes.online).toBe(true);
    unsub();
  });

  it('only includes __liveFields in changes', async () => {
    const bc = new ListBroadcast<Contact>('contacts');
    const received: ListPatchEvent[] = [];
    const unsub = bc.subscribe(e => received.push(e));

    bc.sendRow({ __key: '123', __liveFields: ['online'], name: 'Alice', online: false });

    await new Promise(r => setTimeout(r, 0));
    expect(received[0].changes).toHaveProperty('online');
    expect(received[0].changes).not.toHaveProperty('name');
    unsub();
  });
});
