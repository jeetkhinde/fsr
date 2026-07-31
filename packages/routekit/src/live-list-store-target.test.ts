/**
 * `Live.list({ target: 'store' })` — the opt-in that lets a list inside a
 * React island receive updates.
 *
 * Before this, `_patchList` early-returned for any list inside
 * `[data-kiln-island]` and never published to the store, so an island list
 * got nothing and there was no option to ask for anything different.
 */
import { describe, expect, it } from 'bun:test';
import { Live } from '@kiln/core';
import { applyLiveListMarkers } from './live-list-render.js';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';

type Card = { id: number; title: string };
const ROWS: Card[] = [
  { id: 1, title: 'Alpha' },
  { id: 2, title: 'Beta' },
];

function listOf(target?: 'dom' | 'store' | 'dom-and-store') {
  return {
    cards: Live.list<Card>({
      key: (r) => r.id,
      initial: ROWS,
      target,
      query: () => ROWS,
    }),
  };
}

const HTML = '<body><ul><li>Alpha</li><li>Beta</li></ul></body>';

describe('Live.list delivery target', () => {
  it("defaults to 'dom' and marks rows as before", () => {
    const out = applyLiveListMarkers(HTML, listOf(), '/board');
    expect(out).toContain('data-kiln-list="cards"');
    expect(out).toContain('data-kiln-key="1"');
    expect(out).not.toContain('data-kiln-list-store');
  });

  it("leaves a target:'store' list unmarked — the island owns those rows", () => {
    const out = applyLiveListMarkers(HTML, listOf('store'), '/board');
    expect(out).not.toContain('data-kiln-list="cards"');
    expect(out).not.toContain('data-kiln-key=');
  });

  it("subscribes a target:'store' list even with no container to find it by", () => {
    const out = applyLiveListMarkers(HTML, listOf('store'), '/board');
    // Without both of these the client would never open an SSE subscription
    // for the list, nor know to route its patches to the store.
    expect(out).toContain('data-kiln-live-lists="cards"');
    expect(out).toContain('data-kiln-list-store="cards"');
    expect(out).toContain('data-kiln-live="/board"');
  });

  it("marks a 'dom-and-store' list AND routes it to the store", () => {
    const out = applyLiveListMarkers(HTML, listOf('dom-and-store'), '/board');
    expect(out).toContain('data-kiln-list="cards"');
    expect(out).toContain('data-kiln-key="1"');
    expect(out).toContain('data-kiln-list-store="cards"');
    // Already discoverable via [data-kiln-list]; no need to list it twice.
    expect(out).not.toContain('data-kiln-live-lists="cards"');
  });

  it('keeps an empty dom list subscribing the way it always did', () => {
    const empty = {
      cards: Live.list<Card>({ key: (r) => r.id, initial: [], query: () => [] }),
    };
    const out = applyLiveListMarkers(HTML, empty, '/board');
    expect(out).toContain('data-kiln-live-lists="cards"');
    expect(out).not.toContain('data-kiln-list-store');
  });
});

describe('live client script — store list delivery', () => {
  it('reads the store-list declaration', () => {
    expect(KILN_LIVE_CLIENT_SCRIPT).toContain('data-kiln-list-store');
  });

  it('publishes list patches to the live-list atom scope', () => {
    expect(KILN_LIVE_CLIENT_SCRIPT).toContain("'live-list:'+name");
    expect(KILN_LIVE_CLIENT_SCRIPT).toContain('_publishListPatch');
  });

  it('publishes before any DOM early-return, so an island list still gets patches', () => {
    const body = KILN_LIVE_CLIENT_SCRIPT.slice(
      KILN_LIVE_CLIENT_SCRIPT.indexOf('function _patchList'),
    );
    const publishAt = body.indexOf('_publishListPatch');
    const islandReturnAt = body.indexOf('_inIsland(list))return');
    expect(publishAt).toBeGreaterThan(-1);
    expect(islandReturnAt).toBeGreaterThan(publishAt);
  });

  it('does not force-reload the page for a store list with no container', () => {
    expect(KILN_LIVE_CLIENT_SCRIPT).toContain("data.op==='insert'&&!_storeLists[data.list]");
  });

  it('exposes the replay log an island reads on hydration', () => {
    expect(KILN_LIVE_CLIENT_SCRIPT).toContain('listLog:');
    expect(KILN_LIVE_CLIENT_SCRIPT).toContain('LIST_LOG_MAX');
  });
});
