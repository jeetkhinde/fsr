import React from "react";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#18232d" />
        <title>Directory · Kiln Address Book</title>
        <link rel="stylesheet" href="/assets/address-book.css" />
        <script src="/_silcrow/silcrow.js" defer />
        <script src="/assets/address-book.js" defer />
      </head>
      <body>
        <div id="app">
          {children}
        </div>
      </body>
    </html>
  );
}
