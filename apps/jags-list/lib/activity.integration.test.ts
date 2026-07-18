import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from '../db/client.js';
import { logActivity } from './activity.js';

describe.skipIf(!process.env.DATABASE_URL)('logActivity', () => {
  let projectId = 0;
  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql.close();
  });

  it('inserts an activity row with verb + jsonb payload', async () => {
    const [p] = await sql`INSERT INTO projects (name, created_by) VALUES ('act-itest', 'u1') RETURNING id`;
    projectId = p.id;
    await logActivity({ projectId, actorId: 'u1', verb: 'project.created', payload: { name: 'act-itest' } });
    const rows = await sql`SELECT verb, actor_id, payload FROM activity WHERE project_id = ${projectId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].verb).toBe('project.created');
    expect(rows[0].actor_id).toBe('u1');
    // bun's SQL returns jsonb columns as JSON *text*, not parsed objects
    // (unlike node-postgres) — readers must JSON.parse. The ::jsonb cast on
    // insert is still what makes this a real jsonb column.
    expect(JSON.parse(rows[0].payload as string)).toEqual({ name: 'act-itest' });
  });
});
