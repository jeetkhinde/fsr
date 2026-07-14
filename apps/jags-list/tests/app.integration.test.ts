import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { auth } from '../lib/auth.js';
import { sql } from '../db/client.js';

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const EMAIL = 'gate-itest@example.com';
const PASSWORD = 'itest-password-1';
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;

describe.skipIf(!run)('app auth gate', () => {
  beforeAll(async () => {
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await auth.api.createUser({
      body: { email: EMAIL, password: PASSWORD, name: 'Gate Test', role: 'member', data: { handle: 'gatetest' } },
    });
    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try {
        const r = await fetch(`${BASE}/login`);
        if (r.status === 200 || r.status === 404) return;
      } catch {}
      await Bun.sleep(200);
    }
    throw new Error('app did not start on ' + BASE);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await sql.close();
  });

  it('redirects anonymous page requests to /login', async () => {
    const res = await fetch(BASE + '/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('returns 401 JSON for anonymous JSON requests', async () => {
    const res = await fetch(BASE + '/', {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('keeps the SSE endpoint gated', async () => {
    const res = await fetch(BASE + '/__kiln/fsr?route=/', { redirect: 'manual' });
    expect([302, 401]).toContain(res.status);
  });

  it('serves /login without a session', async () => {
    const res = await fetch(BASE + '/login');
    expect([200, 404]).toContain(res.status); // 404 until Task 5 adds the page; Task 5 tightens to 200 + content
  });
});
