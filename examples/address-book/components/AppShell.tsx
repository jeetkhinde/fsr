import React from "react";
import type { ContactSummary } from "../db/types.js";
import { Directory } from "./Directory.js";

export function AppShell({
  contacts,
  selectedId,
  query,
  focusDetail = false,
  children,
}: {
  contacts: ContactSummary[];
  selectedId?: string;
  query: string;
  focusDetail?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className={`app-shell${focusDetail ? " app-shell--detail" : ""}`}>
      <Directory contacts={contacts} selectedId={selectedId} query={query} />
      <section className="detail-pane" id="detail">
        {children}
      </section>
    </main>
  );
}
