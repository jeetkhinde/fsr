import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createAppUser } from '../lib/auth.js';
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
    await createAppUser({
      email: EMAIL, password: PASSWORD, name: 'Gate Test', role: 'member', handle: 'gatetest',
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
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in');
  });

  it('logs in via the form endpoint, loads home, logs out', async () => {
    const form = new URLSearchParams({ email: EMAIL, password: PASSWORD });
    const login = await fetch(BASE + '/auth/login', {
      method: 'POST',
      body: form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE, // Kiln CSRF middleware checks origin on form POSTs
      },
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/');
    const cookies = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookies).toContain('better-auth');

    const home = await fetch(BASE + '/', { headers: { cookie: cookies } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('@gatetest');

    const logout = await fetch(BASE + '/auth/logout', {
      method: 'POST',
      headers: { cookie: cookies, origin: BASE },
      redirect: 'manual',
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('location')).toBe('/login');
  });

  it('rejects a wrong password with a redirect back to /login', async () => {
    const form = new URLSearchParams({ email: EMAIL, password: 'wrong-password' });
    const res = await fetch(BASE + '/auth/login', {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login?error=1');
  });
});
