import { describe, it, expect } from 'bun:test';
import { assembleFragments, injectJsonSeed, injectKilnScript } from './assembler.js';
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
});
