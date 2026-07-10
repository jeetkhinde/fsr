import assert from 'node:assert/strict';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log('  ✓', label);
  } catch (err: any) {
    console.error('  ✗', label);
    throw err;
  }
}

console.log('Running FSR live client tests...\n');

// ── Script content sanity checks ──────────────────────────────────────────────

run('script is a non-empty string', () => {
  assert.equal(typeof KILN_LIVE_CLIENT_SCRIPT, 'string');
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.length > 0);
});

run('script connects to /__kiln/fsr', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('/__kiln/fsr'));
});

run('script queries [s-live] elements', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('[s-live]'));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('s-live='));
});

run('script patches textContent', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('textContent'));
});

run('script listens for fsr event', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("'fsr'"));
});

run('script listens for fsr-resync event', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('fsr-resync'));
});

run('script applies scalar live patch envelopes', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data.kind==='scalar'"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data-kiln-live-field"));
});

run('script applies list field patch envelopes', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data.kind==='list'"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data-kiln-list"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data-kiln-key"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data-kiln-field"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data.op==='insert'"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data.op==='remove'"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data.op==='move'"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("data.op==='replace-row'"));
});

run('script subscribes to generated list names', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("[data-kiln-list]"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("getAttribute('data-kiln-list')"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("[data-kiln-live-lists]"));
});

run('script reloads once when an insert arrives without a marked list container', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("sessionStorage"));
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("location.reload()"));
});

run('script handles popstate navigation', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('popstate'));
});

run('script intercepts pushState', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('pushState'));
});

run('script intercepts replaceState', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('replaceState'));
});

run('script exposes __KilnFSR global', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('__KilnFSR'));
});

run('script uses DOMContentLoaded guard', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes('DOMContentLoaded'));
});

// ── ADR-014 I-3: island patch exclusion ──────────────────────────────────────

run('scalar patcher skips elements inside islands', () => {
  assert.ok(KILN_LIVE_CLIENT_SCRIPT.includes("closest('[data-kiln-island]')"));
  // The guard must run inside _patchScalar's element loop.
  const patchScalar = KILN_LIVE_CLIENT_SCRIPT.slice(
    KILN_LIVE_CLIENT_SCRIPT.indexOf('function _patchScalar'),
    KILN_LIVE_CLIENT_SCRIPT.indexOf('function _patchList'),
  );
  assert.ok(patchScalar.includes('_inIsland(el)'));
});

run('list patcher skips containers inside islands', () => {
  const patchList = KILN_LIVE_CLIENT_SCRIPT.slice(
    KILN_LIVE_CLIENT_SCRIPT.indexOf('function _patchList'),
    KILN_LIVE_CLIENT_SCRIPT.indexOf('function _patch('),
  );
  assert.ok(patchList.includes('_inIsland(list)'));
});

console.log('\n✓ All FSR live client tests passed.');
