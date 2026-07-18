import type { SQL } from 'bun';
import React from 'react';
import { Live } from '@kiln/core';

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

export const bake = 'static';

export async function load() {
  return {
    todos: Live.list<Todo>({
      key: (todo) => todo.id,
      dependsOn: 'todo_events',
      query: async ({ sql }) => {
        const db = sql as SQL;
        return db<Todo[]>`
          SELECT id::text, title, completed
          FROM todos
          ORDER BY id ASC
        `;
      },
    }),
  };
}

export default function TodosPage({ todos }: Awaited<ReturnType<typeof load>>) {
  return (
    <main>
      <h1>Todos</h1>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span>{todo.title}</span>
            <span>{todo.completed ? 'complete' : 'open'}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
