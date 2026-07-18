import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from './client.js';
import { createProject, listActiveProjects, projectById, archiveProject } from './projects.js';
import { listColumns } from './columns.js';

describe.skipIf(!process.env.DATABASE_URL)('projects + columns', () => {
  let projectId = 0;
  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql.close();
  });

  it('createProject seeds Backlog / In Progress / Done (Done terminal)', async () => {
    const p = await createProject('proj-itest', 'desc', 'u1');
    projectId = p.id;
    const cols = await listColumns(projectId);
    expect(cols.map((c) => c.name)).toEqual(['Backlog', 'In Progress', 'Done']);
    expect(cols[2].is_terminal).toBe(true);
    expect(cols[0].is_terminal).toBe(false);
    expect(cols[0].position).toBeLessThan(cols[1].position);
  });

  it('listActiveProjects returns open task counts and hides archived', async () => {
    const before = await listActiveProjects();
    expect(before.find((p) => p.id === projectId)?.open_task_count).toBe(0);
    await archiveProject(projectId);
    const after = await listActiveProjects();
    expect(after.find((p) => p.id === projectId)).toBeUndefined();
    expect((await projectById(projectId))?.archived_at).not.toBeNull();
  });
});
