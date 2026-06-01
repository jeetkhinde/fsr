import assert from 'node:assert/strict';
import { PILCROW_LIVE_CLIENT_SCRIPT } from './live-client-script.js';
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
  assert.equal(typeof PILCROW_LIVE_CLIENT_SCRIPT, 'string');
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.length > 0);
});

run('script connects to /__pilcrow/fsr', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('/__pilcrow/fsr'));
});

run('script queries [s-live] elements', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('[s-live]'));
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('s-live='));
});

run('script patches textContent', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('textContent'));
});

run('script listens for fsr event', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes("'fsr'"));
});

run('script listens for fsr-resync event', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('fsr-resync'));
});

run('script handles popstate navigation', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('popstate'));
});

run('script intercepts pushState', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('pushState'));
});

run('script intercepts replaceState', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('replaceState'));
});

run('script exposes __PilcrowFSR global', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('__PilcrowFSR'));
});

run('script uses DOMContentLoaded guard', () => {
  assert.ok(PILCROW_LIVE_CLIENT_SCRIPT.includes('DOMContentLoaded'));
});

// ── injectFsrScriptTag ────────────────────────────────────────────────────────

run('injects script before </head>', () => {
  const html = '<html><head><title>T</title></head><body>Hi</body></html>';
  const out = injectFsrScriptTag(html);
  const headEnd = out.indexOf('</head>');
  const scriptPos = out.indexOf('<script src="/_pilcrow/live.js"');
  assert.ok(scriptPos !== -1, 'script tag missing');
  assert.ok(scriptPos < headEnd, 'script tag must come before </head>');
});

run('appends script when no </head> present', () => {
  const html = '<div>No head here</div>';
  const out = injectFsrScriptTag(html);
  assert.ok(out.endsWith('<script src="/_pilcrow/live.js" defer></script>'));
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
