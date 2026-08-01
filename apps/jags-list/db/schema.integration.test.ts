import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { sql } from './client.js';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('jags-list schema', () => {
  const listener = new pg.Client({ connectionString: url });
  const payloads: Array<{ depKey: string; op: string }> = [];
  let projectId = 0;

  beforeAll(async () => {
    await listener.connect();
    await listener.query('LISTEN kiln_invalidate');
    listener.on('notification', (msg) => {
      if (msg.payload) payloads.push(JSON.parse(msg.payload));
    });
  });

  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await listener.end();
    // Deliberately no sql.close() here — see db/client.ts.
  });

  // Task 9: the hand-written jags_notify_projects/columns/tasks/... triggers
  // (row-scoped keys like "projects:all" / "tasks:id=5") were replaced by
  // `kiln sync-triggers`-managed generic kiln_emit_event triggers, which emit
  // one table-level depKey per row event (e.g. "projects", "tasks") — see
  // migrations/0000_init.sql and kiln.config.ts's fsr.triggerTables. This
  // suite's DB must have run `db:migrate` + `db:sync-triggers` beforehand.
  it('creates a project/column/task and fires table-level dep-key notifications', async () => {
    const [project] = await sql`
      INSERT INTO projects (name, created_by) VALUES ('itest-project', 'itest-user') RETURNING id`;
    projectId = project.id;
    const [column] = await sql`
      INSERT INTO columns (project_id, name, position) VALUES (${projectId}, 'Backlog', 1) RETURNING id`;
    const [task] = await sql`
      INSERT INTO tasks (project_id, column_id, title, position, created_by)
      VALUES (${projectId}, ${column.id}, 'itest task', 1, 'itest-user') RETURNING id, created_at, updated_at`;

    await Bun.sleep(300); // let LISTEN deliver

    const keys = payloads.map((p) => `${p.depKey}|${p.op}`);
    expect(keys).toContain(`projects|INSERT`);
    expect(keys).toContain(`columns|INSERT`);
    expect(keys).toContain(`tasks|INSERT`);
  });

  it('bumps updated_at on update and fires the table-level key on delete', async () => {
    const [task] = await sql`SELECT id, updated_at FROM tasks WHERE project_id = ${projectId}`;
    await Bun.sleep(50);
    await sql`UPDATE tasks SET title = 'renamed' WHERE id = ${task.id}`;
    const [after] = await sql`SELECT updated_at FROM tasks WHERE id = ${task.id}`;
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(task.updated_at).getTime());

    payloads.length = 0;
    await sql`DELETE FROM tasks WHERE id = ${task.id}`;
    await Bun.sleep(300);
    const keys = payloads.map((p) => `${p.depKey}|${p.op}`);
    expect(keys).toContain(`tasks|DELETE`);
  });

  it('has the tasks search tsvector with GIN index', async () => {
    const [idx] = await sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'tasks_search_idx'`;
    expect(idx?.indexname).toBe('tasks_search_idx');
  });
});
