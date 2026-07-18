import { sql } from './client.js';
import { positionAtEnd } from './positions.js';

export interface Column {
  id: number;
  project_id: number;
  name: string;
  position: number;
  is_terminal: boolean;
}

export async function seedDefaultColumns(projectId: number): Promise<void> {
  await sql`
    INSERT INTO columns (project_id, name, position, is_terminal) VALUES
      (${projectId}, 'Backlog', 1024, false),
      (${projectId}, 'In Progress', 2048, false),
      (${projectId}, 'Done', 3072, true)`;
}

export async function listColumns(projectId: number): Promise<Column[]> {
  return (await sql`
    SELECT id, project_id, name, position, is_terminal
    FROM columns WHERE project_id = ${projectId} ORDER BY position ASC`) as Column[];
}

export async function columnById(id: number): Promise<Column | null> {
  const [c] = await sql`
    SELECT id, project_id, name, position, is_terminal FROM columns WHERE id = ${id}`;
  return (c as Column) ?? null;
}

export async function createColumn(projectId: number, name: string): Promise<Column> {
  const existing = await listColumns(projectId);
  const position = positionAtEnd(existing.map((c) => c.position));
  const [c] = await sql`
    INSERT INTO columns (project_id, name, position) VALUES (${projectId}, ${name}, ${position})
    RETURNING id, project_id, name, position, is_terminal`;
  return c as Column;
}

export async function renameColumn(id: number, name: string): Promise<void> {
  await sql`UPDATE columns SET name = ${name} WHERE id = ${id}`;
}

export async function deleteColumn(id: number): Promise<void> {
  await sql`DELETE FROM columns WHERE id = ${id}`;
}
