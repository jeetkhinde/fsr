import type { KilnRequest } from '@kiln/core';

/** Request fields whose values vary by caller identity or per-request input
 * that is NOT part of the route path. A load() that reads any of them
 * produces a personalized render whose output must never be cached under a
 * route-only key. `params` is deliberately absent: params derive from the
 * concrete path, which IS the cache key — see LayoutScope for the one case
 * where that reasoning does not hold. */
const IDENTITY_FIELDS = new Set<PropertyKey>([
  'locals',
  'headers',
  'query',
  'raw',
  'formData',
  'json',
]);

/**
 * Layout mode (ADR-011). A layout is cached per route pattern PLUS the
 * concrete values of the dynamic segments **that pattern owns**, so:
 *
 * - reading its OWN params is fine — they are part of its cache key;
 * - reading a DESCENDANT page's param is not — `/contacts` serving
 *   `/contacts/7` has `params.id` populated, but `id` is absent from the
 *   layout's key, so one contact's chrome would be served for every contact;
 * - reading `req.path` is not, for the same reason.
 *
 * The base tracker cannot catch this: it deliberately treats `params` as pure
 * because "params derive from the concrete path, which IS the cache key",
 * which is true for a page and for a layout's own params, and false for a
 * descendant's. Pass this to close that gap.
 */
export interface LayoutScope {
  /** The layout's own pattern, e.g. '/projects/:id'. Used in the message. */
  layoutPattern: string;
  /** Param names that pattern owns — `layoutParamNames(pattern)`. */
  layoutParamNames: string[];
}

export interface PurityTracker {
  proxied: KilnRequest;
  identityAccessed(): boolean;
  /**
   * A human-readable ADR-011 scope violation, or null. Distinct from
   * identityAccessed(): reading `query` makes a layout impure but is not a
   * scoping mistake, so the two must not be conflated in the warning.
   */
  scopeViolation(): string | null;
}

export function createPurityTracker(req: KilnRequest, scope?: LayoutScope): PurityTracker {
  let touched = false;
  let violation: string | null = null;

  const owned = new Set(scope?.layoutParamNames ?? []);
  const flag = (what: string) => {
    touched = true;
    // Keep the FIRST violation: it is the one closest to the author's intent,
    // and a later incidental read shouldn't rewrite the diagnosis.
    if (violation === null) {
      violation = `layout "${scope!.layoutPattern}" read ${what}, which its own pattern does not own`;
    }
  };

  // Only built in layout mode; a page's params are legitimately part of its key.
  const proxiedParams = scope
    ? new Proxy(req.params ?? {}, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && !owned.has(prop)) flag(`params.${prop}`);
          return Reflect.get(target, prop, receiver);
        },
        // A spread / Object.keys reads every key at once, including any
        // descendant's. Treat it as reading each unowned key present.
        ownKeys(target) {
          const keys = Reflect.ownKeys(target);
          const stray = keys.filter((k) => typeof k === 'string' && !owned.has(k));
          if (stray.length > 0) flag(`params (${stray.join(', ')}) via enumeration`);
          return keys;
        },
      })
    : null;

  const proxied = new Proxy(req, {
    get(target, prop, receiver) {
      if (IDENTITY_FIELDS.has(prop)) touched = true;
      if (scope) {
        if (prop === 'path') flag('req.path');
        if (prop === 'params') return proxiedParams;
      }
      const value = Reflect.get(target, prop, receiver);
      // Headers.get / formData / json must stay bound to the real object.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    proxied,
    identityAccessed: () => touched,
    scopeViolation: () => violation,
  };
}
