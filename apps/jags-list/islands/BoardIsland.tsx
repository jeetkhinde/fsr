import React, { useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useLiveValue } from '@kiln/react';

export interface BoardColumn {
  id: number;
  name: string;
  is_terminal: boolean;
}

export interface BoardTask {
  id: number;
  column_id: number;
  title: string;
  priority: number;
  version: number;
}

export interface BoardState {
  columns: BoardColumn[];
  tasks: BoardTask[];
}

function TaskCard({ task }: { task: BoardTask }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      className={`task-card prio-${task.priority}`}
      style={isDragging ? { opacity: 0.4 } : undefined}
      {...attributes}
      {...listeners}
    >
      {/* Plain link, not a drag handle: dnd-kit's PointerSensor has an
          activation distance, so a click still navigates. */}
      <a href={`/tasks/${task.id}`}>{task.title}</a>
    </div>
  );
}

function Column({ column, tasks }: { column: BoardColumn; tasks: BoardTask[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <div
      ref={setNodeRef}
      className="board-column"
      data-over={isOver ? '1' : undefined}
    >
      <h3>{column.name}</h3>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} />
      ))}
    </div>
  );
}

/**
 * The kanban board, hydrated.
 *
 * Live board state arrives through the Silcrow store (ADR-014): silcrow never
 * patches DOM inside `[data-kiln-island]`, so a store-target field read with
 * `useLiveValue` is the only channel in. `initialState` is the bake-time value
 * and doubles as the SSR/first-client-render fallback, so hydration matches.
 *
 * Moves are optimistic. Each card carries the `version` the client saw; the
 * action rejects a stale one with 409, at which point the overlay is dropped
 * and the next store patch supplies the truth.
 */
export default function BoardIsland({
  projectId,
  initialState,
}: {
  projectId: number;
  initialState: BoardState;
}) {
  const live = useLiveValue<BoardState>('boardState', initialState);
  // taskId -> columnId, held only until live state agrees.
  const [pending, setPending] = useState<Record<number, number>>({});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const columns = live?.columns ?? initialState.columns;
  const tasks = live?.tasks ?? initialState.tasks;
  const columnOf = (t: BoardTask) => pending[t.id] ?? t.column_id;

  function clearPending(taskId: number) {
    setPending((p) => {
      const next = { ...p };
      delete next[taskId];
      return next;
    });
  }

  async function onDragEnd(ev: DragEndEvent) {
    const taskId = Number(ev.active.id);
    if (ev.over === null) return;
    const toColumn = Number(ev.over.id);
    const task = tasks.find((t) => t.id === taskId);
    if (!task || columnOf(task) === toColumn) return;

    setPending((p) => ({ ...p, [taskId]: toColumn }));
    try {
      const res = await fetch(`/projects/${projectId}/board?/moveTask`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          task_id: String(taskId),
          column_id: String(toColumn),
          expected_version: String(task.version),
        }).toString(),
      });
      // 409 means someone moved it first — roll back and let the patch win.
      if (!res.ok) clearPending(taskId);
    } catch {
      clearPending(taskId);
    }
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="board">
        {columns.map((col) => (
          <Column
            key={col.id}
            column={col}
            tasks={tasks.filter((t) => columnOf(t) === col.id)}
          />
        ))}
      </div>
    </DndContext>
  );
}
