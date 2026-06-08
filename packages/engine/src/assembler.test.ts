import { describe, it, expect } from 'bun:test';
import { assembleFragments, injectJsonSeed, injectKilnScript, hoistHeadTags } from './assembler.js';
import { OUTLET_TOKEN } from './baking.js';

const rootLayout = `<html><body><nav>Nav</nav>${OUTLET_TOKEN}</body></html>`;
const appLayout = `<div class="app">${OUTLET_TOKEN}</div>`;
const pageHtml = `<ul><li>Contact 1</li></ul>`;

describe('assembleFragments', () => {
  it('assembles single layout + page', () => {
    const result = assembleFragments([rootLayout], pageHtml);
    expect(result).toBe('<html><body><nav>Nav</nav><ul><li>Contact 1</li></ul></body></html>');
  });

  it('assembles two layouts + page (outer→inner)', () => {
    const result = assembleFragments([rootLayout, appLayout], pageHtml);
    expect(result).toContain('<div class="app">');
    expect(result).toContain('<ul><li>Contact 1</li></ul>');
    expect(result).not.toContain(OUTLET_TOKEN);
  });

  it('returns page html with no layouts', () => {
    const result = assembleFragments([], pageHtml);
    expect(result).toBe(pageHtml);
  });
});

describe('injectJsonSeed', () => {
  it('injects window.__kiln_seed before </body>', () => {
    const html = '<html><body><p>hi</p></body></html>';
    const seed = { '/contacts': { contacts: [] } };
    const result = injectJsonSeed(html, seed);
    expect(result).toContain('window.__kiln_seed');
    expect(result).toContain('"/contacts"');
    expect(result.indexOf('</body>')).toBeGreaterThan(result.indexOf('__kiln_seed'));
  });
});

describe('injectKilnScript', () => {
  it('injects client script before </head>', () => {
    const html = '<html><head><title>T</title></head><body></body></html>';
    const result = injectKilnScript(html, '/_kiln/client.js');
    expect(result).toContain('<script src="/_kiln/client.js"');
    expect(result.indexOf('</head>')).toBeGreaterThan(result.indexOf('<script'));
  });

  it('does not inject a script that is already present', () => {
    const html = '<html><head><script src="/_silcrow/silcrow.js" defer></script></head><body></body></html>';
    const result = injectKilnScript(html, '/_silcrow/silcrow.js');
    expect(result).toBe(html);
  });
});

describe('hoistHeadTags', () => {
  it('moves title/meta/link from body into head', () => {
    const html =
      '<html><head><meta charset="utf-8"></head><body>' +
      '<title>Page</title><meta name="description" content="d"/>' +
      '<link rel="canonical" href="/p"/><div>content</div></body></html>';
    const result = hoistHeadTags(html);
    const headEnd = result.indexOf('</head>');
    // hoisted tags now sit before </head>
    expect(result.indexOf('<title>Page</title>')).toBeLessThan(headEnd);
    expect(result.indexOf('name="description"')).toBeLessThan(headEnd);
    expect(result.indexOf('rel="canonical"')).toBeLessThan(headEnd);
    // body no longer holds them
    const body = result.slice(headEnd);
    expect(body).not.toContain('<title>');
    expect(body).not.toContain('name="description"');
    // real content untouched
    expect(result).toContain('<div>content</div>');
  });

  it('preserves charset meta already in head and adds nothing extra', () => {
    const html = '<html><head><meta charset="utf-8"></head><body><p>x</p></body></html>';
    expect(hoistHeadTags(html)).toBe(html);
  });

  it('deduplicates identical hoisted tags', () => {
    const html =
      '<html><head></head><body>' + '<meta name="x" content="1"/><meta name="x" content="1"/><p>y</p></body></html>';
    const result = hoistHeadTags(html);
    const matches = result.match(/<meta name="x" content="1"\/>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('returns input unchanged when no </head> (bare fragment)', () => {
    const html = '<title>T</title><div>frag</div>';
    expect(hoistHeadTags(html)).toBe(html);
  });

  it('does not touch tags already inside head', () => {
    const html = '<html><head><title>Keep</title></head><body><p>z</p></body></html>';
    expect(hoistHeadTags(html)).toBe(html);
  });
});
