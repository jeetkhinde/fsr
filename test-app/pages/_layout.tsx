import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Pilcrow.js Application</title>
        <script src="/_silcrow/silcrow.js" defer></script>
      </head>
      <body>
        <div id="app" data-ps-layout="/">
          {children}
        </div>
      </body>
    </html>
  );
}
