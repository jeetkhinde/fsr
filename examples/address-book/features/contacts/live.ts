import type { SQL } from "bun";
import { Live } from "@kiln/core";
import { listContactSummaries } from "../../db/contacts.js";
import type { ContactSummary } from "../../db/types.js";

export function contactsLiveList() {
  return Live.list<ContactSummary>({
    key: (contact) => contact.id,
    dependsOn: "contact_events",
    query: async ({ sql }) => listContactSummaries(sql as SQL),
  });
}
