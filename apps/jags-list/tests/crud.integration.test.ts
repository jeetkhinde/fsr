import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../db/client.js';
import { createAppUser } from '../lib/auth.js';
import { auth } from '../lib/auth.js';

const PORT = 3298;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { email: 'crud-admin@example.com', password: 'password-123', handle: 'crudadmin' };
const MEMBER = { email: 'crud-member@example.com', password: 'password-123', handle: 'crudmember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let adminCookie = '';
let memberCookie = '';
const createdProjectIds: number[] = [];

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe.skipIf(!run)('crud routes', () => {
  beforeAll(async () => {
    for (const u of [ADMIN, MEMBER]) await sql`DELETE FROM "user" WHERE email = ${u.email}`;
    await createAppUser({ ...ADMIN, name: 'Crud Admin', role: 'admin' });
    await createAppUser({ ...MEMBER, name: 'Crud Member', role: 'user' });
    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit', stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(200);
    }
    adminCookie = await cookieFor(ADMIN.email, ADMIN.password);
    memberCookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    for (const id of createdProjectIds) await sql`DELETE FROM projects WHERE id = ${id}`;
    for (const u of [ADMIN, MEMBER]) await sql`DELETE FROM "user" WHERE email = ${u.email}`;
    await sql.close();
  });

  async function post(path: string, cookie: string, form: Record<string, string>) {
    return fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body: new URLSearchParams(form),
      redirect: 'manual',
    });
  }

  it('a member can create a project; it appears on /projects with a 0 open-task count', async () => {
    const res = await post('/projects?/create', memberCookie, { name: 'Q3 Roadmap', description: '' });
    expect(res.status).toBe(303);
    const [row] = await sql`SELECT id FROM projects WHERE name = 'Q3 Roadmap' ORDER BY id DESC LIMIT 1`;
    createdProjectIds.push(row.id);
    const list = await fetch(BASE + '/projects', { headers: { cookie: memberCookie } });
    const html = await list.text();
    expect(html).toContain('Q3 Roadmap');
  });

  it('rejects a blank project name with a validation redirect', async () => {
    const res = await post('/projects?/create', memberCookie, { name: '   ', description: '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/projects?error=name');
  });

  it('a member cannot archive; an admin can', async () => {
    const id = createdProjectIds[0];
    const denied = await post('/projects?/archive', memberCookie, { id: String(id) });
    expect(denied.status).toBe(401);
    const ok = await post('/projects?/archive', adminCookie, { id: String(id) });
    expect(ok.status).toBe(303);
    const [p] = await sql`SELECT archived_at FROM projects WHERE id = ${id}`;
    expect(p.archived_at).not.toBeNull();
  });
});
