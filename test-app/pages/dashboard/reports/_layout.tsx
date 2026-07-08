import React from 'react';

// This is the GRANDCHILD layout — it wraps /dashboard/reports/* routes with a
// tab bar. Three layouts now wrap the actual page: root -> dashboard -> reports.
export const promote_after = 2;

export async function load() {
  return { tabsBakedAt: new Date().toISOString() };
}

export default function ReportsLayout({
  tabsBakedAt,
  children,
}: Awaited<ReturnType<typeof load>> & { children: React.ReactNode }) {
  return (
    <div data-ps-layout="/dashboard/reports" style={{ border: '2px dashed #7c3aed', padding: '0.75rem' }}>
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          borderBottom: '1px solid #ddd',
          paddingBottom: '0.5rem',
          marginBottom: '0.5rem',
          alignItems: 'baseline',
        }}
      >
        <a href="/dashboard/reports/summary">Summary</a>
        <a href="/dashboard/reports/details">Details</a>
        <span style={{ fontSize: '0.7rem', color: '#888', marginLeft: 'auto' }}>
          tab bar (grandchild layout) baked: {tabsBakedAt}
        </span>
      </div>
      {children}
    </div>
  );
}
