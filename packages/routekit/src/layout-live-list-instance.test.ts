/**
 * A `Live.list` in a dynamic-segment layout is addressed per concrete
 * instance, not per pattern.
 *
 * silcrow opens its SSE connection with the route stamped on the list
 * container, and the hub matches patches by exact route. Stamping (and
 * registering) `/projects/:id` put every project on one channel, so a row
 * inserted for project 7 patched project 9's page. Both sides now use the
 * instance path.
 */
import { describe, expect, it } from 'bun:test';
import { layoutInstancePath } from '@kiln/engine';
import { Live } from '@kiln/core';
import { applyLiveListMarkers } from './live-list-render.js';

describe('layoutInstancePath', () => {
  it('substitutes the params the layout owns', () => {
    expect(layoutInstancePath('/projects/:id', { id: '7' })).toBe('/projects/7');
    expect(layoutInstancePath('/o/:org/p/:id', { org: 'acme', id: '7' })).toBe('/o/acme/p/7');
  });

  it('returns a static pattern untouched', () => {
    expect(layoutInstancePath('/dashboard', { id: '7' })).toBe('/dashboard');
    expect(layoutInstancePath('/', undefined)).toBe('/');
  });

  it('substitutes a catch-all', () => {
    expect(layoutInstancePath('/docs/*', { '*': 'a/b' })).toBe('/docs/a/b');
  });

  it('leaves a segment alone when the request has no such param', () => {
    // Degrades to the old pattern-wide behaviour rather than inventing a
    // route that matches nothing.
    expect(layoutInstancePath('/projects/:id', {})).toBe('/projects/:id');
  });

  it('keeps two instances of one pattern on different routes', () => {
    expect(layoutInstancePath('/projects/:id', { id: '7' })).not.toBe(
      layoutInstancePath('/projects/:id', { id: '9' }),
    );
  });
});

describe('a layout list container carries the instance route', () => {
  it('stamps the concrete path so two projects do not share a channel', () => {
    const props = {
      cards: Live.list<{ id: number; title: string }>({
        key: (r) => r.id,
        initial: [{ id: 1, title: 'Alpha' }],
        query: () => [{ id: 1, title: 'Alpha' }],
      }),
    };

    const marked = applyLiveListMarkers(
      '<ul><li>Alpha</li></ul>',
      props,
      layoutInstancePath('/projects/:id', { id: '7' }),
    );

    expect(marked).toContain('data-kiln-live="/projects/7"');
    expect(marked).not.toContain('data-kiln-live="/projects/:id"');
  });
});
