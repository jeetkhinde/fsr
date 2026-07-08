/**
 * Proof script: demonstrates that Kiln actually bakes HTML and JSON per
 * route, AND that it is layout-aware — a client navigating into a nested
 * ("grandchild") layout only receives the HTML it doesn't already have,
 * never the full page and never chrome (header/footer/sidebar/tab-bar)
 * that's already mounted and kept fresh via live patches.
 *
 * Runs entirely in-process against the real Kiln pipeline (startKiln +
 * ElysiaAdapter), with NO Postgres/Redis required — FSR falls back to local
 * hit-counting and disk-only caching when no store/watcher is provided,
 * which is enough to prove the baking + layout-fragment mechanism.
 *
 * Run with: bun run scripts/prove-baking.ts   (from the test-app directory)
 */
import { startKiln } from '@kiln/routekit';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import { defineConfig } from '@kiln/core';

const PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;

function section(title: string) {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function check(label: string, pass: boolean, detail?: string) {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
}

let failures = 0;

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, { headers });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

function bytes(s: string) {
  return new TextEncoder().encode(s).length;
}

async function main() {
  const config = defineConfig({
    port: PORT,
    pagesDir: './pages',
    fsr: {
      promoteAfterHits: 2,
      // No postgresUrl / redisUrl set -> startKiln runs FSR with no store or
      // watcher, i.e. local per-route hit counting + disk-only cache.
    },
  });

  const adapter = new ElysiaAdapter();
  // No options passed -> mirrors a real deployment with no DATABASE_URL/REDIS_URL
  // configured: FSR still runs, using local per-route hit counting and a
  // disk-only cache instead of the Postgres/Redis-backed store.
  await startKiln(adapter, config, './pages');
  await new Promise<void>((resolve) => {
    adapter.listen(PORT, (addr) => {
      console.log(`Kiln server booted at ${addr} (no Postgres/Redis — local hit-count + disk cache mode)`);
      resolve();
    });
  });

  // -------------------------------------------------------------------
  section('1. HTML baking: full page, then promoted/cached');
  // -------------------------------------------------------------------
  const first = await get('/dashboard/reports/summary');
  check('first request returns 200 HTML', first.status === 200 && first.body.includes('<html'));
  check('contains root layout chrome (header/footer)', first.body.includes('root layout chrome'));
  check('contains dashboard sidebar', first.body.includes('Dashboard') && first.body.includes('sidebar (child layout)'));
  check('contains reports tab bar', first.body.includes('tab bar (grandchild layout)'));
  check('contains page content', first.body.includes('Reports — Summary'));
  console.log(`  first response: ${bytes(first.body)} bytes`);

  const second = await get('/dashboard/reports/summary'); // 2nd hit -> promotes
  check('second request also 200', second.status === 200);
  const third = await get('/dashboard/reports/summary'); // served from the baked cache now
  check('third request served from baked HTML cache', third.status === 200 && third.body.includes('Reports — Summary'));
  console.log(`  third (cached) response: ${bytes(third.body)} bytes`);

  // -------------------------------------------------------------------
  section('2. JSON baking: same route, Accept: application/json');
  // -------------------------------------------------------------------
  const json = await get('/dashboard/reports/summary', { accept: 'application/json' });
  let parsed: any = null;
  try {
    parsed = JSON.parse(json.body);
  } catch {}
  check('response is valid JSON, not HTML', parsed !== null && !json.body.includes('<html'));
  check('JSON contains the baked page data', parsed?.total === 42);
  console.log(`  JSON response (${bytes(json.body)} bytes): ${json.body}`);

  // -------------------------------------------------------------------
  section('3. Layout-aware navigation: only send what the client is missing');
  // -------------------------------------------------------------------

  // 3a. Client has NOTHING mounted yet beyond a blank tab -> full reload signal.
  const none = await get('/dashboard/reports/summary', {
    'silcrow-target': 'content',
    'x-ps-present': '',
  });
  check(
    'no layouts present -> server asks for a full reload',
    none.headers.get('silcrow-full-reload') === 'true' && none.body.includes('<html'),
  );

  // 3b. Client just has the ROOT layout mounted (e.g. came from the home page)
  // -> dashboard layout + reports layout + page must ALL be sent (the client
  // doesn't have them yet), but the root header/footer must NOT be resent.
  const rootOnly = await get('/dashboard/reports/summary', {
    'silcrow-target': 'content',
    'x-ps-present': '/',
  });
  check('fragment response (x-ps-fragment=1)', (rootOnly.headers.get('content-type') || '').includes('x-ps-fragment=1'));
  check('slots into the root outlet', rootOnly.body.includes('data-ps-slot="/"'));
  check('includes the missing dashboard sidebar', rootOnly.body.includes('sidebar (child layout)'));
  check('includes the missing reports tab bar', rootOnly.body.includes('tab bar (grandchild layout)'));
  check('includes the page content', rootOnly.body.includes('Reports — Summary'));
  check('does NOT resend the root header/footer', !rootOnly.body.includes('root layout chrome'));
  console.log(`  root-only-present fragment: ${bytes(rootOnly.body)} bytes (vs ${bytes(first.body)} bytes for a full page)`);

  // 3c. Client has ROOT + DASHBOARD mounted (e.g. was on /dashboard/overview)
  // -> only the reports layout + page need to be sent; sidebar is skipped too.
  const rootAndDashboard = await get('/dashboard/reports/summary', {
    'silcrow-target': 'content',
    'x-ps-present': '/,/dashboard',
  });
  check('slots into the dashboard outlet', rootAndDashboard.body.includes('data-ps-slot="/dashboard"'));
  check('includes the missing reports tab bar', rootAndDashboard.body.includes('tab bar (grandchild layout)'));
  check('includes the page content', rootAndDashboard.body.includes('Reports — Summary'));
  check('does NOT resend the sidebar', !rootAndDashboard.body.includes('sidebar (child layout)'));
  check('does NOT resend the root header/footer', !rootAndDashboard.body.includes('root layout chrome'));
  console.log(`  root+dashboard-present fragment: ${bytes(rootAndDashboard.body)} bytes`);

  // 3d. Client has ROOT + DASHBOARD + REPORTS mounted already (e.g. switching
  // from the Summary tab to the Details tab) -> ONLY the page content itself
  // is sent. This is the htmx-style minimal swap.
  const allPresent = await get('/dashboard/reports/details', {
    'silcrow-target': 'content',
    'x-ps-present': '/,/dashboard,/dashboard/reports',
  });
  check('slots into the reports outlet', allPresent.body.includes('data-ps-slot="/dashboard/reports"'));
  check('includes ONLY the page content', allPresent.body.includes('Reports — Details'));
  check('does NOT resend the tab bar', !allPresent.body.includes('tab bar (grandchild layout)'));
  check('does NOT resend the sidebar', !allPresent.body.includes('sidebar (child layout)'));
  check('does NOT resend the root header/footer', !allPresent.body.includes('root layout chrome'));
  console.log(`  everything-present fragment (tab switch): ${bytes(allPresent.body)} bytes`);

  // -------------------------------------------------------------------
  section('Summary');
  // -------------------------------------------------------------------
  console.log(`  full page:                    ${bytes(first.body)} bytes`);
  console.log(`  root-only fragment:            ${bytes(rootOnly.body)} bytes`);
  console.log(`  root+dashboard fragment:       ${bytes(rootAndDashboard.body)} bytes`);
  console.log(`  everything-present fragment:   ${bytes(allPresent.body)} bytes  <- htmx-style minimal swap`);
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);

  await adapter.app.stop();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error in proof script:', err);
  process.exit(1);
});
