import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { requireUser } from '../../lib/session.js';
import { taskById, updateTaskFields } from '../../db/tasks.js';
import { projectById } from '../../db/projects.js';
import { listMembers } from '../../db/members.js';
import { validTaskTitle, parsePriority, parseDueDate } from '../../db/validation.js';
import { logActivity } from '../../lib/activity.js';


export async function load(req: KilnRequest) {
  requireUser(req);
  const task = await taskById(Number(req.params.id));
  if (!task) throw AppError.notFound('Task not found');
  const project = await projectById(task.project_id);
  const members = await listMembers();
  return { task, projectName: project?.name ?? '', members, error: req.query.error ?? null };
}

export const actions = {
  async update(req: KilnRequest) {
    const me = requireUser(req);
    const task = await taskById(Number(req.params.id));
    if (!task) throw AppError.notFound('Task not found');
    const form = await req.formData();
    const title = String(form.get('title') ?? '').trim();
    if (!validTaskTitle(title)) throw AppError.redirect(`/tasks/${task.id}?error=title`);
    const description = String(form.get('description') ?? '').trim();
    const rawAssignee = String(form.get('assignee_id') ?? '');
    const assigneeId = rawAssignee === '' ? null : rawAssignee;
    const priority = parsePriority(form.get('priority'));
    const dueDate = parseDueDate(form.get('due_date'));

    await updateTaskFields(task.id, { title, description, assigneeId, priority, dueDate });
    const assigneeChanged = (task.assignee_id ?? '') !== (assigneeId ?? '');
    await logActivity({
      projectId: task.project_id,
      taskId: task.id,
      actorId: me.id,
      verb: assigneeChanged ? 'task.assigned' : 'task.updated',
      payload: assigneeChanged ? { assignee_id: assigneeId } : { title },
    });
    throw AppError.redirect(`/tasks/${task.id}`);
  },
};

interface Member { id: string; name: string; handle: string | null }
interface TaskT {
  id: number; project_id: number; title: string; description: string;
  assignee_id: string | null; priority: number; due_date: string | null;
}

export default function TaskDetail({
  task,
  projectName,
  members,
  error,
}: {
  task: TaskT;
  projectName: string;
  members: Member[];
  error: string | null;
}) {
  return (
    <section>
      <p className="muted">
        <a href={`/projects/${task.project_id}/board`}>{`← ${projectName}`}</a>
      </p>
      {error === 'title' && <p className="error">Enter a task title.</p>}
      <form method="post" action="?/update" className="task-form">
        <label>Title<input name="title" defaultValue={task.title} required maxLength={200} /></label>
        <label>Description<textarea name="description" defaultValue={task.description} rows={5} /></label>
        <label>
          Assignee
          <select name="assignee_id" defaultValue={task.assignee_id ?? ''}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select name="priority" defaultValue={String(task.priority)}>
            <option value="0">None</option>
            <option value="1">Low</option>
            <option value="2">Medium</option>
            <option value="3">High</option>
          </select>
        </label>
        <label>Due date<input type="date" name="due_date" defaultValue={task.due_date ?? ''} /></label>
        <button type="submit">Save</button>
      </form>
    </section>
  );
}
