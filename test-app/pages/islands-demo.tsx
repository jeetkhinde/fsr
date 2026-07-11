import React from 'react';
import { Live, type KilnRequest } from '@kiln/core';
import { island } from '@kiln/react';
import Counter from '../islands/Counter.js';

const CounterIsland = island(Counter, 'Counter');

export async function load(_req: KilnRequest) {
  return {
    bakedAt: new Date().toISOString(),
    // Store-target live field: no s-live DOM slot is generated; updates
    // reach the Counter island through useLiveValue('activeUsers').
    activeUsers: Live.value<number>(0, ['kiln_fsr'], { target: 'store' }),
  };
}

export default function IslandsDemo({ bakedAt }: Awaited<ReturnType<typeof load>>) {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1>React islands demo (ADR-014)</h1>
      <p>
        Page baked at <code>{bakedAt}</code>. With JavaScript disabled this
        island still renders below — just without interactivity.
      </p>
      <CounterIsland start={3} label="I am a hydrated React island" />
      <p>Everything outside the island stays silcrow-owned baked HTML.</p>
    </main>
  );
}
