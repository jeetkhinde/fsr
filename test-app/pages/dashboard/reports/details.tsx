import React from 'react';

export const bake = 'shared';

export async function load() {
  return { bakedAt: new Date().toISOString() };
}

export default function ReportsDetails({ bakedAt }: Awaited<ReturnType<typeof load>>) {
  return (
    <div>
      <h2>Reports — Details</h2>
      <p>page content baked: {bakedAt}</p>
      <p>Switching between Summary and Details stays inside the same grandchild layout.</p>
    </div>
  );
}
