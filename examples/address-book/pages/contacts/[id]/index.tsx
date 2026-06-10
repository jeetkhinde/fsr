import React from "react";
import { AppError, type KilnRequest } from "@kiln/core";
import { ContactDetail } from "../../../components/ContactDetail.js";
import { EmptyDetail } from "../../../components/EmptyDetail.js";
import { sql } from "../../../db/client.js";
import {
  deleteContact,
  getContact,
  toggleFavorite,
} from "../../../db/contacts.js";

export async function load(req: KilnRequest) {
  return {
    contact: await getContact(sql, req.params.id),
  };
}

export const actions = {
  async favorite(req: KilnRequest) {
    const form = await req.formData();
    const favorite = form.get("favorite") === "true";
    const contact = await toggleFavorite(sql, req.params.id, favorite);
    if (!contact) {
      return { ok: false as const, message: "Contact not found." };
    }
    return { ok: true as const, contact };
  },

  async delete(req: KilnRequest) {
    const deleted = await deleteContact(sql, req.params.id);
    if (!deleted) {
      return { ok: false as const, message: "Contact not found." };
    }
    if (!req.isEnhanced) throw AppError.redirect("/contacts");
    return { ok: true as const, redirect: "/contacts" };
  },
};

export default function ContactPage({
  contact,
}: Awaited<ReturnType<typeof load>>) {
  return contact ? <ContactDetail contact={contact} /> : <EmptyDetail missing />;
}
