import React from "react";
import { AppError, type KilnRequest } from "@kiln/core";
import { ContactForm } from "../../components/ContactForm.js";
import { sql } from "../../db/client.js";
import { createContact } from "../../db/contacts.js";
import { validateContactForm } from "../../db/validation.js";

export const actions = {
  async create(req: KilnRequest) {
    const parsed = validateContactForm(await req.formData());
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: "Check the highlighted fields.",
        errors: parsed.errors,
        values: parsed.values,
      };
    }
    const contact = await createContact(sql, parsed.values);
    const redirect = `/contacts/${contact.id}`;
    if (!req.isEnhanced) throw AppError.redirect(redirect);
    return { ok: true as const, redirect, contact };
  },
};

export default function NewContactPage() {
  return (
    <ContactForm action="?/create" submitLabel="Create contact" />
  );
}
