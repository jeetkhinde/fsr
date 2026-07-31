import { describe, expect, it } from 'bun:test';
import { createPatternMatcher } from './match-pattern.js';

const PATTERNS = [
  '/',
  '/projects',
  '/projects/new',
  '/projects/:id',
  '/projects/:id/activity',
  '/docs/*',
];

describe('createPatternMatcher', () => {
  const m = createPatternMatcher(PATTERNS);

  it('matches a static path exactly', () => {
    expect(m.match('/projects')).toBe('/projects');
  });

  it('matches the root', () => {
    expect(m.match('/')).toBe('/');
  });

  it('matches a single dynamic segment', () => {
    expect(m.match('/projects/42')).toBe('/projects/:id');
  });

  it('matches a dynamic segment followed by a literal', () => {
    expect(m.match('/projects/42/activity')).toBe('/projects/:id/activity');
  });

  it('prefers a literal segment over a dynamic one', () => {
    // /projects/new must not resolve to /projects/:id, or bake mode is read
    // from the wrong page.
    expect(m.match('/projects/new')).toBe('/projects/new');
  });

  it('matches a wildcard across slashes', () => {
    expect(m.match('/docs/guides/live')).toBe('/docs/*');
  });

  it('prefers a more specific pattern over a wildcard', () => {
    const wide = createPatternMatcher(['/docs/*', '/docs/intro']);
    expect(wide.match('/docs/intro')).toBe('/docs/intro');
  });

  it('normalizes a trailing slash', () => {
    expect(m.match('/projects/')).toBe('/projects');
    expect(m.match('/projects/42/')).toBe('/projects/:id');
  });

  it('returns null when nothing matches', () => {
    expect(m.match('/nope/at/all')).toBeNull();
  });

  it('does not let a dynamic segment span slashes', () => {
    expect(m.match('/projects/42/extra')).toBeNull();
  });

  it('treats regex metacharacters in a literal segment literally', () => {
    const dotted = createPatternMatcher(['/a.b']);
    expect(dotted.match('/a.b')).toBe('/a.b');
    expect(dotted.match('/axb')).toBeNull();
  });

  it('returns the same answer on a repeat lookup (memo consistency)', () => {
    expect(m.match('/projects/7')).toBe('/projects/:id');
    expect(m.match('/projects/7')).toBe('/projects/:id');
    expect(m.match('/zzz')).toBeNull();
    expect(m.match('/zzz')).toBeNull();
  });

  it('keeps separate matchers independent', () => {
    const a = createPatternMatcher(['/x']);
    const b = createPatternMatcher(['/y']);
    expect(a.match('/x')).toBe('/x');
    expect(a.match('/y')).toBeNull();
    expect(b.match('/y')).toBe('/y');
  });
});
