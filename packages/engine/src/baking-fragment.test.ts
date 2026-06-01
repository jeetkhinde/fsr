import { describe, it, expect } from 'bun:test';
import { bakeFragment, bakeLayoutFragment, OUTLET_TOKEN } from './baking.js';
import { createElement } from 'react';

function Page({ name }: { name: string }) {
  return createElement('div', null, `Hello ${name}`);
}

function Layout({ title, children }: { title: string; children?: any }) {
  return createElement('main', null,
    createElement('h1', null, title),
    children,
  );
}

describe('bakeFragment', () => {
  it('renders page component to HTML string', async () => {
    const html = await bakeFragment(Page, { name: 'World' });
    expect(html).toContain('Hello World');
    expect(html).toContain('<div>');
  });
});

describe('bakeLayoutFragment', () => {
  it('renders layout with outlet token as children', async () => {
    const html = await bakeLayoutFragment(Layout, { title: 'My App' });
    expect(html).toContain('My App');
    expect(html).toContain(OUTLET_TOKEN);
    expect(html).not.toContain('<div>Hello');
  });

  it('outlet token survives round-trip replacement', () => {
    const layoutHtml = `<main><h1>App</h1>${OUTLET_TOKEN}</main>`;
    const pageHtml = '<ul>list</ul>';
    const result = layoutHtml.replace(OUTLET_TOKEN, pageHtml);
    expect(result).toBe('<main><h1>App</h1><ul>list</ul></main>');
  });
});
