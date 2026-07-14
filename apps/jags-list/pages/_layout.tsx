import React from 'react';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Jag's List</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/_silcrow/silcrow.js" defer />
      </head>
      <body>
        <header className="topnav">
          <a href="/" className="brand">Jag's List</a>
          <nav>
            <a href="/projects">Projects</a>
            <a href="/team">Team</a>
          </nav>
          <form method="post" action="/auth/logout" className="logout-form">
            <button type="submit">Sign out</button>
          </form>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
