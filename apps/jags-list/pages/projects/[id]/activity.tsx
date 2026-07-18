import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireUser } from '../../../lib/session.js';
import { projectById } from '../../../db/projects.js';
import { sql } from '../../../db/client.js';


interface ActivityRow {
  id: number;
  actor_name: string | null;
  verb: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function load(req: KilnRequest) {
  requireUser(req);
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const rows = (await sql`
    SELECT a.id::int, u.name AS actor_name, a.verb, a.payload,
           to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
    FROM activity a
    LEFT JOIN "user" u ON u.id = a.actor_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100`) as Array<Omit<ActivityRow, 'payload'> & { payload: string }>;
  // bun returns jsonb as JSON text — parse each payload to an object.
  const events: ActivityRow[] = rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
  }));
  return { events };
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
