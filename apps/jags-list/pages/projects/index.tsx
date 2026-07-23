import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireAdmin, requireUser } from '../../lib/session.js';
import { listActiveProjects, createProject, archiveProject, projectById } from '../../db/projects.js';
import { validProjectName } from '../../db/validation.js';
import { logActivity } from '../../lib/activity.js';


export async function load(req: KilnRequest) {
  const me = requireUser(req);
  const projects = await listActiveProjects();
  return { me, projects, error: req.query.error ?? null };
}

export const actions = {
  async create(req: KilnRequest) {
    const me = requireUser(req);
    const form = await req.formData();
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    if (!validProjectName(name)) throw AppError.redirect('/projects?error=name');
    const project = await createProject(name, description, me.id);
    await logActivity({ projectId: project.id, actorId: me.id, verb: 'project.created', payload: { name } });
    throw AppError.redirect(`/projects/${project.id}/board`);
  },

  async archive(req: KilnRequest) {
    const me = requireAdmin(req);
    const form = await req.formData();
    const id = Number(form.get('id'));
    const project = await projectById(id);
    if (!project) throw AppError.notFound('Project not found');
    await archiveProject(id);
    await logActivity({ projectId: id, actorId: me.id, verb: 'project.archived', payload: { name: project.name } });
    throw AppError.redirect('/projects');
  },
};

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  open_task_count: number;
}

export default function ProjectsPage({
  me,
  projects,
  error,
}: {
  me: { role: 'superadmin' | 'admin' | 'user' };
  projects: ProjectRow[];
  error: string | null;
}) {
  const isAdmin = me.role === 'admin' || me.role === 'superadmin';
  return (
    <section>
      <h1>Projects</h1>
      {error === 'name' && <p className="error">Enter a project name (1–120 characters).</p>}
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id} className="project-card">
            <a href={`/projects/${p.id}/board`}>
              <strong>{p.name}</strong>
            </a>
            <span className="muted">{`${p.open_task_count} open`}</span>
            {p.description && <p className="muted">{p.description}</p>}
            {isAdmin && (
              <form method="post" action="?/archive" className="inline-form">
                <input type="hidden" name="id" value={p.id} />
                <button type="submit" className="link-danger">Archive</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form method="post" action="?/create" className="create-form">
        <h2>New project</h2>
        <label>Name<input name="name" required maxLength={120} /></label>
        <label>Description<input name="description" maxLength={500} /></label>
        <button type="submit">Create project</button>
      </form>
    </section>
  );
}
