import { AsyncLocalStorage } from 'node:async_hooks';
import { SQL } from 'bun';

const depScope = new AsyncLocalStorage<Set<string>>();

/** Tables named after FROM / JOIN / INTO / UPDATE in a SQL string. Best-effort
 * and case-insensitive; schema-qualified names keep only the table part.
 * Over-capture (an extra table) only causes an extra revalidation, never a
 * stale serve, so a loose regex is the safe failure direction. */
export function extractTables(query: string): string[] {
  const cleaned = query.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?"?([a-zA-Z_][\w.]*)"?/gi;
  const out = new Set<string>();
  for (const m of cleaned.matchAll(re)) {
    const name = m[1].toLowerCase().split('.').pop()!;
    out.add(name);
  }
  return [...out];
}

export function collectDeps(): Set<string> | null {
  return depScope.getStore() ?? null;
}

export async function withDepCapture<T>(fn: () => Promise<T>): Promise<{ result: T; tables: Set<string> }> {
  const tables = new Set<string>();
  const result = await depScope.run(tables, fn);
  return { result, tables };
}

/** A bun SQL client that records queried tables into the active capture scope
 * (withDepCapture). Outside a scope it is a plain client. Opt-in: apps that
 * keep `new SQL(url)` simply get no auto-deps. */
export function createKilnSql(url: string): SQL {
  const base = new SQL(url);
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const scope = depScope.getStore();
    if (scope) for (const t of extractTables(strings.join(' ? '))) scope.add(t);
    return (base as any)(strings, ...values);
  };
  // Preserve helpers (.begin, .unsafe, .close, .end, etc.) by proxying misses.
  return new Proxy(wrapped as any, {
    get(_t, prop) {
      const v = (base as any)[prop];
      return typeof v === 'function' ? v.bind(base) : v;
    },
  }) as unknown as SQL;
}
