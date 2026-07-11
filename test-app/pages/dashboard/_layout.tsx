import React from 'react';

// This is the CHILD layout — it wraps every /dashboard/* route with a sidebar.
// It is baked and cached independently of the root layout and of whatever
// grandchild layout/page sits below it.
export const promote_after = 2;

export async function load() {
  return { sidebarBakedAt: new Date().toISOString() };
}

export default function DashboardLayout({
  sidebarBakedAt,
  children,
}: Awaited<ReturnType<typeof load>> & { children: React.ReactNode }) {
  return (
    <div
      data-kiln-layout="/dashboard"
      style={{ display: 'flex', minHeight: '40vh', borderTop: '3px solid #0070f3' }}
    >
      <nav style={{ width: 200, padding: '1rem', background: '#f5f7fa', borderRight: '1px solid #ddd' }}>
        <p style={{ margin: 0, fontWeight: 'bold' }}>Dashboard</p>
        <p style={{ fontSize: '0.7rem', color: '#888' }}>sidebar (child layout) baked: {sidebarBakedAt}</p>
        <ul style={{ paddingLeft: '1.1rem' }}>
          <li>
            <a href="/dashboard/overview">Overview</a>
          </li>
          <li>
            <a href="/dashboard/reports/summary">Reports</a>
          </li>
        </ul>
      </nav>
      <div style={{ flex: 1, padding: '1rem' }}>{children}</div>
    </div>
  );
}
