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

/** True only for a genuine tagged-template call: bun (like every JS engine)
 * gives the `strings` argument of a tagged template both array-ness AND a
 * `.raw` array property, which no other bun-sql calling convention does.
 * bun's SQL is callable several other ways — `sql(rawString)` (a plain
 * string, no `.join`), `sql(arrayForInsert)` / `sql(obj)` (Helper-style
 * value wrapping for interpolation, no `.raw`) — and all of those must be
 * recognized as non-template so the capture path never touches them. */
function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw);
}

/** A bun SQL client that records queried tables into the active capture scope
 * (withDepCapture). Outside a scope it is a plain client. Opt-in: apps that
 * keep `new SQL(url)` simply get no auto-deps. */
export function createKilnSql(url: string): SQL {
  const base = new SQL(url);
  const wrapped = (strings: unknown, ...values: unknown[]) => {
    // Only a real tagged-template call carries dep-capturable table names;
    // every other calling convention (raw string, Helper-style value/array
    // wrapping, etc.) passes through untouched — capturing nothing is safe
    // (never causes an under-invalidation; see extractTables), while
    // assuming every call is a template would crash on these shapes
    // whenever a capture scope is active (Plan 3 review Important #3).
    if (isTemplateStringsArray(strings)) {
      const scope = depScope.getStore();
      if (scope) for (const t of extractTables(strings.join(' ? '))) scope.add(t);
    }
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
