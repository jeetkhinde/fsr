import { describe, expect, it } from 'bun:test';
import { Live, getLiveListMeta } from '@kiln/core';
import { collectDeps } from '@kiln/core/sql';
import { materializeLiveLists } from './live-registration.js';

/** Stand-in for FsrStore: runs the query the way the real one does
 * (`query({ sql, signal })`) without needing Postgres. */
function fakeStore() {
  return {
    executeLiveListQuery: async (query: any) => {
      const rows = await query({ sql: null });
      if (!Array.isArray(rows)) throw new Error('Live.list query must return an array');
      return rows;
    },
  } as any;
}

describe('materializeLiveLists auto-deps', () => {
  it('captures the tables a list query touches', async () => {
    const list = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('activity');
        return [{ id: 1 }];
      },
    });

    const out = await materializeLiveLists({ events: list }, fakeStore());

    expect(getLiveListMeta(out.events)?.autoDeps).toEqual(['activity']);
  });

  it('captures for a list that declares no initial rows', async () => {
    // The case page-level capture would miss: `initial` is optional, and the
    // page's own capture scope wraps only load(), not the list's query.
    const list = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('tasks');
        return [{ id: 9 }];
      },
    });

    const out = await materializeLiveLists({ items: list }, fakeStore());

    expect(getLiveListMeta(out.items)?.autoDeps).toEqual(['tasks']);
    expect([...out.items]).toEqual([{ id: 9 }]);
  });

  it('keeps two lists on one page from contaminating each other', async () => {
    const a = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('activity');
        return [{ id: 1 }];
      },
    });
    const b = Live.list<{ id: number }>({
      key: (row) => row.id,
      query: () => {
        collectDeps()?.add('tasks');
        return [{ id: 2 }];
      },
    });

    const out = await materializeLiveLists({ a, b }, fakeStore());

    expect(getLiveListMeta(out.a)?.autoDeps).toEqual(['activity']);
    expect(getLiveListMeta(out.b)?.autoDeps).toEqual(['tasks']);
  });

  it('preserves an explicit dependsOn alongside the captured tables', async () => {
    const list = Live.list<{ id: number }>({
      key: (row) => row.id,
      dependsOn: 'explicit_table',
      query: () => {
        collectDeps()?.add('activity');
        return [{ id: 1 }];
      },
    });

    const out = await materializeLiveLists({ events: list }, fakeStore());
    const meta = getLiveListMeta(out.events)!;

    expect(meta.dependsOn).toEqual(['explicit_table']);
    expect(meta.autoDeps).toEqual(['activity']);
  });

  it('leaves non-list values untouched', async () => {
    const out = await materializeLiveLists({ title: 'hello', n: 3 }, fakeStore());
    expect(out).toEqual({ title: 'hello', n: 3 });
  });
});
