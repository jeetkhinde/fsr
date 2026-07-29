// Process-lifetime dedup primitives, shared by the request path (page-render)
// and the HTML marker pass (html-markers). Extracted from boot.ts so both can
// use them without importing each other — `warnOnce` is called from
// buildPageHandler AND warnDomLiveInsideIslands, which live in different
// modules, so neither can own it.

// Caps process-lifetime dedup Sets (route-ensured markers, one-shot warning
// keys) so a long-running server with high route/key cardinality can't grow
// them without bound. Losing an entry just means the next occurrence does a
// redundant (idempotent) DB write or re-logs a warning — never incorrect.
// Exported because not every dedup structure is a Set: the request path's
// `lastTouched` is a Map and caps itself directly against this bound.
export const DEDUP_SET_MAX = 10_000;

export function addBounded(set: Set<string>, key: string): void {
  if (set.size >= DEDUP_SET_MAX) set.clear();
  set.add(key);
}

const warnedOnce = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  addBounded(warnedOnce, key);
  console.warn(message);
}
