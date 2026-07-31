import { describe, expect, it } from 'bun:test';
import { findEnclosingOpenTag } from './live-list-render.js';

function openTagOf(html: string, needle: string): string {
  const found = findEnclosingOpenTag(html, html.indexOf(needle));
  if (!found) return '';
  return html.slice(found.start, found.openEnd);
}

describe('findEnclosingOpenTag', () => {
  it('finds the immediate parent', () => {
    expect(openTagOf('<div class="board"><article>row</article></div>', '<article>')).toBe(
      '<div class="board">',
    );
  });

  it('finds the innermost enclosing element, not an outer one', () => {
    const html = '<section><div class="col"><article>row</article></div></section>';
    expect(openTagOf(html, '<article>')).toBe('<div class="col">');
  });

  it('skips a sibling that has already closed', () => {
    const html = '<div class="board"><div class="head">x</div><article>row</article></div>';
    expect(openTagOf(html, '<article>')).toBe('<div class="board">');
  });

  it('ignores void elements', () => {
    const html = '<div class="board"><br><img src="a.png"><article>row</article></div>';
    expect(openTagOf(html, '<article>')).toBe('<div class="board">');
  });

  it('ignores self-closing tags', () => {
    const html = '<div class="board"><input value="x" /><article>row</article></div>';
    expect(openTagOf(html, '<article>')).toBe('<div class="board">');
  });

  it('works for a table body', () => {
    // Index is the row element's START, which is what markList passes.
    const html = '<table><tbody><tr data-kiln-row="1"><td>a</td></tr></tbody></table>';
    expect(openTagOf(html, '<tr ')).toBe('<tbody>');
  });

  it('treats an index inside an open tag as enclosed by that element', () => {
    // Not the call-site usage (markList passes an element start), but pinning
    // it so the boundary is defined rather than accidental.
    const html = '<div class="board"><article id="a">row</article></div>';
    expect(openTagOf(html, 'id="a"')).toBe('<article id="a">');
  });

  it('returns null when nothing encloses the index', () => {
    expect(findEnclosingOpenTag('<div>a</div>', 0)).toBeNull();
  });
});
