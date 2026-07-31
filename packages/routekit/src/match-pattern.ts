// Concrete request path -> registered route pattern. Needed because
// bakeByPattern is keyed by pattern ('/projects/:id') while the live client
// subscribes with window.location.pathname ('/projects/42').
import { DEDUP_SET_MAX } from './dedup.js';

export interface PatternMatcher {
  /** The matching pattern, or null when none matches. */
  match(path: string): string | null;
}

function normalize(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  if (!withoutQuery) return '/';
  const trimmed =
    withoutQuery.length > 1 && withoutQuery.endsWith('/')
      ? withoutQuery.slice(0, -1)
      : withoutQuery;
  return trimmed || '/';
}

function segmentsOf(pattern: string): string[] {
  return normalize(pattern).split('/').filter(Boolean);
}

/** literal < :param < * — lower sorts (and matches) first. */
function rank(segment: string): number {
  if (segment === '*') return 2;
  if (segment.startsWith(':')) return 1;
  return 0;
}

function toRegex(segments: string[]): RegExp {
  const body = segments.map((segment) => {
    if (segment === '*') return '.*';
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^/${body.join('/')}$`);
}

export function createPatternMatcher(patterns: string[]): PatternMatcher {
  // Sorted most-specific first, so the first regex hit is the right answer —
  // this ordering IS the precedence rule, and it must agree with what the
  // adapter would serve or bake mode gets read from a different page.
  const compiled = patterns
    .map((pattern) => ({ pattern, segments: segmentsOf(pattern) }))
    .sort((a, b) => {
      const shared = Math.min(a.segments.length, b.segments.length);
      for (let i = 0; i < shared; i++) {
        const delta = rank(a.segments[i]!) - rank(b.segments[i]!);
        if (delta !== 0) return delta;
      }
      // A wildcard pattern is necessarily shorter; longer must win.
      if (a.segments.length !== b.segments.length) {
        return b.segments.length - a.segments.length;
      }
      // Deterministic across runs rather than dependent on discovery order.
      return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
    })
    .map(({ pattern, segments }) => ({ pattern, regex: toRegex(segments) }));

  // `route` arrives as a query parameter, so an unbounded memo would grow
  // without limit from arbitrary subscribe paths. dedup.ts's addBounded takes
  // a Set, so cap this Map directly against the same bound — the convention
  // its own comment records for `lastTouched`.
  const memo = new Map<string, string | null>();

  return {
    match(path: string): string | null {
      const key = normalize(path);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;

      let found: string | null = null;
      for (const candidate of compiled) {
        if (candidate.regex.test(key)) {
          found = candidate.pattern;
          break;
        }
      }

      if (memo.size >= DEDUP_SET_MAX) memo.clear();
      memo.set(key, found);
      return found;
    },
  };
}
