import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { projectById } from '../../../db/projects.js';

// Pure SSR chrome for a single project. Reads only its own :id param (ADR-011
// scoping rule); no per-user data here.
export const promote_after = false;

export async function load(req: KilnRequest) {
  const project = await projectById(Number(req.params.id));
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  return { project };
}

export default function ProjectLayout({
  project,
  children,
}: {
  project: { id: number; name: string };
  children: React.ReactNode;
}) {
  const base = `/projects/${project.id}`;
  return (
    <section>
      <h1>{project.name}</h1>
      <nav className="tabs">
        <a href={`${base}/board`}>Board</a>
        <a href={`${base}/activity`}>Activity</a>
      </nav>
      {children}
    </section>
  );
}
