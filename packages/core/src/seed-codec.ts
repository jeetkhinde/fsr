/**
 * Single serialization boundary for anything Kiln embeds in HTML (ADR-014
 * invariant I-8): the page seed (`window.__kiln_seed`) and island props
 * (`data-kiln-props`). Nothing outside this module may embed a bare
 * `JSON.stringify` result into markup.
 *
 * v1 codec is plain JSON with every `<` escaped as its JSON unicode escape,
 * so an embedded string containing a closing script tag (or an HTML comment
 * opener) cannot terminate the surrounding tag and inject markup (XSS).
 * `JSON.parse` reads the escape transparently, so decoding is a plain parse.
 *
 * Reserved: codecVersion 2 — a devalue-style codec with Date/Map/Set
 * support. Introducing it must bump BAKED_SNAPSHOT_VERSION in @kiln/engine,
 * since cached snapshots on disk/Redis would otherwise decode incorrectly.
 */

export function encodeSeed(value: unknown): string {
  const json = JSON.stringify(value);
  // JSON.stringify returns undefined (not a string) for undefined/functions/
  // symbols at the top level; embed an explicit null rather than crashing.
  if (json === undefined) return 'null';
  return json.replace(/</g, '\\u003c');
}

export function decodeSeed<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}

/**
 * Dev-only guard: deep-walk a value about to be seeded into HTML and warn
 * about anything plain JSON silently corrupts — the bake would succeed but
 * islands/clients would hydrate with different data than the server used.
 * Never throws; callers gate it behind NODE_ENV !== 'production'.
 */
export function assertSeedSafe(value: unknown, context: string): void {
  walk(value, context, new Set());
}

function warn(path: string, problem: string): void {
  console.warn(`[kiln] seed value at "${path}" ${problem} — it will not survive JSON serialization. Return plain JSON data from load(), or move this value out of the seed.`);
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === undefined) {
    warn(path, 'is undefined (dropped from objects, null in arrays)');
    return;
  }
  if (typeof value === 'function') {
    warn(path, 'is a function (dropped)');
    return;
  }
  if (typeof value === 'bigint') {
    warn(path, 'is a bigint (JSON.stringify throws on bigint)');
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    warn(path, 'is NaN/Infinity (becomes null)');
    return;
  }
  if (value === null || typeof value !== 'object') return;

  if (seen.has(value)) return; // cycles make JSON.stringify throw, but that error is loud already
  seen.add(value);

  if (value instanceof Date) {
    warn(path, 'is a Date (becomes an ISO string; it will NOT revive as a Date on the client)');
    return;
  }
  if (value instanceof Map || value instanceof Set) {
    warn(path, `is a ${value instanceof Map ? 'Map' : 'Set'} (becomes {})`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    walk(item, `${path}.${key}`, seen);
  }
}
