import { describe, expect, it } from 'bun:test';
import { Live } from '@kiln/core';
import { applyLiveListMarkers, extractLiveListRowHtml } from './live-list-render.js';

function listOf(rows: { id: number; title: string }[]) {
  return {
    cards: Live.list<{ id: number; title: string }>({
      key: (r) => r.id,
      initial: rows,
      query: () => rows,
    }),
  };
}

const ROWS = [
  { id: 1, title: 'Alpha' },
  { id: 2, title: 'Beta' },
];

describe('applyLiveListMarkers with explicit data-kiln-row', () => {
  it('marks div rows and their enclosing container', () => {
    const html =
      '<div class="board">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '<article data-kiln-row="2"><h3>Beta</h3></article>' +
      '</div>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(out).toContain('data-kiln-list="cards"');
    expect(out).toContain('data-kiln-key="1"');
    expect(out).toContain('data-kiln-key="2"');
    // The container is the div, not one of the articles.
    expect(/<div class="board"[^>]*data-kiln-list="cards"/.test(out)).toBe(true);
  });

  it('makes rows extractable by the render callback', () => {
    const html =
      '<div class="board">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '<article data-kiln-row="2"><h3>Beta</h3></article>' +
      '</div>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');
    const extracted = extractLiveListRowHtml(out, 'cards');

    expect([...extracted.keys()].sort()).toEqual(['1', '2']);
    expect(extracted.get('1')).toContain('Alpha');
  });

  it('marks table rows with tbody as the container', () => {
    const html =
      '<table><tbody>' +
      '<tr data-kiln-row="1"><td>Alpha</td></tr>' +
      '<tr data-kiln-row="2"><td>Beta</td></tr>' +
      '</tbody></table>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(/<tbody[^>]*data-kiln-list="cards"/.test(out)).toBe(true);
    expect(out).toContain('data-kiln-key="1"');
  });

  it('still marks a plain ul/li list with no explicit markers', () => {
    const html = '<ul><li>Alpha</li><li>Beta</li></ul>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(/<ul[^>]*data-kiln-list="cards"/.test(out)).toBe(true);
    expect(out).toContain('data-kiln-key="1"');
  });

  it('ignores a marker whose key matches no row, and warns', () => {
    const html =
      '<div class="board">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '<article data-kiln-row="99"><h3>Ghost</h3></article>' +
      '</div>';

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    let out = '';
    try {
      out = applyLiveListMarkers(html, listOf(ROWS), '/board');
    } finally {
      console.warn = original;
    }

    expect(out).toContain('data-kiln-key="1"');
    expect(out).not.toContain('data-kiln-key="99"');
    expect(warnings.some((w) => w.includes('data-kiln-row'))).toBe(true);
  });

  it('does not double-mark a container that is already marked', () => {
    const html =
      '<div class="board" data-kiln-list="cards">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '</div>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(out.match(/data-kiln-list="cards"/g)).toHaveLength(1);
  });
});
