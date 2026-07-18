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

  it('board shows seeded columns; a member adds a task that lands in Backlog', async () => {
    const create = await post('/projects?/create', memberCookie, { name: 'Board Proj', description: '' });
    expect(create.status).toBe(303);
    const [proj] = await sql`SELECT id FROM projects WHERE name = 'Board Proj' ORDER BY id DESC LIMIT 1`;
    createdProjectIds.push(proj.id);

    const board = await (await fetch(`${BASE}/projects/${proj.id}/board`, { headers: { cookie: memberCookie } })).text();
    expect(board).toContain('Backlog');
    expect(board).toContain('In Progress');
    expect(board).toContain('Done');

    const [backlog] = await sql`SELECT id FROM columns WHERE project_id = ${proj.id} AND name = 'Backlog'`;
    const add = await post(`/projects/${proj.id}/board?/createTask`, memberCookie, {
      column_id: String(backlog.id), title: 'First task',
    });
    expect(add.status).toBe(303);
    const [task] = await sql`SELECT id, column_id FROM tasks WHERE title = 'First task'`;
    expect(task.column_id).toBe(backlog.id);
  });

  it('moving a task into the terminal column logs task.completed', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const [task] = await sql`SELECT id FROM tasks WHERE title = 'First task'`;
    const [done] = await sql`SELECT id FROM columns WHERE project_id = ${proj} AND name = 'Done'`;
    const res = await post(`/projects/${proj}/board?/moveTask`, memberCookie, {
      task_id: String(task.id), column_id: String(done.id),
    });
    expect(res.status).toBe(303);
    const [moved] = await sql`SELECT column_id FROM tasks WHERE id = ${task.id}`;
    expect(moved.column_id).toBe(done.id);
    const acts = await sql`SELECT verb FROM activity WHERE project_id = ${proj} AND verb = 'task.completed'`;
    expect(acts.length).toBeGreaterThanOrEqual(1);
  });

  it('only an admin can delete a column', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const [col] = await sql`
      INSERT INTO columns (project_id, name, position) VALUES (${proj}, 'Scratch', 9000) RETURNING id`;
    const denied = await post(`/projects/${proj}/board?/deleteColumn`, memberCookie, { column_id: String(col.id) });
    expect(denied.status).toBe(401);
    const ok = await post(`/projects/${proj}/board?/deleteColumn`, adminCookie, { column_id: String(col.id) });
    expect(ok.status).toBe(303);
    expect(await sql`SELECT id FROM columns WHERE id = ${col.id}`).toHaveLength(0);
  });

  it('editing a task assignee logs task.assigned and updates the row', async () => {
    const [task] = await sql`SELECT id FROM tasks WHERE title = 'First task'`;
    const [member] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    const res = await post(`/tasks/${task.id}?/update`, memberCookie, {
      title: 'First task', description: 'now with detail', assignee_id: member.id, priority: '3', due_date: '2026-10-01',
    });
    expect(res.status).toBe(303);
    const [row] = await sql`SELECT assignee_id, priority, description FROM tasks WHERE id = ${task.id}`;
    expect(row.assignee_id).toBe(member.id);
    expect(row.priority).toBe(3);
    expect(row.description).toBe('now with detail');
    const assigned = await sql`SELECT verb FROM activity WHERE task_id = ${task.id} AND verb = 'task.assigned'`;
    expect(assigned.length).toBeGreaterThanOrEqual(1);
  });

  it('the activity feed lists recent events newest-first', async () => {
    const proj = createdProjectIds[createdProjectIds.length - 1];
    const html = await (await fetch(`${BASE}/projects/${proj}/activity`, { headers: { cookie: memberCookie } })).text();
    expect(html).toContain('task.created');
    expect(html).toContain('task.completed');
  });
});
