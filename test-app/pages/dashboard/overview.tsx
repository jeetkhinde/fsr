import React from 'react';

export const promote_after = 2;

export async function load() {
  return { bakedAt: new Date().toISOString() };
}

export default function DashboardOverview({ bakedAt }: Awaited<ReturnType<typeof load>>) {
  return (
    <div>
      <h2>Overview</h2>
      <p>page content baked: {bakedAt}</p>
      <p>
        This page sits directly under the child layout (<code>/dashboard</code>), with no
        grandchild layout in between.
      </p>
    </div>
  );
}
