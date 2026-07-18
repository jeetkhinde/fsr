import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireAdmin, requireUser } from '../../../lib/session.js';
import { projectById } from '../../../db/projects.js';
import { listColumns, createColumn, renameColumn, deleteColumn, columnById } from '../../../db/columns.js';
import { listTasksByProject, createTask, moveTask, positionForEndOfColumn, taskById } from '../../../db/tasks.js';
import { validColumnName, validTaskTitle } from '../../../db/validation.js';
import { logActivity } from '../../../lib/activity.js';

export const promote_after = false;

export async function load(req: KilnRequest) {
  requireUser(req);
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const columns = await listColumns(projectId);
  const tasks = await listTasksByProject(projectId);
  return { projectId, columns, tasks, error: req.query.error ?? null };
}

async function requireProjectId(req: KilnRequest): Promise<number> {
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  return projectId;
}

export const actions = {
  async createTask(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const form = await req.formData();
    const columnId = Number(form.get('column_id'));
    const title = String(form.get('title') ?? '').trim();
    const column = await columnById(columnId);
    if (!column || column.project_id !== projectId) throw AppError.notFound('Column not found');
    if (!validTaskTitle(title)) throw AppError.redirect(`/projects/${projectId}/board?error=title`);
    const task = await createTask({ projectId, columnId, title, createdBy: me.id });
    await logActivity({ projectId, taskId: task.id, actorId: me.id, verb: 'task.created', payload: { title } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async moveTask(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const form = await req.formData();
    const taskId = Number(form.get('task_id'));
    const toColumnId = Number(form.get('column_id'));
    const task = await taskById(taskId);
    const target = await columnById(toColumnId);
    if (!task || task.project_id !== projectId) throw AppError.notFound('Task not found');
    if (!target || target.project_id !== projectId) throw AppError.notFound('Column not found');
    const position = await positionForEndOfColumn(toColumnId);
    await moveTask(taskId, toColumnId, position);
    await logActivity({ projectId, taskId, actorId: me.id, verb: 'task.moved', payload: { to: target.name } });
    if (target.is_terminal) {
      await logActivity({ projectId, taskId, actorId: me.id, verb: 'task.completed', payload: { title: task.title } });
    }
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async createColumn(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const name = String((await req.formData()).get('name') ?? '').trim();
    if (!validColumnName(name)) throw AppError.redirect(`/projects/${projectId}/board?error=column`);
    const column = await createColumn(projectId, name);
    await logActivity({ projectId, actorId: me.id, verb: 'column.created', payload: { name } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async renameColumn(req: KilnRequest) {
    const me = requireUser(req);
    const projectId = await requireProjectId(req);
    const form = await req.formData();
    const columnId = Number(form.get('column_id'));
    const name = String(form.get('name') ?? '').trim();
    const column = await columnById(columnId);
    if (!column || column.project_id !== projectId) throw AppError.notFound('Column not found');
    if (!validColumnName(name)) throw AppError.redirect(`/projects/${projectId}/board?error=column`);
    await renameColumn(columnId, name);
    await logActivity({ projectId, actorId: me.id, verb: 'column.renamed', payload: { name } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },

  async deleteColumn(req: KilnRequest) {
    const me = requireAdmin(req);
    const projectId = await requireProjectId(req);
    const columnId = Number((await req.formData()).get('column_id'));
    const column = await columnById(columnId);
    if (!column || column.project_id !== projectId) throw AppError.notFound('Column not found');
    await deleteColumn(columnId); // tasks reference columns ON DELETE RESTRICT — deleting a non-empty column errors; UI only offers it on empty ones
    await logActivity({ projectId, actorId: me.id, verb: 'column.deleted', payload: { name: column.name } });
    throw AppError.redirect(`/projects/${projectId}/board`);
  },
};

interface Col { id: number; name: string; is_terminal: boolean }
interface T { id: number; column_id: number; title: string; priority: number; assignee_id: string | null }

export default function BoardPage({
  columns,
  tasks,
  error,
}: {
  projectId: number;
  columns: Col[];
  tasks: T[];
  error: string | null;
}) {
  const byColumn = (cid: number) => tasks.filter((t) => t.column_id === cid);
  return (
    <>
      {error === 'title' && <p className="error">Enter a task title.</p>}
      {error === 'column' && <p className="error">Enter a column name (1–60 characters).</p>}
      <div className="board">
        {columns.map((col) => (
          <div key={col.id} className="board-column">
            <h3>{col.name}</h3>
            {byColumn(col.id).map((t) => (
              <div key={t.id} className={`task-card prio-${t.priority}`}>
                <a href={`/tasks/${t.id}`}>{t.title}</a>
                {/* JS-free move: pick a destination column and submit. */}
                <form method="post" action="?/moveTask" className="inline-form">
                  <input type="hidden" name="task_id" value={t.id} />
                  <select name="column_id" defaultValue={col.id} aria-label="Move to column">
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <button type="submit">Move</button>
                </form>
              </div>
            ))}
            <form method="post" action="?/createTask" className="inline-form">
              <input type="hidden" name="column_id" value={col.id} />
              <input name="title" placeholder="New task" required maxLength={200} />
              <button type="submit">Add</button>
            </form>
          </div>
        ))}
      </div>
      <form method="post" action="?/createColumn" className="create-form">
        <h2>Add column</h2>
        <label>Name<input name="name" required maxLength={60} /></label>
        <button type="submit">Add column</button>
      </form>
    </>
  );
}
