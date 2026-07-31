import { describe, expect, it } from 'bun:test';
import { Live, getLiveListMeta } from '@kiln/core';
import { collectDeps } from '@kiln/core/sql';
import { materializeLiveLists, registerLiveLists, resolveListDeps } from './live-registration.js';

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

describe('resolveListDeps', () => {
  it('unions explicit deps with captured ones', () => {
    const meta = { dependsOn: ['explicit_table'], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, true).sort()).toEqual(['activity', 'explicit_table']);
  });

  it('drops captured deps when auto-deps is disabled, keeping explicit ones', () => {
    const meta = { dependsOn: ['explicit_table'], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, false)).toEqual(['explicit_table']);
  });

  it('deduplicates when a table is both declared and captured', () => {
    const meta = { dependsOn: ['activity'], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, true)).toEqual(['activity']);
  });

  it('returns captured deps when nothing was declared', () => {
    const meta = { dependsOn: [], autoDeps: ['activity'] } as any;
    expect(resolveListDeps(meta, true)).toEqual(['activity']);
  });

  it('returns an empty list when there is nothing at all', () => {
    const meta = { dependsOn: [] } as any;
    expect(resolveListDeps(meta, true)).toEqual([]);
  });
});

/** Minimal watcher that records what it was asked to register. */
function fakeWatcher() {
  const calls: any[] = [];
  return {
    calls,
    registerLiveList: async (target: any, snapshot: any) => {
      calls.push({ target, snapshot });
    },
  } as any;
}

/** HTML in the shape extractLiveListRowHtml expects: a container carrying
 * data-kiln-list, with rows carrying data-kiln-key. */
const LIST_HTML = '<ul data-kiln-list="events"><li data-kiln-key="1">one</li></ul>';

function listWith(opts: { dependsOn?: string; autoDeps?: string[]; revalidate?: number | false }) {
  const list = Live.list<{ id: number }>({
    key: (row) => row.id,
    ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
    ...(opts.revalidate !== undefined ? { revalidate: opts.revalidate } : {}),
    initial: [{ id: 1 }],
    query: () => [{ id: 1 }],
  });
  if (opts.autoDeps) (getLiveListMeta(list) as any).autoDeps = opts.autoDeps;
  return list;
}

async function register(route: string, list: any, extra: Record<string, unknown> = {}) {
  const watcher = fakeWatcher();
  await registerLiveLists({
    route,
    pageComponent: () => null,
    pageProps: { events: list },
    finalHtml: LIST_HTML,
    htmlPath: null,
    jsonPath: null,
    watcher,
    ...extra,
  } as any);
  return watcher;
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

describe('registerLiveLists empty-dependency warning', () => {
  it('registers the unioned deps on the watcher target', async () => {
    const watcher = await register('/r1', listWith({ dependsOn: 'explicit', autoDeps: ['activity'] }));

    expect(watcher.calls).toHaveLength(1);
    expect([...watcher.calls[0].target.dependsOn].sort()).toEqual(['activity', 'explicit']);
    expect([...watcher.calls[0].snapshot.dependsOn].sort()).toEqual(['activity', 'explicit']);
  });

  it('warns when a list has neither declared nor captured deps', async () => {
    const w = captureWarnings();
    try {
      await register('/r2', listWith({}));
    } finally {
      w.restore();
    }

    expect(w.warnings.some((m) => m.includes('has no dependencies'))).toBe(true);
    expect(w.warnings.some((m) => m.includes('revalidate timer'))).toBe(true);
  });

  it('says the list will never update when revalidate is false', async () => {
    const w = captureWarnings();
    try {
      await register('/r3', listWith({ revalidate: false }));
    } finally {
      w.restore();
    }

    expect(w.warnings.some((m) => m.includes('will never update'))).toBe(true);
  });

  it('does not warn when deps were captured', async () => {
    const w = captureWarnings();
    try {
      await register('/r4', listWith({ autoDeps: ['activity'] }));
    } finally {
      w.restore();
    }

    expect(w.warnings.some((m) => m.includes('has no dependencies'))).toBe(false);
  });

  it('warns only once for the same route and list', async () => {
    const w = captureWarnings();
    try {
      await register('/r5', listWith({}));
      await register('/r5', listWith({}));
    } finally {
      w.restore();
    }

    expect(w.warnings.filter((m) => m.includes('has no dependencies'))).toHaveLength(1);
  });
});
