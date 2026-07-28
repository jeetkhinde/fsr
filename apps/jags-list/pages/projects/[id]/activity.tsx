import React from 'react';
import { AppError, Live, type KilnRequest } from '@kiln/core';
import { projectById } from '../../../db/projects.js';
import { sql } from '../../../db/client.js';


interface ActivityRow {
  id: number;
  actor_name: string | null;
  verb: string;
  payload: Record<string, unknown>;
  created_at: string;
}

async function activityRows(projectId: number): Promise<ActivityRow[]> {
  const rows = (await sql`
    SELECT a.id::int, u.name AS actor_name, a.verb, a.payload,
           to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
    FROM activity a
    LEFT JOIN "user" u ON u.id = a.actor_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100`) as Array<Omit<ActivityRow, 'payload'> & { payload: string }>;
  // bun returns jsonb as JSON text — parse each payload to an object.
  return rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
  }));
}

export async function load(req: KilnRequest) {
  // No requireUser here: hooks.ts `handle` gates this route before load()
  // runs, and the watcher re-runs this loader with empty locals — reading
  // identity here would both throw on refresh and block baking (ADR-016).
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  return {
    // dependsOn is MANDATORY here: unlike LiveProp, Live.list does not union
    // auto-deps (boot.ts registerLiveLists passes meta.dependsOn straight
    // through). 'activity' is the table-level dep key kiln sync-triggers
    // emits for this table per kiln.config.ts fsr.triggerTables.
    events: Live.list<ActivityRow>({
      key: (row) => row.id,
      dependsOn: 'activity',
      initial: await activityRows(projectId),
      query: () => activityRows(projectId),
    }),
  };
}

export default function ActivityPage({ events }: { events: ActivityRow[] }) {
  return (
    <ul className="activity-feed">
      {events.map((e) => (
        <li key={e.id}>
          <span className="muted">{e.created_at}</span> · {e.actor_name ?? 'someone'} ·{' '}
          <strong>{e.verb}</strong>
          {typeof e.payload?.name === 'string' && ` — ${e.payload.name}`}
          {typeof e.payload?.title === 'string' && ` — ${e.payload.title}`}
        </li>
      ))}
    </ul>
  );
}
