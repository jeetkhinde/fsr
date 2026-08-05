/**
 * `hasRegisteredRoute` is what page-render.ts:365 asks before serving a baked
 * artifact: "does the watcher already hold the closures that keep this route
 * fresh?" A false answer costs a full re-render — the artifact is written and
 * then ignored.
 *
 * It used to scan `liveListTargets` only, so a page whose live fields are
 * scalar LiveProps (including every `target: 'store'` field an island reads)
 * never reported as registered and re-rendered on EVERY request, forever.
 * Reproduced on test-app's own /islands-demo, whose `bakedAt` timestamp
 * changed on every hit despite a valid artifact on disk.
 */
import { describe, expect, it } from 'bun:test';
import { FsrWatcher } from './watcher.js';

function watcher(): FsrWatcher {
  // Registration and lookup are in-memory; registerLiveList is the only path
  // that touches the store, and only to read/write its snapshot.
  const store = {
    lists: {
      getSnapshot: async () => null,
      upsertSnapshot: async () => {},
    },
  };
  return new FsrWatcher(store as any, null, { scheduledInvalidations: [] } as any);
}

describe('FsrWatcher.hasRegisteredRoute', () => {
  it('reports a route registered through registerLoader (scalar LiveProps)', () => {
    const w = watcher();
    expect(w.hasRegisteredRoute('/projects/7/board')).toBe(false);

    w.registerLoader({ route: '/projects/7/board', load: async () => ({}) });

    expect(w.hasRegisteredRoute('/projects/7/board')).toBe(true);
  });

  it('still reports a route registered only through a live list', async () => {
    const w = watcher();
    await w.registerLiveList(
      {
        route: '/projects/7/activity',
        name: 'events',
        dependsOn: ['activity'],
        load: async () => [],
        renderRow: () => '',
      } as any,
      { rows: [], version: 1 } as any,
    );
    expect(w.hasRegisteredRoute('/projects/7/activity')).toBe(true);
  });

  it('keeps per-user loaders distinct, so one user does not vouch for another', () => {
    // bake='user' routes register one loader per user. Answering "registered"
    // for a user who has none would serve them a cached artifact and never
    // register their loader — it would then never be revalidated.
    const w = watcher();
    w.registerLoader({ route: '/', userKey: 'tom', load: async () => ({}) });

    expect(w.hasRegisteredRoute('/', 'tom')).toBe(true);
    expect(w.hasRegisteredRoute('/', 'adam')).toBe(false);
  });

  it('does not confuse the shared variant with a per-user one', () => {
    const w = watcher();
    w.registerLoader({ route: '/', userKey: 'tom', load: async () => ({}) });
    expect(w.hasRegisteredRoute('/')).toBe(false);
  });

  it('forgets a route once its loader is unregistered', () => {
    const w = watcher();
    w.registerLoader({ route: '/projects/7/board', load: async () => ({}) });
    w.unregisterLoader('/projects/7/board');
    expect(w.hasRegisteredRoute('/projects/7/board')).toBe(false);
  });
});
