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

/** Query shapes already warned about. Deduped and bounded: an unparseable
 * table reference is a property of the CODE, not of the request, so the same
 * call site firing thousands of times adds nothing after the first. */
const warnedUnresolved = new Set<string>();

/** Over-capture costs an extra revalidation; under-capture serves stale data
 * with nothing logged anywhere. A dynamically-interpolated table name —
 * sql("name"), which reaches the template as a bound `?` — is invisible to
 * extractTables, so it is exactly that silent direction and deserves a word. */
function warnUnresolvedTableRef(query: string): void {
  // A query that touches no table at all (SELECT 1, SELECT now()) is not a
  // miss — warning on those turns this into noise people learn to scroll past.
  if (!/\b(?:from|join|into|update)\b/i.test(query)) return;
  if (warnedUnresolved.has(query) || warnedUnresolved.size >= 100) return;
  warnedUnresolved.add(query);
  console.warn(
    `[kiln] auto-deps found no table in: ${query.trim()}\n` +
    `  A dynamically-interpolated table name is invisible to dependency capture, so live ` +
    `fields on this page will not revalidate when that table changes. Give the field an ` +
    `explicit dependsOn.`,
  );
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
      if (scope) {
        const query = strings.join(' ? ');
        const found = extractTables(query);
        if (found.length === 0) warnUnresolvedTableRef(query);
        for (const t of found) scope.add(t);
      }
    }
    return (base as any)(strings, ...values);
  };
  // Preserve helpers (.begin, .unsafe, .close, .end, etc.) by proxying misses.
  // Bound functions are memoized per property: re-binding on every access
  // made `sql.unsafe !== sql.unsafe`, which breaks identity comparison and
  // any caller memoizing on the reference, and allocated a closure per read.
  const boundCache = new Map<string | symbol, unknown>();
  return new Proxy(wrapped as any, {
    get(_t, prop) {
      const v = (base as any)[prop];
      if (typeof v !== 'function') return v;
      let bound = boundCache.get(prop);
      if (bound === undefined) {
        bound = v.bind(base);
        boundCache.set(prop, bound);
      }
      return bound;
    },
  }) as unknown as SQL;
}
