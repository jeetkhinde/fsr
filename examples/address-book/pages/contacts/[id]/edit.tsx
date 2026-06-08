import React from "react";
import { AppError, type KilnRequest } from "@kiln/core";
import { AppShell } from "../../../components/AppShell.js";
import { ContactForm } from "../../../components/ContactForm.js";
import { EmptyDetail } from "../../../components/EmptyDetail.js";
import { sql } from "../../../db/client.js";
import { getContact, updateContact } from "../../../db/contacts.js";
import { validateContactForm } from "../../../db/validation.js";
import { contactsLiveList } from "../../../features/contacts/live.js";

export async function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    contact: await getContact(sql, req.params.id),
    selectedId: req.params.id,
    query: req.query.q ?? "",
  };
}

export const actions = {
  async update(req: KilnRequest) {
    const parsed = validateContactForm(await req.formData());
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: "Check the highlighted fields.",
        errors: parsed.errors,
        values: parsed.values,
      };
    }
    const contact = await updateContact(sql, req.params.id, parsed.values);
    if (!contact) {
      return { ok: false as const, message: "Contact not found." };
    }
    const redirect = `/contacts/${contact.id}`;
    if (!req.isEnhanced) throw AppError.redirect(redirect);
    return { ok: true as const, redirect, contact };
  },
};

export default function EditContactPage({
  contacts,
  contact,
  selectedId,
  query,
}: Awaited<ReturnType<typeof load>>) {
  return (
    <AppShell
      contacts={contacts}
      selectedId={selectedId}
      query={query}
      focusDetail
    >
      {contact ? (
        <ContactForm
          action="?/update"
          submitLabel="Save changes"
          values={contact}
        />
      ) : (
        <EmptyDetail missing />
      )}
    </AppShell>
  );
}
