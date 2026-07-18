import { sql } from '../db/client.js';

export type ActivityVerb =
  | 'project.created'
  | 'project.archived'
  | 'column.created'
  | 'column.renamed'
  | 'column.deleted'
  | 'task.created'
  | 'task.moved'
  | 'task.assigned'
  | 'task.completed'
  | 'task.updated';

/** Append a row to the activity feed. The AFTER INSERT trigger on `activity`
 * emits `activity:project_id=<pid>` (Plan 1 migration), so Plan 3's live feed
 * updates automatically — no extra work here. */
export async function logActivity(input: {
  projectId: number;
  taskId?: number | null;
  actorId: string;
  verb: ActivityVerb;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO activity (project_id, task_id, actor_id, verb, payload)
    VALUES (${input.projectId}, ${input.taskId ?? null}, ${input.actorId}, ${input.verb},
            ${JSON.stringify(input.payload ?? {})}::jsonb)`;
}
