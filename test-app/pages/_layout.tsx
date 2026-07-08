import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Kiln.js Application</title>
        <script src="/_silcrow/silcrow.js" defer></script>
      </head>
      <body>
        <div id="app" data-ps-layout="/">
          <header style={{ padding: '1rem', background: '#111', color: '#fff' }}>
            Kiln Demo — DEPLOY V3, LAYOUT-CACHE-INVALIDATED. This should only appear in the response on a
            full page load, never on a nested/"enhanced" navigation.
          </header>
          {children}
          <footer style={{ padding: '1rem', background: '#eee', color: '#555', fontSize: '0.8rem' }}>
            root layout footer — see <code>/dashboard/reports/summary</code> for the layout-aware
            baking proof.
          </footer>
        </div>
      </body>
    </html>
  );
}
