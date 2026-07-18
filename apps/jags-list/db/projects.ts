import { sql } from './client.js';
import { seedDefaultColumns } from './columns.js';

export interface Project {
  id: number;
  name: string;
  description: string;
  archived_at: Date | null;
  created_by: string;
}

export async function listActiveProjects(): Promise<Array<Project & { open_task_count: number }>> {
  // Open = task not in a terminal column. LEFT JOIN so empty projects show 0.
  return (await sql`
    SELECT p.id::int, p.name, p.description, p.archived_at, p.created_by,
           COUNT(t.id) FILTER (WHERE c.is_terminal = false)::int AS open_task_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    LEFT JOIN columns c ON c.id = t.column_id
    WHERE p.archived_at IS NULL
    GROUP BY p.id
    ORDER BY p.created_at DESC`) as Array<Project & { open_task_count: number }>;
}

export async function projectById(id: number): Promise<Project | null> {
  const [p] = await sql`
    SELECT id::int, name, description, archived_at, created_by FROM projects WHERE id = ${id}`;
  return (p as Project) ?? null;
}

export async function createProject(name: string, description: string, createdBy: string): Promise<Project> {
  const [p] = await sql`
    INSERT INTO projects (name, description, created_by) VALUES (${name}, ${description}, ${createdBy})
    RETURNING id::int, name, description, archived_at, created_by`;
  await seedDefaultColumns(p.id);
  return p as Project;
}

export async function archiveProject(id: number): Promise<void> {
  await sql`UPDATE projects SET archived_at = NOW() WHERE id = ${id}`;
}
