import React from "react";
import type { KilnRequest } from "@kiln/core";
import { AppShell } from "../../components/AppShell.js";
import { EmptyDetail } from "../../components/EmptyDetail.js";
import { contactsLiveList } from "../../features/contacts/live.js";

export function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    query: req.query.q ?? "",
  };
}

export default function ContactsPage({
  contacts,
  query,
}: Awaited<ReturnType<typeof load>>) {
  return (
    <AppShell contacts={contacts} query={query}>
      <EmptyDetail />
    </AppShell>
  );
}
