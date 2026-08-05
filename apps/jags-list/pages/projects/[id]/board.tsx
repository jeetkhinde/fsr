import React from 'react';
import { AppError, Live, type KilnRequest } from '@kiln/core';
import { island } from '@kiln/react';
import { requireAdmin, requireUser } from '../../../lib/session.js';
import { projectById } from '../../../db/projects.js';
import { listColumns, createColumn, renameColumn, deleteColumn, columnById } from '../../../db/columns.js';
import { listTasksByProject, createTask, moveTask, positionForEndOfColumn, taskById } from '../../../db/tasks.js';
import { validColumnName, validTaskTitle } from '../../../db/validation.js';
import { logActivity } from '../../../lib/activity.js';
import BoardIsland, { type BoardColumn, type BoardTask } from '../../../islands/BoardIsland.js';

const Board = island(BoardIsland, 'BoardIsland');

export async function load(req: KilnRequest) {
  // No requireUser and no req.query read. hooks.ts `handle` gates this route,
  // the watcher re-runs loaders with empty locals, and either read marks the
  // render impure — which under ADR-016 'auto' latches the demotion for the
  // whole process. The validation banner is rendered client-side instead.
  const projectId = Number(req.params.id);
  const project = await projectById(projectId);
  if (!project || project.archived_at) throw AppError.notFound('Project not found');
  const columns = await listColumns(projectId);
  const tasks = await listTasksByProject(projectId);
  return {
    projectId,
    columns,
    tasks,
    // Whole-board live state for the island, as ONE object-valued field
    // rather than a Live.list: the board renders divs, and
    // applyLiveListMarkers only marks <li> inside <ul>/<ol> — and list
    // patches are dropped inside islands anyway. target:'store' is what
    // makes it reach the island; silcrow never patches island DOM.
    boardState: Live.value<{ columns: typeof columns; tasks: typeof tasks }>(
      { columns, tasks },
      ['tasks', 'columns'],
      { target: 'store' },
    ),
  };
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
    // The island states the version it rendered; the JS-free form cannot and
    // omits it, keeping last-write-wins for that path.
    const rawExpected = form.get('expected_version');
    const expectedVersion = rawExpected === null ? undefined : Number(rawExpected);
    const moved = await moveTask(taskId, toColumnId, position, expectedVersion);
    if (!moved) {
      // Someone moved it first. The island rolls back its optimistic overlay
      // off this status and waits for the next store patch; a JS-free post
      // never gets here, having sent no expected_version.
      throw AppError.conflict('Task was moved by someone else');
    }
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

// The island owns these shapes; the page renders the same rows into its
// JS-free fallback, so it reuses them rather than keeping a second copy.
type Col = BoardColumn;
type T = BoardTask & { assignee_id: string | null };

export default function BoardPage({
  projectId,
  columns,
  tasks,
}: {
  projectId: number;
  columns: Col[];
  tasks: T[];
}) {
  const byColumn = (cid: number) => tasks.filter((t) => t.column_id === cid);
  return (
    <>
      {/* Filled in by the script below from location.search. load() must not
          read req.query — one impure read and this route stops baking. */}
      <p className="error" data-form-error hidden />
      <script
        dangerouslySetInnerHTML={{
          __html:
            "(function(){var e=new URLSearchParams(location.search).get('error');" +
            "if(!e)return;var n=document.querySelector('[data-form-error]');if(!n)return;" +
            "n.textContent=e==='title'?'Enter a task title.':" +
            "e==='column'?'Enter a column name (1-60 characters).':'Could not save your changes.';" +
            "n.hidden=false;})();",
        }}
      />

      {/* The board itself: drag-and-drop when hydrated, and its SSR output is
          a perfectly readable board when not. */}
      <Board projectId={projectId} initialState={{ columns, tasks }} />

      {/* Moving a task WITHOUT JavaScript. Inside <noscript> because with JS
          the island already offers dragging, and rendering these unconditionally
          drew the whole board a second time. */}
      <noscript>
        <div className="board board-forms">
          {columns.map((col) => (
            <div key={col.id} className="board-column">
              <h4>{col.name}</h4>
              {byColumn(col.id).map((t) => (
                <form key={t.id} method="post" action="?/moveTask" className="inline-form">
                  <input type="hidden" name="task_id" value={t.id} />
                  <span className="task-move-title">{t.title}</span>
                  <select name="column_id" defaultValue={col.id} aria-label="Move to column">
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <button type="submit">Move</button>
                </form>
              ))}
            </div>
          ))}
        </div>
      </noscript>

      {/* Adding a task is needed in BOTH modes — the island only moves tasks —
          so this row stays outside <noscript>.

          `s-post` opts the form into silcrow, which submits it with the nav
          headers and swaps the returned fragment. WITHOUT it silcrow's onSubmit
          bails (its form handler is opt-in, keyed on these verb attributes) and
          the browser does a native POST → 303 → GET; that GET carries no
          `silcrow-target`, so the server correctly answers with a whole
          document and the page hard-reloads — while a nav link right beside it
          swaps a fragment. `method`/`action` stay for the no-JS path, which
          wants exactly that full-document reload. */}
      <div className="board board-add">
        {columns.map((col) => (
          <div key={col.id} className="board-column">
            <form method="post" action="?/createTask" s-post="?/createTask" className="inline-form">
              <input type="hidden" name="column_id" value={col.id} />
              <input name="title" placeholder={`New task in ${col.name}`} required maxLength={200} />
              <button type="submit">Add</button>
            </form>
          </div>
        ))}
      </div>
      <form method="post" action="?/createColumn" s-post="?/createColumn" className="create-form">
        <h2>Add column</h2>
        <label>Name<input name="name" required maxLength={60} /></label>
        <button type="submit">Add column</button>
      </form>
    </>
  );
}
