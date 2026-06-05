import assert from 'node:assert/strict';
import { KILN_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
import { injectFsrScriptTag } from './boot.js';

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

// ── injectFsrScriptTag ────────────────────────────────────────────────────────

run('injects script before </head>', () => {
  const html = '<html><head><title>T</title></head><body>Hi</body></html>';
  const out = injectFsrScriptTag(html);
  const headEnd = out.indexOf('</head>');
  const scriptPos = out.indexOf('<script src="/_kiln/live.js"');
  assert.ok(scriptPos !== -1, 'script tag missing');
  assert.ok(scriptPos < headEnd, 'script tag must come before </head>');
});

run('appends script when no </head> present', () => {
  const html = '<div>No head here</div>';
  const out = injectFsrScriptTag(html);
  assert.ok(out.endsWith('<script src="/_kiln/live.js" defer></script>'));
  assert.ok(out.startsWith('<div>No head here</div>'));
});

run('preserves content before and after insertion point', () => {
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>body</body></html>';
  const out = injectFsrScriptTag(html);
  assert.ok(out.includes('<meta charset="utf-8">'));
  assert.ok(out.includes('</head>'));
  assert.ok(out.includes('<body>body</body>'));
});

run('script tag has defer attribute', () => {
  const out = injectFsrScriptTag('<html><head></head></html>');
  assert.ok(out.includes('defer'));
});

console.log('\n✓ All FSR live client tests passed.');
