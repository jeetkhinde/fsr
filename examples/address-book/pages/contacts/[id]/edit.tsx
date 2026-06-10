import React from "react";
import { AppError, type KilnRequest } from "@kiln/core";
import { ContactForm } from "../../../components/ContactForm.js";
import { EmptyDetail } from "../../../components/EmptyDetail.js";
import { sql } from "../../../db/client.js";
import { getContact, updateContact } from "../../../db/contacts.js";
import { validateContactForm } from "../../../db/validation.js";

export async function load(req: KilnRequest) {
  return {
    contact: await getContact(sql, req.params.id),
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
  contact,
}: Awaited<ReturnType<typeof load>>) {
  return contact ? (
    <ContactForm
      action="?/update"
      submitLabel="Save changes"
      values={contact}
    />
  ) : (
    <EmptyDetail missing />
  );
}
