import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createScalarPatch, type ListPatch } from '@kiln/live';
import { fsrHubStream, getActiveConnectionsCount } from './hub.js';

class FakeWatcher {
  private emitter = new EventEmitter();
  getEmitter() {
    return this.emitter;
  }
}

describe('fsrHubStream live patch payloads', () => {
  it('streams scalar patches as live events and list patches as list-patch events', async () => {
    const watcher = new FakeWatcher();
    const gen = fsrHubStream({
      route: '/tasks',
      slots: ['status', 'todos'],
      watcher: watcher as any,
      config: { maxConnections: 10, connectionTtlSecs: 10, keepaliveSecs: 10 }
    });

    const received: any[] = [];
    const streamPromise = (async () => {
      for await (const item of gen) {
        received.push(item);
        if (received.length === 2) break;
      }
    })();

    watcher.getEmitter().emit('patch', createScalarPatch('/tasks', 'status', 'complete'));
    watcher.getEmitter().emit('patch', {
      kind: 'list',
      op: 'fields',
      route: '/tasks',
      list: 'todos',
      key: '1',
      changes: { status: 'complete' }
    } satisfies ListPatch);

    await streamPromise;
    await gen.return(undefined);

    expect(received).toEqual([
      {
        event: 'live',
        data: JSON.stringify({
          kind: 'scalar',
          route: '/tasks',
          field: 'status',
          value: 'complete'
        })
      },
      {
        event: 'list-patch',
        data: JSON.stringify({
          kind: 'list',
          op: 'fields',
          route: '/tasks',
          list: 'todos',
          key: '1',
          changes: { status: 'complete' }
        })
      }
    ]);
  });

  it('cleans up the listener when the request is aborted', async () => {
    const watcher = new FakeWatcher();
    const controller = new AbortController();
    const gen = fsrHubStream({
      route: '/tasks',
      slots: ['todos'],
      watcher: watcher as any,
      signal: controller.signal,
      config: { maxConnections: 10, connectionTtlSecs: 10, keepaliveSecs: 10 }
    });

    const pending = gen.next();
    await Promise.resolve();
    expect(watcher.getEmitter().listenerCount('patch')).toBe(1);

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(watcher.getEmitter().listenerCount('patch')).toBe(0);
    expect(getActiveConnectionsCount()).toBe(0);
  });
});
