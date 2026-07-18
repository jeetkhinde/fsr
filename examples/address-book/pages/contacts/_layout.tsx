import React from "react";
import type { KilnRequest } from "@kiln/core";
import { AppShell } from "../../components/AppShell.js";
import { contactsLiveList } from "../../features/contacts/live.js";

export const revalidate = 300;
export const debounce = 5;
export const purge_after = 2_592_000;

export function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    query: req.query.q ?? "",
    selectedId: req.params.id,
    focusDetail: req.path !== "/contacts",
  };
}

export default function ContactsLayout({
  contacts,
  query,
  selectedId,
  focusDetail,
  children,
}: Awaited<ReturnType<typeof load>> & { children: React.ReactNode }) {
  return (
    <AppShell
      contacts={contacts}
      query={query}
      selectedId={selectedId}
      focusDetail={focusDetail}
    >
      {children}
    </AppShell>
  );
}
