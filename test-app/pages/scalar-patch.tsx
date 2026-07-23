import type { SQL } from 'bun';
import React from 'react';
import { Live } from '@kiln/core';

export const bake = 'static';
export const patch_mode = 'both';

export async function load() {
  return {
    todoCount: Live.value<number>(Date.now(), ['kiln_fsr'], {
      patchDebounce: 5,
    }),
  };
}

export default function ScalarPatchPage({ todoCount }: Awaited<ReturnType<typeof load>>) {
  return (
    <main>
      <h1>Todo Count</h1>
      <p>There are {todoCount as unknown as number} todos.</p>
    </main>
  );
}
