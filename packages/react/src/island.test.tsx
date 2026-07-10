import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { island } from './island.js';
import { decodeSeed } from '@kiln/core';

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('island()', () => {
  it('wraps SSR output in a marker with name, strategy, and decodable props', () => {
    const GreetingIsland = island(Greeting, 'Greeting', { hydrate: 'visible' });
    const html = renderToStaticMarkup(<GreetingIsland name="Ada" />);

    expect(html).toContain('data-kiln-island="Greeting"');
    expect(html).toContain('data-kiln-hydrate="visible"');
    expect(html).toContain('display:contents');
    // The component's SSR output is the marker's children (the hydration
    // container contract).
    expect(html).toContain('<p>Hello Ada</p>');

    const match = html.match(/data-kiln-props="([^"]*)"/);
    expect(match).not.toBeNull();
    expect(decodeSeed(unescapeAttr(match![1]))).toEqual({ name: 'Ada' });
  });

  it('defaults the hydrate strategy to load', () => {
    const GreetingIsland = island(Greeting, 'Greeting');
    const html = renderToStaticMarkup(<GreetingIsland name="Ada" />);
    expect(html).toContain('data-kiln-hydrate="load"');
  });

  it('keeps script-breakout strings inert in the props payload', () => {
    const GreetingIsland = island(Greeting, 'Greeting');
    const hostile = 'x</script><script>alert(1)</script>';
    const html = renderToStaticMarkup(<GreetingIsland name={hostile} />);

    // Neither the attribute payload nor the SSR'd text may contain a raw
    // closing script tag (seed codec escapes '<'; React escapes text).
    expect(html).not.toContain('</script>');

    const match = html.match(/data-kiln-props="([^"]*)"/);
    expect(decodeSeed<{ name: string }>(unescapeAttr(match![1])).name).toBe(hostile);
  });
});
