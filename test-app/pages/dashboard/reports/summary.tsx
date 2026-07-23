import React from 'react';

export const bake = 'shared';

export async function load() {
  return { bakedAt: new Date().toISOString(), total: 42 };
}

export default function ReportsSummary({ bakedAt, total }: Awaited<ReturnType<typeof load>>) {
  return (
    <div>
      <h2>Reports — Summary</h2>
      <p>total: {total}</p>
      <p>page content baked: {bakedAt}</p>
      <p>
        This is a grandchild of the root layout: root -&gt; dashboard (child) -&gt; reports
        (grandchild) -&gt; this page.
      </p>
    </div>
  );
}
