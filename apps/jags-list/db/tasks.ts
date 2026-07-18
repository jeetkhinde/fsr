import { sql } from './client.js';
import { positionAtEnd } from './positions.js';

export interface Task {
  id: number;
  project_id: number;
  column_id: number;
  title: string;
  description: string;
  assignee_id: string | null;
  priority: 0 | 1 | 2 | 3;
  due_date: string | null;
  position: number;
  version: number;
  created_by: string;
}

export async function listTasksByProject(projectId: number): Promise<Task[]> {
  return (await sql`
    SELECT id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
           to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by
    FROM tasks WHERE project_id = ${projectId}
    ORDER BY column_id ASC, position ASC`) as Task[];
}

export async function taskById(id: number): Promise<Task | null> {
  const [t] = await sql`
    SELECT id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
           to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by
    FROM tasks WHERE id = ${id}`;
  return (t as Task) ?? null;
}

export async function positionForEndOfColumn(columnId: number): Promise<number> {
  const rows = await sql`SELECT position FROM tasks WHERE column_id = ${columnId}`;
  return positionAtEnd(rows.map((r: any) => r.position as number));
}

export async function createTask(input: {
  projectId: number;
  columnId: number;
  title: string;
  createdBy: string;
}): Promise<Task> {
  const position = await positionForEndOfColumn(input.columnId);
  const [t] = await sql`
    INSERT INTO tasks (project_id, column_id, title, position, created_by)
    VALUES (${input.projectId}, ${input.columnId}, ${input.title}, ${position}, ${input.createdBy})
    RETURNING id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return t as Task;
}

export async function updateTaskFields(
  id: number,
  fields: {
    title?: string;
    description?: string;
    assigneeId?: string | null;
    priority?: 0 | 1 | 2 | 3;
    dueDate?: string | null;
  },
): Promise<Task> {
  // assignee/due are explicitly nullable, so `undefined` means "leave as-is"
  // (pass the current row through) while `null` means "clear it". title/
  // description/priority fall back to the current value when omitted.
  const current = await taskById(id);
  if (!current) throw new Error(`task ${id} not found`);
  const [t] = await sql`
    UPDATE tasks SET
      title = ${fields.title ?? current.title},
      description = ${fields.description ?? current.description},
      assignee_id = ${fields.assigneeId === undefined ? current.assignee_id : fields.assigneeId},
      priority = ${fields.priority ?? current.priority},
      due_date = ${fields.dueDate === undefined ? current.due_date : fields.dueDate},
      version = version + 1
    WHERE id = ${id}
    RETURNING id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return t as Task;
}

export async function moveTask(id: number, toColumnId: number, position: number): Promise<Task> {
  const [t] = await sql`
    UPDATE tasks SET column_id = ${toColumnId}, position = ${position}, version = version + 1
    WHERE id = ${id}
    RETURNING id::int, project_id::int, column_id::int, title, description, assignee_id, priority,
              to_char(due_date, 'YYYY-MM-DD') AS due_date, position, version, created_by`;
  return t as Task;
}
