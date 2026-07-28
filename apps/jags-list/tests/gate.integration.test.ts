// Plan 3a Task 1: `requireUser` moved out of the activity feed's load() so
// the watcher can re-run it with empty locals (boot.ts makeLoaderRequest).
// The gate now lives ONLY in hooks.ts `handle`. This suite is the proof that
// removing it lost no protection.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { auth, createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

// 3296-3299 are claimed by the freshness/purity/crud/app suites.
const PORT = 3294;
const BASE = `http://localhost:${PORT}`;
const MEMBER = { email: 'gate-member@example.com', password: 'password-123', handle: 'gatemember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let projectId = 0;
let memberId = '';
let memberCookie = '';

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe.skipIf(!run)('auth gate holds without requireUser in load()', () => {
  beforeAll(async () => {
    // Seed this suite's own user — never depend on another suite's fixtures.
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await createAppUser({
      email: MEMBER.email,
      password: MEMBER.password,
      name: 'Gate Member',
      role: 'user',
      handle: MEMBER.handle,
    });
    const [u] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    memberId = u.id;

    // projects.created_by is TEXT NOT NULL — supply a real user id.
    const [p] = await sql`
      INSERT INTO projects (name, description, created_by)
      VALUES ('Gate Test Project', '', ${memberId}) RETURNING id::int`;
    projectId = p.id;

    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT) } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(100);
    }
    memberCookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await sql.close();
  });

  it('redirects an anonymous browser away from the activity feed', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/activity`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('401s an anonymous JSON client instead of redirecting', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/activity`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('still serves the feed to an authenticated member', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/activity`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
  });
});
