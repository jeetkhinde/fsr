import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from './client.js';
import { createProject } from './projects.js';
import { listColumns } from './columns.js';
import { createTask, listTasksByProject, taskById, updateTaskFields, moveTask } from './tasks.js';

describe.skipIf(!process.env.DATABASE_URL)('tasks', () => {
  let projectId = 0;
  let cols: Awaited<ReturnType<typeof listColumns>> = [];
  beforeAll(async () => {
    const p = await createProject('tasks-itest', '', 'u1');
    projectId = p.id;
    cols = await listColumns(projectId);
  });
  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    // Deliberately no sql.close() here — see db/client.ts.
  });

  it('createTask appends to the end of its column and starts at version 1', async () => {
    const a = await createTask({ projectId, columnId: cols[0].id, title: 'A', createdBy: 'u1' });
    const b = await createTask({ projectId, columnId: cols[0].id, title: 'B', createdBy: 'u1' });
    expect(a.version).toBe(1);
    expect(b.position).toBeGreaterThan(a.position);
    const all = await listTasksByProject(projectId);
    expect(all.map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('updateTaskFields sets fields and bumps version', async () => {
    const [t] = await listTasksByProject(projectId);
    const updated = await updateTaskFields(t.id, { assigneeId: 'u2', priority: 3, dueDate: '2026-09-01' });
    expect(updated.assignee_id).toBe('u2');
    expect(updated.priority).toBe(3);
    expect(updated.due_date).toBe('2026-09-01');
    expect(updated.version).toBe(t.version + 1);
  });

  it('moveTask changes column + position and bumps version', async () => {
    const [t] = await listTasksByProject(projectId);
    const moved = await moveTask(t.id, cols[1].id, 5000);
    expect(moved).not.toBeNull();
    expect(moved!.column_id).toBe(cols[1].id);
    expect(moved!.position).toBe(5000);
    expect(moved!.version).toBe(t.version + 1);
    expect((await taskById(t.id))?.column_id).toBe(cols[1].id);
  });

  it('moveTask returns null — and writes nothing — on a stale expected version', async () => {
    const [t] = await listTasksByProject(projectId);
    const staleVersion = t.version - 1;
    const conflicted = await moveTask(t.id, cols[0].id, 7000, staleVersion);
    expect(conflicted).toBeNull();
    const unchanged = await taskById(t.id);
    expect(unchanged?.column_id).toBe(t.column_id);
    expect(unchanged?.version).toBe(t.version);
  });

  it('moveTask applies the move when the expected version is current', async () => {
    const [t] = await listTasksByProject(projectId);
    const moved = await moveTask(t.id, cols[0].id, 7000, t.version);
    expect(moved).not.toBeNull();
    expect(moved!.column_id).toBe(cols[0].id);
    expect(moved!.version).toBe(t.version + 1);
  });
});
