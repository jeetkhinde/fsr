import React from 'react';

export const promote_after = 2; // Bake/cache after 2 hits

export async function load() {
  return {
    title: 'Baking Demo',
    timestamp: new Date().toISOString(),
    items: [
      { id: 1, name: 'Item 1' },
      { id: 2, name: 'Item 2' }
    ]
  };
}

export default function BakingDemoPage({ title, timestamp, items }: Awaited<ReturnType<typeof load>>) {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>{title}</h1>
      <p>Baked at: <strong>{timestamp}</strong></p>
      <ul>
        {items.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
      <p>
        To test HTML baking: <code>curl http://localhost:3000/baking-demo</code>
      </p>
      <p>
        To test JSON baking: <code>curl -H "Accept: application/json" http://localhost:3000/baking-demo</code>
      </p>
    </div>
  );
}
